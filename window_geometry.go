package main

// window_geometry.go：窗口位置/尺寸记忆（浮窗行为工程化的第一块）。
//
// 窗口角色（main / float / debug）各记一份还原矩形：移动/缩放经 500ms 防抖落盘，
// 关窗与退出时同步 flush。创建窗口时按当前显示器布局收敛，拔掉显示器或改分辨率后
// 不会落在屏幕外；额外主窗口（main-2/…）不单独持久化，从 main 的还原矩形级联，
// 避免叠在同一位置。
//
// 角色而不是窗口名做 key：窗口名随打开顺序变化（main-2 这次是第二个窗口，下次
// 可能是另一个工作区），按名字存会让位置在重启后错位。

import (
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"datalens/internal/windowgeom"
)

const (
	// windowGeometrySaveDelay：拖拽/缩放停止后多久落盘（移动事件本身已有 50ms 防抖）。
	windowGeometrySaveDelay = 500 * time.Millisecond
	// windowCascadeStep：额外主窗口相对上一扇的错位。
	windowCascadeStep = 28
)

type windowGeometryManager struct {
	once  sync.Once
	store *windowgeom.Store

	mu    sync.Mutex
	timer *time.Timer
	dirty bool
}

var winGeom = &windowGeometryManager{}

// stateStore 懒加载 window-state.json（应用数据目录不可用时退化为纯内存）。
func (g *windowGeometryManager) stateStore() *windowgeom.Store {
	g.once.Do(func() {
		path := ""
		if root := appDataRoot(); root != "" {
			path = filepath.Join(root, "window-state.json")
		}
		g.store = windowgeom.Load(path)
	})
	return g.store
}

// screenWorkAreas 返回当前显示器工作区（物理像素）与主屏工作区。
func screenWorkAreas() (areas []windowgeom.Rect, primary windowgeom.Rect) {
	if wailsApp == nil || wailsApp.Screen == nil {
		return nil, windowgeom.Rect{}
	}
	for _, s := range wailsApp.Screen.GetAll() {
		if s == nil {
			continue
		}
		areas = append(areas, screenWorkArea(s))
	}
	if p := wailsApp.Screen.GetPrimary(); p != nil {
		primary = screenWorkArea(p)
	}
	if !primary.Valid() && len(areas) > 0 {
		primary = areas[0]
	}
	return areas, primary
}

func screenWorkArea(s *application.Screen) windowgeom.Rect {
	if s == nil {
		return windowgeom.Rect{}
	}
	wa := s.PhysicalWorkArea
	if wa.Width <= 0 || wa.Height <= 0 {
		wa = s.WorkArea
	}
	return windowgeom.Rect{X: wa.X, Y: wa.Y, Width: wa.Width, Height: wa.Height}
}

// geometryRestoreKey 给出窗口创建时的存储 key 与级联层数。
// mainCount 是含本窗口在内的主窗口数（调用时窗口已登记到注册表）。
func geometryRestoreKey(spec windowSpec, mainCount int) (key string, cascade int) {
	switch spec.Mode {
	case windowModeFloat:
		if spec.Name == "float" {
			return "float", 0
		}
		return "", 0
	case windowModeDebug:
		if spec.Name == "debug" {
			return "debug", 0
		}
		return "", 0
	default:
		extra := mainCount - 1
		if extra < 0 {
			extra = 0
		}
		return "main", extra
	}
}

// geometryPersistKey 给出窗口移动/关闭时的存储 key；空串表示不持久化。
// 额外主窗口（非当前 primary）只参与显示，不覆盖 main 的位置。
func geometryPersistKey(spec windowSpec, isPrimary bool) string {
	switch spec.Mode {
	case windowModeFloat:
		if spec.Name == "float" {
			return "float"
		}
	case windowModeDebug:
		if spec.Name == "debug" {
			return "debug"
		}
	default:
		if isPrimary {
			return "main"
		}
	}
	return ""
}

