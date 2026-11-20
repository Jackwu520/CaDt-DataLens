// Package windowgeom：窗口几何的记忆与还原（纯逻辑 + 原子持久化）。
//
// 坐标一律是物理像素（与 Wails 的 Position/Size 一致）；调用方负责提供当前
// 显示器工作区（Screen.PhysicalWorkArea）。还原时把矩形收进可见区域，防止
// 拔掉显示器或改分辨率后窗口落在屏幕外再也点不到。
//
// 持久化文件是应用数据目录下的 window-state.json：
//
//	{"version":1,"windows":{"main":{...},"float":{...},"debug":{...}}}
//
// key 是窗口角色而不是窗口名——额外主窗口（main-2/…）不单独持久化，由宿主
// 按 main 的还原矩形级联，避免下次启动时窗口名与打开顺序对不上。
package windowgeom

import (
	"encoding/json"
	"os"
	"sync"

	"datalens/internal/atomfile"
)

// Rect 是一个窗口的几何状态。Maximised 为真时其余字段保留最大化前的还原矩形
// （最大化状态下的屏幕尺寸不能当还原尺寸用）。
type Rect struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximised bool `json:"maximised,omitempty"`
}

// Valid 报告矩形是否带有效尺寸（位置可以为负：主屏左侧的显示器）。
func (r Rect) Valid() bool { return r.Width > 0 && r.Height > 0 }

// 还原时至少要在工作区里留出的可见尺寸：标题栏抓得到、侧边点得到。
const (
	MinVisibleWidth  = 160
	MinVisibleHeight = 48
)

// Offset 平移矩形（级联窗口用）。
func Offset(r Rect, dx, dy int) Rect {
	r.X += dx
	r.Y += dy
	return r
}

// Center 返回在工作区内居中的矩形（尺寸超界时由调用方先收敛）。
func Center(width, height int, area Rect) Rect {
	return Rect{
		X:      area.X + (area.Width-width)/2,
		Y:      area.Y + (area.Height-height)/2,
		Width:  width,
		Height: height,
	}
}

// Normalize 把还原矩形收进当前屏幕布局：
//   - 尺寸不小于 minW/minH，且不超过所在工作区（避免从 4K 屏回到笔记本后巨大）；
//   - 与所有工作区几乎不相交（显示器被拔掉）时，按原尺寸在主屏居中；
//   - 否则把位置夹到「标题栏可见 + 至少 MinVisibleWidth 在屏内」。
//
// areas/primary 为空（非 Windows 或查询失败）时只做最小尺寸收敛。
func Normalize(r Rect, minW, minH int, areas []Rect, primary Rect) Rect {
	if !r.Valid() {
		return r
	}
	if minW > 0 && r.Width < minW {
		r.Width = minW
	}
	if minH > 0 && r.Height < minH {
		r.Height = minH
	}
	if len(areas) == 0 {
		return r
	}
	if !primary.Valid() {
		primary = areas[0]
	}

	target := bestArea(r, areas)
	if !target.Valid() {
		// 所有显示器都没了（拔屏/分辨率巨变）：先按主屏收敛尺寸再居中，
		// 否则从 4K 屏带回来的巨大矩形会在小屏上四边溢出。
		r = capToArea(r, primary, minW, minH)
		return Center(r.Width, r.Height, primary)
	}
	r = capToArea(r, target, minW, minH)

	needW := min(MinVisibleWidth, r.Width)
	needH := min(MinVisibleHeight, r.Height)
	if overlap(r.X, r.X+r.Width, target.X, target.X+target.Width) < needW ||
		overlap(r.Y, r.Y+r.Height, target.Y, target.Y+target.Height) < needH {
		return Center(r.Width, r.Height, primary)
	}

	// 标题栏不低于工作区上沿；左右至少留 needW，底部至少留 needH。
	if r.Y < target.Y {
		r.Y = target.Y
	}
	if maxY := target.Y + target.Height - needH; r.Y > maxY {
		r.Y = maxY
	}
	if minX := target.X - r.Width + needW; r.X < minX {
		r.X = minX
	}
	if maxX := target.X + target.Width - needW; r.X > maxX {
		r.X = maxX
	}
	return r
}

