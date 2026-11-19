// Package wipeguard 工作区破坏防护（docs/unfinished-plans/workspace-wipe-guard.md）。
//
// 三层职责：
//   - L1 写前快照：write_file / edit_file / 补丁应用在落盘前把原文件字节存进内容寻址库
//     （objects/<sha256 前 2 位>/<sha256>），追加式 index.jsonl 是唯一 manifest；
//   - L2 检测：结构指纹（fingerprint.go）兜底与校准；主信号是工作区 watcher 事件
//     （前端 ai-wipeguard.js 消费 workspace-changed 的滚动删除计数）。canary 诱饵已砍
//     （2026-11-19 作者裁定：工作区零足迹，见方案 §5.2）；
//   - L3 定期状态快照（snapshots.go）：git archive 自足包 / 无 git 小工作区的增量 CAS。
//
// 备份根默认 <应用数据>/wipe-guard（活过整仓删除），可被 Settings.BackupRoot 覆盖。
// 备份根会套 deny-delete ACL（acl_windows.go）：威胁模型是「同用户任意子进程」——
// 硬拒只约束读类工具，run_command 起的进程可以 rm -rf 任何目录，所以 unlink 必须失败。
// 备份是尽力而为：Backup 返回错误时调用方应当继续写入，不能挡正常保存。
package wipeguard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/executil"
)

// protectedMarker 备份根内的保护标记文件：存在说明 deny-delete ACL 已套过。
const protectedMarker = ".protected"

// Deps 引擎依赖：应用数据根与日志钩子（引擎不 import main）。
type Deps struct {
	Root func() string
	Logf func(level, format string, args ...any)
}

// Settings 用户开关（设置 → 存储与清理，§3.4）：全部默认开。
// 这是用户决策；阈值 / 保留期等工程参数是包内常量，不进设置。
type Settings struct {
	Enabled    bool   `json:"enabled"`
	Snapshots  bool   `json:"snapshots"`
	BackupRoot string `json:"backupRoot,omitempty"`
}

// DefaultSettings 返回全开的默认设置。前端是用户开关的真源（总是发显式值），
// 这里的默认只服务「Configure 尚未被调用」的窗口期（构造时已预设全开）。
func DefaultSettings() Settings { return Settings{Enabled: true, Snapshots: true} }

// Service 防护引擎。并发安全；根壳以包级变量持有（对齐 memo / storage 先例）。
type Service struct {
	mu           sync.Mutex
	deps         Deps
	settings     Settings
	configured   bool
	backupRoot   string // Configure 后的解析结果；空 = 未定
	protectedDir string // 已套 deny-delete ACL 的目录（与 backupRoot 同值或空）
	enforceRows  int    // 自上次 enforce 以来追加的索引行数
	modeCache    map[string]cachedMode
}

type cachedMode struct {
	info  ModeInfo
	until time.Time
}

// New 构造服务。deps 可以后补（SetDeps）——根壳在应用数据目录就绪后注入。
func New(deps Deps) *Service {
	return &Service{deps: deps, settings: DefaultSettings(), modeCache: map[string]cachedMode{}}
}

// SetDeps 注入依赖（幂等）。
func (s *Service) SetDeps(deps Deps) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deps = deps
}

// Configure 应用设置开关；备份根变化时重置保护状态（新根会在下次使用时重新套 ACL）。
func (s *Service) Configure(settings Settings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings = settings
	s.configured = true
	root := s.resolveRootLocked()
	if root != s.protectedDir {
		s.protectedDir = "" // 换了根（或从未保护过）：下次 ensureRoot 重新套 ACL
	}
	s.backupRoot = root
	s.logf("info", "wipe-guard 设置已应用：enabled=%v snapshots=%v root=%q",
		s.settings.Enabled, s.settings.Snapshots, root)
}

func (s *Service) current() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

func (s *Service) logf(level, format string, args ...any) {
	if s.deps.Logf != nil {
		s.deps.Logf(level, "wipe-guard: "+format, args...)
	}
}