// initialGeometry 计算窗口创建时应使用的矩形。ok=false 时保持 v3 默认居中。
func (g *windowGeometryManager) initialGeometry(spec windowSpec, defaultW, defaultH, minW, minH int) (windowgeom.Rect, bool) {
	key, cascade := geometryRestoreKey(spec, winReg.countMain())
	if key == "" {
		return windowgeom.Rect{}, false
	}
	areas, primary := screenWorkAreas()
	saved, ok := g.stateStore().Get(key)
	if !ok {
		if cascade == 0 {
			// 首次运行：沿用默认居中，等第一次移动/关闭时再记下来。
			return windowgeom.Rect{}, false
		}
		if !primary.Valid() {
			return windowgeom.Rect{}, false
		}
		base := windowgeom.Center(defaultW, defaultH, primary)
		r := windowgeom.Offset(base, cascade*windowCascadeStep, cascade*windowCascadeStep)
		return windowgeom.Normalize(r, minW, minH, areas, primary), true
	}

	// 最大化只对主窗口角色有意义；级联出来的窗口一律以普通尺寸出现。
	if cascade > 0 {
		saved.Maximised = false
	}
	r := windowgeom.Offset(saved, cascade*windowCascadeStep, cascade*windowCascadeStep)
	return windowgeom.Normalize(r, minW, minH, areas, primary), true
}

// capture 把当前窗口几何写进内存并安排落盘；最小化/全屏/最大化时保留还原矩形。
func (g *windowGeometryManager) capture(st *windowState) {
	if st == nil {
		return
	}
	spec := st.startup()
	key := geometryPersistKey(spec, winReg.primary() == st)
	if key == "" {
		return
	}
	w := st.window()
	if w == nil || w.IsMinimised() || w.IsFullscreen() {
		return
	}
	// 创建阶段的初始定位/尺寸事件会早于 windowReady 到达。此时窗口还不可见，
	// 采集会把「最大化」标记冲成普通状态（重启后就不还原最大化了），直接跳过；
	// 用户真正拖动/缩放时窗口必然可见。
	if !w.IsVisible() {
		return
	}

	var r windowgeom.Rect
	if w.IsMaximised() {
		// 最大化时的 Position/Size 是屏幕尺寸，不能当还原矩形；只置标记。
		prev, ok := g.stateStore().Get(key)
		if !ok || !prev.Valid() {
			return
		}
		r = prev
		r.Maximised = true
	} else {
		x, y := w.Position()
		width, height := w.Size()
		if width <= 0 || height <= 0 {
			return
		}
		r = windowgeom.Rect{X: x, Y: y, Width: width, Height: height}
	}
	if g.stateStore().Put(key, r) {
		g.scheduleSave()
	}
}

func (g *windowGeometryManager) scheduleSave() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.dirty = true
	if g.timer != nil {
		g.timer.Stop()
	}
	g.timer = time.AfterFunc(windowGeometrySaveDelay, func() {
		g.mu.Lock()
		g.timer = nil
		dirty := g.dirty
		g.dirty = false
		g.mu.Unlock()
		if dirty {
			g.save()
		}
	})
}

// flush 立即落盘（关窗/退出时调用）；没有变化时是空操作。
func (g *windowGeometryManager) flush() {
	g.mu.Lock()
	if g.timer != nil {
		g.timer.Stop()
		g.timer = nil
	}
	dirty := g.dirty
	g.dirty = false
	g.mu.Unlock()
	if dirty {
		g.save()
	}
}

func (g *windowGeometryManager) save() {
	if err := g.stateStore().Save(); err != nil {
		writeAppLog("warn", "窗口几何落盘失败：%v", err)
	}
}

// installGeometryHooks 给窗口挂几何采集钩子。v3 在 Windows 上发的是
// events.Windows.*（WindowDidMove 自带 50ms 防抖），最大化/还原也采集一次，
// 保证「最大化后关窗」能记住还原矩形。
func installGeometryHooks(win *application.WebviewWindow, st *windowState) {
	if win == nil || st == nil {
		return
	}
	capture := func(_ *application.WindowEvent) { winGeom.capture(st) }
	win.RegisterHook(events.Windows.WindowDidMove, capture)
	win.RegisterHook(events.Windows.WindowDidResize, capture)
	win.RegisterHook(events.Windows.WindowMaximise, capture)
	win.RegisterHook(events.Windows.WindowUnMaximise, capture)
}
