package main

// windowmeta.go：一进程多窗口的窗口元数据与注册表（P2）。
//
// v2 时代「一窗口 = 一进程」，启动参数、脏标记、AI 运行状态等天然按进程隔离；
// v3 一进程多窗口后，这些状态必须按窗口归属。归属键是窗口名（窗口名同时是
// v3 事件的 sender）。绑定方法通过 context 里的 application.WindowKey 拿到调用方窗口。

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/launchargs"
	"datalens/internal/windowgeom"
)

type windowMode string

const (
	windowModeMain  windowMode = "main"
	windowModeFloat windowMode = "float"
	windowModeDebug windowMode = "debug"
)

// windowSpec 是创建窗口时的启动上下文（等价 v2 的进程启动参数）。
type windowSpec struct {
	Name         string
	Mode         windowMode
	Workspace    string
	Targets      []launchargs.OpenTarget
	SessionID    string
	SettingsPane string
	MemoLocator  string
}

// windowState 是单个窗口的可变状态。
type windowState struct {
	spec windowSpec
	win  *application.WebviewWindow

	mu         sync.Mutex
	dirty      bool
	aiRunning  bool
	forceClose bool
	// geometryApplied：创建后首次导航完成时按当前显示器收敛一次几何；后续
	// HMR/重载触发的导航不重复应用，避免把用户已拖动的窗口拉回初始位置。
	geometryApplied bool
	initialGeom     windowgeom.Rect
	hasInitialGeom  bool
}

func (s *windowState) name() string { return s.spec.Name }

func (s *windowState) workspace() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec.Workspace
}

func (s *windowState) setWorkspace(ws string) {
	s.mu.Lock()
	s.spec.Workspace = ws
	s.mu.Unlock()
}

func (s *windowState) setWindow(w *application.WebviewWindow) {
	s.mu.Lock()
	s.win = w
	s.mu.Unlock()
}

func (s *windowState) window() *application.WebviewWindow {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.win
}

func (s *windowState) SetDirty(v bool)     { s.mu.Lock(); s.dirty = v; s.mu.Unlock() }
func (s *windowState) IsDirty() bool       { s.mu.Lock(); defer s.mu.Unlock(); return s.dirty }
func (s *windowState) SetAIRunning(v bool) { s.mu.Lock(); s.aiRunning = v; s.mu.Unlock() }
func (s *windowState) IsAIRunning() bool   { s.mu.Lock(); defer s.mu.Unlock(); return s.aiRunning }
func (s *windowState) forceClosed() bool   { s.mu.Lock(); defer s.mu.Unlock(); return s.forceClose }
func (s *windowState) markForceClose()     { s.mu.Lock(); s.forceClose = true; s.mu.Unlock() }

// setInitialGeometry 记录创建时算好的几何（未命中存档时 ok=false）。
func (s *windowState) setInitialGeometry(r windowgeom.Rect, ok bool) {
	s.mu.Lock()
	s.initialGeom, s.hasInitialGeom = r, ok
	s.mu.Unlock()
}

// takeInitialGeometry 首次调用返回创建时的几何并标记已应用；后续导航返回 false。
func (s *windowState) takeInitialGeometry() (windowgeom.Rect, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.geometryApplied {
		return windowgeom.Rect{}, false
	}
	s.geometryApplied = true
	return s.initialGeom, s.hasInitialGeom
}

func (s *windowState) startup() windowSpec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec
}

// registry 是进程内窗口集合。主窗口/浮窗/调试控制台都在这里按名字登记。
type winRegistryStore struct {
	mu     sync.RWMutex
	states map[string]*windowState
	seq    int
}

var winReg = &winRegistryStore{states: map[string]*windowState{}}

// nextName 给新窗口分配唯一名字：首个主窗口固定 main，其余 main-2/...
func (r *winRegistryStore) nextName(mode windowMode) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	switch mode {
	case windowModeFloat:
		if _, ok := r.states["float"]; !ok {
			return "float"
		}
		return fmt.Sprintf("float-%d", r.seq)
	case windowModeDebug:
		if _, ok := r.states["debug"]; !ok {
			return "debug"
		}
		return fmt.Sprintf("debug-%d", r.seq)
	default:
		if _, ok := r.states["main"]; !ok {
			return "main"
		}
		return fmt.Sprintf("main-%d", r.seq)
	}
}

func (r *winRegistryStore) add(spec windowSpec) *windowState {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := &windowState{spec: spec}
	r.states[spec.Name] = state
	return state
}

func (r *winRegistryStore) get(name string) *windowState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.states[name]
}

func (r *winRegistryStore) remove(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.states, name)
}

func (r *winRegistryStore) list() []*windowState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*windowState, 0, len(r.states))
	for _, s := range r.states {
		out = append(out, s)
	}
	return out
}

// countMain 统计仍存活的主窗口数（托盘「最后一个窗口」判据用）。
func (r *winRegistryStore) countMain() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n := 0
	for _, s := range r.states {
		if s.spec.Mode == windowModeMain {
			n++
		}
	}
	return n
}

// findByWorkspace 找一个开着目标工作区的主窗口（exclude 为调用方窗口名）。
func (r *winRegistryStore) findByWorkspace(workspace, exclude string) *windowState {
	if workspace == "" {
		return nil
	}
	want := pathKeyForCompare(workspace)
	r.mu.RLock()
	defer r.mu.RUnlock()
	for name, s := range r.states {
		if name == exclude || s.spec.Mode != windowModeMain {
			continue
		}
		if pathKeyForCompare(s.workspace()) == want {
			return s
		}
	}
	return nil
}

// primary 返回主窗口状态（main 优先，其次按名字序最早的主窗口；没有则 nil）。
func (r *winRegistryStore) primary() *windowState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if s, ok := r.states["main"]; ok {
		return s
	}
	names := make([]string, 0, len(r.states))
	for name, s := range r.states {
		if s.spec.Mode == windowModeMain {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	sort.Strings(names)
	return r.states[names[0]]
}

// pathKeyForCompare 路径归一（分隔符/大小写/尾斜杠），与前端 sessionPathKey 同口径。
func pathKeyForCompare(p string) string {
	out := make([]rune, 0, len(p))
	for _, r := range p {
		if r == '\\' {
			r = '/'
		}
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		out = append(out, r)
	}
	for len(out) > 0 && out[len(out)-1] == '/' {
		out = out[:len(out)-1]
	}
	return string(out)
}

// ---- 绑定调用的窗口归属 ----

// callerWindow 从绑定 context 里取调用方窗口（v3 在 messageprocessor_call 注入 WindowKey）。
func callerWindow(ctx context.Context) *application.WebviewWindow {
	if ctx == nil {
		return nil
	}
	w, ok := ctx.Value(application.WindowKey).(application.Window)
	if !ok || w == nil {
		return nil
	}
	if wv, ok := w.(*application.WebviewWindow); ok {
		return wv
	}
	return nil
}

func callerWindowName(ctx context.Context) string {
	if w := callerWindow(ctx); w != nil {
		return w.Name()
	}
	return ""
}

// stateForCaller 返回调用方窗口状态；无窗口上下文（测试/非绑定路径）回退到主窗口。
func stateForCaller(ctx context.Context) *windowState {
	if name := callerWindowName(ctx); name != "" {
		if st := winReg.get(name); st != nil {
			return st
		}
	}
	return winReg.primary()
}