// resolveRootLocked 计算备份根：自定义根优先（校验非空、绝对路径），否则 <应用数据>/wipe-guard。
func (s *Service) resolveRootLocked() string {
	if custom := strings.TrimSpace(s.settings.BackupRoot); custom != "" && filepath.IsAbs(custom) {
		return filepath.Clean(custom)
	}
	if s.deps.Root == nil {
		return ""
	}
	base := s.deps.Root()
	if base == "" {
		return ""
	}
	return filepath.Join(base, "wipe-guard")
}

// WorkspaceKey 归一化工作区 key 的短哈希（sha256 前 8 hex）。
// 归一化语义与前端 aiWorkspaceKey 一致：\ → /、去尾斜杠、lowercase；
// 与 session-workspace-buckets.md 的桶名同一约定同一算法。
func WorkspaceKey(ws string) string {
	key := strings.ToLower(strings.TrimRight(strings.ReplaceAll(ws, "\\", "/"), "/"))
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:8]
}

// ensureRoot 建目录并确保 deny-delete ACL 已套。靠 .protected 标记文件避免每次跑 icacls；
// ACL 是尽力而为（icacls 不可用只告警不挡备份）。
func (s *Service) ensureRoot() (string, error) {
	s.mu.Lock()
	root := s.backupRoot
	if root == "" {
		root = s.resolveRootLocked()
		s.backupRoot = root
	}
	protected := s.protectedDir == root
	s.mu.Unlock()
	if root == "" {
		return "", fmt.Errorf("应用数据目录不可用，备份根无法确定")
	}
	marker := filepath.Join(root, protectedMarker)
	if protected {
		if _, err := os.Stat(marker); err == nil {
			return root, nil
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "objects"), 0o755); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(root, "tmp"), 0o755); err != nil {
		return "", err
	}
	if err := protectRoot(root); err != nil {
		// 尽力而为：保护失败不挡备份，但要大声说出来（下一次 ensureRoot 会重试）。
		s.logf("warn", "备份根防删 ACL 套用失败（子进程可删除备份）：%v", err)
		return root, nil
	}
	if err := os.WriteFile(marker, []byte("deny-delete ACL applied\n"), 0o600); err != nil {
		s.logf("warn", "保护标记写入失败（下次会重套 ACL）：%v", err)
	} else {
		s.mu.Lock()
		s.protectedDir = root
		s.mu.Unlock()
	}
	return root, nil
}

// PrepareClear 存储清理 / 手动清空前的钩子：临时摘掉 deny-delete ACL。
// 返回的 release 在删除完成后把保护套回去（目录可能已被整个删掉，届时重新建时自然重套）。
func (s *Service) PrepareClear() (release func(), err error) {
	s.mu.Lock()
	root := s.backupRoot
	s.mu.Unlock()
	if root == "" {
		return func() {}, nil
	}
	if err := unprotectRoot(root); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.protectedDir = ""
	s.mu.Unlock()
	return func() {
		// 目录可能已被整个删掉（ClearAll）：不存在就不重套（下次 ensureRoot 建好再套）。
		if _, err := os.Stat(root); err != nil {
			return
		}
		if err := protectRoot(root); err != nil {
			s.logf("warn", "清理后重套 ACL 失败：%v", err)
		} else {
			s.mu.Lock()
			s.protectedDir = root
			s.mu.Unlock()
		}
	}, nil
}

// withinDir 判断 p 是否在 root 内（含相等）。用于恢复出口的路径穿越校验。
func withinDir(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	rel = filepath.Clean(rel)
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// ---- snapshots.go 用的小助手 ----

// execCommand 是 snapshots.go 起 git 进程的唯一入口。git.exe 是控制台程序，
// GUI 进程拉起它会闪黑窗（每轮 git 快照连闪 add / write-tree / archive 三个），
// 统一在这里隐藏窗口；非 Windows 是空实现，不影响交叉编译。
func execCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	executil.HideCommandWindow(cmd)
	return cmd
}

func lookGit() (string, error) {
	path, err := exec.LookPath("git")
	if err != nil {
		return "", fmt.Errorf("git 不可用（PATH 里找不到）：%w", err)
	}
	return path, nil
}

func sha256Of(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func jsonMarshalIndent(v any) ([]byte, error) { return json.MarshalIndent(v, "", "  ") }

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }
