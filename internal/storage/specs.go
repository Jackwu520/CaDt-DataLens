// specs.go：条目表。新增可清除的东西只改这张表——设置页按它渲染，清除按它执行，
// 前端传来的 id 与工作区根目录拼不出表外的路径。
package storage

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	browserDirPrefix = "browser-"
	webviewSubDir    = "EBWebView"
	webviewProfile   = "Default"
	// 本应用写进系统临时目录的前缀。%TEMP% 里别人的同名前缀文件不归我们管。
	tempPrefixSQL    = "cadt-sql-"
	tempPrefixPlugin = "cadt-plugin-"
)

// cacheDirNames：WebView2 用户数据里的纯缓存目录名——删掉浏览器自己会长回来，
// 且不需要联网重新下载。Local Storage / Network / History 等含用户状态的一律不进这张表；
// component_crx_cache、Subresource Filter、WidevineCdm 是联网下载的组件，
// 删了下次启动要重下，也不算缓存。
var cacheDirNames = map[string]bool{
	"Cache":             true,
	"Code Cache":        true,
	"GPUCache":          true,
	"GrShaderCache":     true,
	"ShaderCache":       true,
	"GraphiteDawnCache": true,
	"DawnGraphiteCache": true,
	"DawnWebGPUCache":   true,
	"blob_storage":      true,
	"SharedStorage":     true,
}

func isCacheDirName(name string) bool { return cacheDirNames[name] }

func isTempScratchName(name string) bool {
	return strings.HasPrefix(name, tempPrefixSQL) || strings.HasPrefix(name, tempPrefixPlugin)
}

// target 一个条目对应的一组路径。children 为真时按「直接子项」逐个统计与删除，
// include 决定哪些子项属于本应用，blockActiveBrowser 跳过正在使用的浏览器配置目录。
type target struct {
	path               func(s *Service, workspaceRoot string) string
	children           bool
	sidecars           bool // SQLite 库：同名 -wal / -shm 一并统计与删除
	include            func(name string) bool
	blockActiveBrowser bool
}

type spec struct {
	id      string
	label   string
	note    string
	kind    string
	scope   string
	inCache bool // 「清除缓存」一键是否包含
	targets []target
}

// 目标构造助手：表里读起来就是「哪儿 / 怎么算子项」。

func locTarget(location string) target {
	return target{path: func(s *Service, _ string) string { return s.location(location) }}
}

func locChildrenTarget(location string, include func(string) bool) target {
	t := locTarget(location)
	t.children = true
	t.include = include
	return t
}

func dbTarget(location string) target {
	t := locTarget(location)
	t.sidecars = true
	return t
}

func appDirTarget(name string) target {
	return target{path: func(s *Service, _ string) string { return s.appDirName(name) }}
}

func appDirChildrenTarget(name string, include func(name string) bool) target {
	t := appDirTarget(name)
	t.children = true
	t.include = include
	return t
}

func workspaceTarget(sub string) target {
	return target{path: func(s *Service, ws string) string { return s.workspaceSubPath(ws, sub) }}
}

// webviewLevelTarget 扫 WebView2 用户数据里的一层缓存：
// i=0 是 <userData>/EBWebView（着色器缓存在这层），i=1 是其下 Default profile
// （网络与代码缓存在那层）。Chromium 分两层放，只扫一层会漏掉最大的 Code Cache。
func webviewLevelTarget(i int) target {
	t := target{path: func(s *Service, _ string) string {
		root := s.webviewRoot()
		if root == "" {
			return ""
		}
		if i == 0 {
			return filepath.Join(root, webviewSubDir)
		}
		return filepath.Join(root, webviewSubDir, webviewProfile)
	}}
	t.children = true
	t.include = isCacheDirName
	return t
}

func txtOnly(name string) bool { return strings.HasSuffix(strings.ToLower(name), ".txt") }

