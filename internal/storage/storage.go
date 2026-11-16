// Package storage：设置页「存储与清理」的引擎。
//
// 把应用自己产生的缓存与用户数据登记成一张表（specs.go），按表统计占用（scan.go）、
// 按表清除（clear.go）。仓库根只留壳 storage_app.go：缓存直删、数据送回收站、
// WebView2 那两项运行中被进程锁住所以记待清理标记、下次启动前执行。
//
// 引擎不自己拼应用数据目录下的路径：位置一律经 Deps.Location 向宿主索取，
// 否则「写入端改了目录、清理端还在原地删」这种错没人拦得住。
package storage

import (
	"path/filepath"
	"strings"
	"sync"
)

const (
	// KindCache：删了只是重新下载/重建；KindData：用户内容，删除走回收站；
	// KindDanger：删了丢会话记录/配置/登录态，前端要二次确认。
	KindCache  = "cache"
	KindData   = "data"
	KindDanger = "danger"

	// ScopeApp / ScopeWorkspace / ScopeTemp 决定条目归到哪一格；
	// ScopeWebview 表示运行中被 WebView2 进程锁住，只能记待清理标记。
	ScopeApp       = "app"
	ScopeWorkspace = "workspace"
	ScopeTemp      = "temp"
	ScopeWebview   = "webview"
)

// ScanMaxEntries 是整次扫描共享的条目预算：体积统计是「点开设置页就要给数」的同步调用，
// 应用数据目录塞几十万个文件时不能把 UI 拖死，超预算按「约」上报。
const ScanMaxEntries = 300000

// pendingFileName 待清理标记文件名。放在应用数据根目录且以点开头：既不会被「其他」
// 容量统计算进去，也不受「删除全部配置」影响（配置删了，排好的清理仍要执行）。
const pendingFileName = ".pending-clean"

// Location 名（Deps.Location 的入参）。宿主给不出的位置返回空串，条目按「不存在」处理。
const (
	LocAppRoot         = "app-root"
	LocScratchDir      = "scratch-dir"
	LocWebview         = "webview-user-data"
	LocBrowserProfiles = "browser-profiles"
	LocRunTemp         = "run-temp"
	LocAppLogs         = "app-logs"
	LocDebugConsole    = "debug-console"
	LocSessionIndex    = "session-index"
	LocScheduleDB      = "schedule-db"
	LocModelCatalog    = "model-catalog"
	LocActivity        = "activity"
	LocAISessions      = "ai-sessions"
	LocConfig          = "config"
	LocAIConfig        = "ai-config"
	LocMCPConfig       = "mcp-config"
	LocEnvVars         = "env-vars"
)

// Deps 由宿主注入。除 Location 外都可以为空，空值按「没有这个能力」处理。
type Deps struct {
	// Location 返回应用真正写数据的位置，见上面的 Loc* 常量。
	Location func(name string) string
	// RemoveToRecycleBin 是数据条目的删除动作；nil 时数据条目一律拒绝清除（宁可不动，
	// 也不能把「送回收站」悄悄降级成真删）。
	RemoveToRecycleBin func(path string) error
	// ActiveBrowserProfiles 返回仍在使用的浏览器配置目录名，清除与统计都跳过它们。
	ActiveBrowserProfiles func() map[string]bool
	// KeepWorktreeNames 返回「有会话登记」的 AI 隔离 worktree 绝对路径（.cadt/worktree/<slug>），
	// 孤儿判定用：登记之外的才算孤儿。nil 时隔离区条目一律不删（宁可不清，也不能把活跃
	// 会话的草稿当孤儿清掉）。
	KeepWorktreeNames func() []string
	// BeforeClear 按条目 id 在删除前释放本进程句柄（派生 SQLite 开着就删不掉）。
	BeforeClear map[string]func()
}

// Service 是一张条目表加上宿主能力。可以安全并发调用（清除期间串行）。
type Service struct {
	deps Deps
	mu   sync.Mutex
}

func New(deps Deps) *Service {
	return &Service{deps: deps}
}

// location 取宿主给的位置；未登记的名字或宿主返回空串都当「没有这个位置」。
func (s *Service) location(name string) string {
	if s.deps.Location == nil {
		return ""
	}
	return s.deps.Location(name)
}

func (s *Service) appRoot() string               { return s.location(LocAppRoot) }
func (s *Service) scratchDir() string            { return s.location(LocScratchDir) }
func (s *Service) webviewRoot() string           { return s.location(LocWebview) }
func (s *Service) pendingPath() string           { return s.appSubPath(pendingFileName) }
func (s *Service) appDirName(name string) string { return s.appSubPath(name) }

func (s *Service) appSubPath(name string) string {
	root := s.appRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, name)
}

// workspaceCadtRoot 工作区里本应用的数据目录根 <root>/.cadt；未打开工作区时返回空串。
func (s *Service) workspaceCadtRoot(workspaceRoot string) string {
	if workspaceRoot == "" {
		return ""
	}
	return filepath.Join(workspaceRoot, ".cadt")
}

// workspaceSubPath 工作区 .cadt 下的子项。
func (s *Service) workspaceSubPath(workspaceRoot, name string) string {
	root := s.workspaceCadtRoot(workspaceRoot)
	if root == "" {
		return ""
	}
	return filepath.Join(root, name)
}

func (s *Service) blockedBrowserProfiles() map[string]bool {
	if s.deps.ActiveBrowserProfiles == nil {
		return map[string]bool{}
	}
	return s.deps.ActiveBrowserProfiles()
}

// registeredWorktreeNames 有会话登记的隔离 worktree 目录名（小写集合）。路径取 basename
// 登记——children 过滤按目录名匹配。宿主未注入钩子时返回空集（配合 isOrphanWorktree
// 的 nil 检查实现 fail-safe：未注入 = 不清理）。
func (s *Service) registeredWorktreeNames() map[string]bool {
	out := map[string]bool{}
	if s.deps.KeepWorktreeNames == nil {
		return out
	}
	for _, path := range s.deps.KeepWorktreeNames() {
		if path == "" {
			continue
		}
		out[strings.ToLower(filepath.Base(filepath.Clean(path)))] = true
	}
	return out
}

// orphanWorktreeFilter 孤儿过滤器：宿主未注入会话登记钩子时一律不删（fail-safe——
// 宁可不清，也不能把活跃会话的隔离区当孤儿清掉）；注入后登记之外的才算孤儿。
// 登记集合在过滤器创建时取一次：一次扫描/清除期间的会话登记视为不变。
func (s *Service) orphanWorktreeFilter() func(string) bool {
	if s.deps.KeepWorktreeNames == nil {
		return func(string) bool { return false }
	}
	keep := s.registeredWorktreeNames()
	return func(name string) bool { return !keep[strings.ToLower(name)] }
}