// ClampVisible 只修位置不改尺寸：把窗口拉回可见工作区（拔屏/改分辨率后的运行期收敛）。
// 悬跨双屏的窗口取交叠最大的工作区，只平移不缩放——缩放是 Normalize（还原时）的事，
// 运行期动用户的窗口尺寸太激进。
func ClampVisible(r Rect, areas []Rect, primary Rect) Rect {
	if !r.Valid() || len(areas) == 0 {
		return r
	}
	if !primary.Valid() {
		primary = areas[0]
	}
	target := bestArea(r, areas)
	if !target.Valid() {
		return Center(r.Width, r.Height, primary)
	}
	needW := min(MinVisibleWidth, r.Width)
	needH := min(MinVisibleHeight, r.Height)
	if overlap(r.X, r.X+r.Width, target.X, target.X+target.Width) < needW ||
		overlap(r.Y, r.Y+r.Height, target.Y, target.Y+target.Height) < needH {
		return Center(r.Width, r.Height, primary)
	}
	if r.Y < target.Y {
		r.Y = target.Y
	}
	if maxY := target.Y + target.Height - needH; r.Y > maxY {
		r.Y = maxY
	}
	if minX := target.X - r.Width + needW; r.X < minX {
		r.X = minX
	}
	if maxX := target.X + target.Width - needW; r.X > maxX {
		r.X = maxX
	}
	return r
}

// bestArea 返回与 r 交叠面积最大的工作区（无交叠时返回零值）。
func bestArea(r Rect, areas []Rect) Rect {
	var best Rect
	bestScore := 0
	for _, a := range areas {
		if !a.Valid() {
			continue
		}
		w := overlap(r.X, r.X+r.Width, a.X, a.X+a.Width)
		h := overlap(r.Y, r.Y+r.Height, a.Y, a.Y+a.Height)
		if w <= 0 || h <= 0 {
			continue
		}
		if score := w * h; score > bestScore {
			bestScore = score
			best = a
		}
	}
	return best
}

func capToArea(r Rect, area Rect, minW, minH int) Rect {
	if r.Width > area.Width {
		r.Width = max(minW, area.Width)
	}
	if r.Height > area.Height {
		r.Height = max(minH, area.Height)
	}
	return r
}

// overlap 返回 [a1,a2) 与 [b1,b2) 的交叠长度（无交叠为 0）。
func overlap(a1, a2, b1, b2 int) int {
	left, right := max(a1, b1), min(a2, b2)
	if right <= left {
		return 0
	}
	return right - left
}

// ---- 磁盘存储 ----

const storeVersion = 1

type fileData struct {
	Version int             `json:"version"`
	Windows map[string]Rect `json:"windows"`
}

// Store 是 window-state.json 的内存视图，可并发使用。
type Store struct {
	path string

	mu      sync.Mutex
	windows map[string]Rect
}

// Load 读取几何文件；文件缺失、损坏或字段非法时返回空存储（坏文件不阻塞启动）。
func Load(path string) *Store {
	s := &Store{path: path, windows: map[string]Rect{}}
	if path == "" {
		return s
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var data fileData
	if json.Unmarshal(raw, &data) != nil {
		return s
	}
	for key, r := range data.Windows {
		if key != "" && r.Valid() {
			s.windows[key] = r
		}
	}
	return s
}

// Get 返回指定角色的几何；不存在时 ok 为 false。
func (s *Store) Get(key string) (Rect, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.windows[key]
	return r, ok
}

// Put 更新内存中的几何，返回内容是否发生变化（宿主据此决定要不要落盘）。
func (s *Store) Put(key string, r Rect) bool {
	if key == "" || !r.Valid() {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.windows[key]; ok && old == r {
		return false
	}
	s.windows[key] = r
	return true
}

// Save 原子写回磁盘；path 为空（应用数据目录不可用）时静默成功。
func (s *Store) Save() error {
	s.mu.Lock()
	data := fileData{Version: storeVersion, Windows: make(map[string]Rect, len(s.windows))}
	for key, r := range s.windows {
		data.Windows[key] = r
	}
	path := s.path
	s.mu.Unlock()

	if path == "" {
		return nil
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomic(path, raw)
}