// specs 条目表：缓存段（「清除缓存」一键的范围）在前，数据段在后。
func (s *Service) specs() []spec {
	return []spec{
		// ---- 缓存：可再生，删了不丢用户内容 ----
		{
			id: "run-temp", label: "运行临时副本", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "运行未保存内容时的临时副本与编译产物，跑完本该回收；残留一般是异常退出留下的。",
			targets: []target{locChildrenTarget(LocRunTemp, nil)},
		},
		{
			id: "browser-profiles", label: "内嵌浏览器实例数据", scope: ScopeApp, kind: KindCache, inCache: true,
			note: "每个浏览器标签一份独立 WebView2 配置（网页缓存与登录态），关掉标签页不会自动回收，通常是占用最大的一项。清除会退出网页登录。",
			targets: []target{func() target {
				t := locChildrenTarget(LocBrowserProfiles, func(name string) bool {
					return strings.HasPrefix(name, browserDirPrefix)
				})
				t.blockActiveBrowser = true
				return t
			}()},
		},
		{
			id: "webview-cache", label: "界面浏览器缓存", scope: ScopeWebview, kind: KindCache, inCache: true,
			note:    "WebView2 自己的网络/代码/着色器缓存，不含界面设置与登录状态。运行中被进程锁住，点了安排在下次启动前清理。",
			targets: []target{webviewLevelTarget(0), webviewLevelTarget(1)},
		},
		{
			id: "session-index", label: "会话搜索索引", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "AI 会话全文搜索的派生库（ai-index.db）。会话正文仍在 JSONL 里，删后下次搜索整份重建。",
			targets: []target{dbTarget(LocSessionIndex)},
		},
		{
			id: "app-logs", label: "运行日志", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "每次启动一份的排障日志（logs/*.txt）。本次正在写入的那份会被跳过，退出后再清即可。",
			targets: []target{locChildrenTarget(LocAppLogs, txtOnly)},
		},
		{
			id: "debug-console", label: "调试控制台日志", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "调试控制台的历史缓冲（debug-console.jsonl），只影响面板里能看到多少旧行。",
			targets: []target{locTarget(LocDebugConsole)},
		},
		{
			id: "ai-logs", label: "AI 对话导出", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "每轮对话写出的 markdown 副本（ai-logs/），供外部检索与留档；会话本体不受影响。",
			targets: []target{appDirTarget("ai-logs")},
		},
		{
			id: "model-catalog", label: "模型配置表缓存", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "从远端数据源同步下来的模型目录（model-catalog.json）。删后要重新同步一次才拉得回来，自定义模型条目不受影响。",
			targets: []target{locTarget(LocModelCatalog)},
		},
		{
			id: "builtin-skills", label: "内置技能释放副本", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "随程序内嵌、首次列出技能时释放的副本（builtin-skills/），下次列出时按当前版本重新释放。",
			targets: []target{appDirTarget("builtin-skills")},
		},
		{
			id: "builtin-mcp-samples", label: "内置 MCP 示例副本", scope: ScopeApp, kind: KindCache, inCache: true,
			note:    "随程序内嵌、在设置里安装 MCP 示例时释放的脚本（builtin-mcp-samples/<版本>/）；删后可重新安装释放，已注册的 MCP 服务器条目不受影响（指向的脚本需要重新释放）。",
			targets: []target{appDirTarget("builtin-mcp-samples")},
		},
		{
			id: "temp-scratch", label: "系统临时文件", scope: ScopeTemp, kind: KindCache, inCache: true,
			note:    "%TEMP% 下本应用自己写的临时库与插件下载暂存（cadt-sql-* / cadt-plugin-*），只按前缀匹配。",
			targets: []target{locChildrenTarget(LocScratchDir, isTempScratchName)},
		},
		{
			id: "ws-worklog", label: "AI 工作日志（本工作区）", scope: ScopeWorkspace, kind: KindCache, inCache: true,
			note:    "工作区 .cadt/logs 下的三层工作日志索引与正文，只记做过什么，不是设定或正文。",
			targets: []target{workspaceTarget("logs")},
		},
		// ---- 数据：用户内容，只在「清除数据」里按勾选处理，删除走回收站 ----
		{
			id: "ws-gen", label: "生图与视频产物", scope: ScopeWorkspace, kind: KindData,
			note:    "工作区 .cadt/gen 里保存下来的生成图片与视频。",
			targets: []target{workspaceTarget("gen")},
		},
		{
			id: "ws-answers", label: "AI 回答页面", scope: ScopeWorkspace, kind: KindData,
			note:    "工作区 .cadt/answers 里「另存为」的 HTML 回答页。",
			targets: []target{workspaceTarget("answers")},
		},
		{
			id: "ws-memory", label: "工作区 AI 记忆", scope: ScopeWorkspace, kind: KindDanger,
			note:    "工作区 .cadt/memory 里的记忆与索引（MEMORY.md 是真源）。删除后 AI 不再记得这个项目的约定。",
			targets: []target{workspaceTarget("memory")},
		},
		{
			id: "ws-plan", label: "计划模式正文", scope: ScopeWorkspace, kind: KindDanger,
			note:    "工作区 .cadt/plan 里计划模式写下的计划正文。",
			targets: []target{workspaceTarget("plan")},
		},
		{
			id: "ws-patches", label: "补丁库", scope: ScopeWorkspace, kind: KindDanger,
			note:    "工作区 .cadt/patches 里的补丁、备份与索引。删除后已应用的补丁无法再撤销。",
			targets: []target{workspaceTarget("patches")},
		},
		{
			id: "ai-sessions", label: "AI 会话记录", scope: ScopeApp, kind: KindDanger,
			note:    "所有会话的正文 JSONL 与附图（ai-sessions/），是会话的唯一真源；派生索引删了能重建，这里删了就没了。",
			targets: []target{locTarget(LocAISessions)},
		},
		{
			id: "ai-memory", label: "应用级 AI 记忆", scope: ScopeApp, kind: KindData,
			note:    "记忆模式选「应用级」时写到 ai-memory 的内容；工作区模式的记忆在 .cadt/memory，不在这里。",
			targets: []target{appDirTarget("ai-memory")},
		},
		{
			id: "ai-schedule", label: "AI 定时任务", scope: ScopeApp, kind: KindDanger,
			note:    "定时任务定义与运行记录（ai-schedule.db）。任务只存在这里，删除等于全部取消。",
			targets: []target{dbTarget(LocScheduleDB)},
		},
		{
			id: "activity", label: "操作记录", scope: ScopeApp, kind: KindData,
			note:    "设置 → 操作记录 的按月 JSONL（activity/）。只记操作摘要，删除后面板历史清空。",
			targets: []target{locTarget(LocActivity)},
		},
		{
			id: "classifier", label: "端侧分类器个性化", scope: ScopeApp, kind: KindData,
			note:    "命令审批分类器的样本与权重（local-classifier/）。删除后个性化判定回到出厂状态。",
			targets: []target{appDirTarget("local-classifier")},
		},
		{
			id: "ui-state", label: "界面状态（WebView2）", scope: ScopeWebview, kind: KindDanger,
			note:    "整个 WebView2 用户数据：界面设置的 localStorage、网页登录态、浏览历史都在里面。删除相当于重置界面，运行中锁住，安排在下次启动前执行。",
			targets: []target{locTarget(LocWebview)},
		},
		{
			id: "app-config", label: "全部配置", scope: ScopeApp, kind: KindDanger,
			note: "config.json / ai-config.json（模型与端点）/ mcp.json / env-vars.json（DPAPI 加密的密钥）。删除即恢复出厂设置，密钥不可恢复。",
			targets: []target{
				locTarget(LocConfig),
				locTarget(LocAIConfig),
				locTarget(LocMCPConfig),
				locTarget(LocEnvVars),
			},
		},
	}
}

func (s *Service) specByID(id string) (spec, bool) {
	for _, item := range s.specs() {
		if item.id == id {
			return item, true
		}
	}
	return spec{}, false
}

// CacheIDs 返回「清除缓存」一键覆盖的条目 id（表内 inCache 项）。
// 设置页的清单来自扫描结果里的 inCache 标记，这里只留一份同源口径给测试与命令行。
func (s *Service) CacheIDs() []string {
	ids := []string{}
	for _, item := range s.specs() {
		if item.inCache {
			ids = append(ids, item.id)
		}
	}
	return ids
}

// resolve 把目标解析成路径；children 目标返回父目录本身。
func (t target) resolve(s *Service, workspaceRoot string) string {
	if t.path == nil {
		return ""
	}
	return strings.TrimSpace(t.path(s, workspaceRoot))
}

// targetFiles 解析目标要动的实际路径列表：children 目标取白名单内且未被占用的子项，
// sidecars 目标补上 -wal / -shm，其余是路径本身（不存在则不列）。
func (s *Service) targetFiles(t target, workspaceRoot string) []string {
	path := t.resolve(s, workspaceRoot)
	if path == "" {
		return nil
	}
	if t.children {
		entries, err := os.ReadDir(path)
		if err != nil {
			return nil
		}
		var blocked map[string]bool
		if t.blockActiveBrowser {
			blocked = s.blockedBrowserProfiles()
		}
		out := make([]string, 0, len(entries))
		for _, entry := range entries {
			name := entry.Name()
			if t.include != nil && !t.include(name) {
				continue
			}
			if blocked[name] {
				continue
			}
			out = append(out, filepath.Join(path, name))
		}
		return out
	}
	info, err := os.Lstat(path)
	if err != nil || !removableKind(info.Mode()) {
		return nil
	}
	paths := []string{path}
	if t.sidecars {
		paths = append(paths, path+"-wal", path+"-shm")
	}
	return paths
}

// removableKind 只把常规文件与目录当可清理对象，符号链接之类少见的东西不动。
func removableKind(mode os.FileMode) bool {
	return mode.IsRegular() || mode.IsDir()
}

// targetBlockedCount 数出被白名单认下、但因正在使用而跳过的子项。
func (s *Service) targetBlockedCount(t target, path string) int {
	if !t.children || !t.blockActiveBrowser || path == "" {
		return 0
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}
	blocked := s.blockedBrowserProfiles()
	count := 0
	for _, entry := range entries {
		name := entry.Name()
		if t.include != nil && !t.include(name) {
			continue
		}
		if blocked[name] {
			count++
		}
	}
	return count
}
