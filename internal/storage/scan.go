// scan.go：给设置页「存储与清理」的占用统计。
//
// 输出三格汇总（应用数据目录 / 工作区 .cadt / 系统临时）+ 逐条目体积。
// 每格 = 该格条目之和 + 目录下没被任何条目覆盖的「其他」，所以格子数字等于目录真实占用，
// 不会出现「条目加起来比目录小」这种让人不敢信的统计。
package storage

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Item 设置页一行：条目定义 + 当前占用与状态。
type Item struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Note    string `json:"note"`
	Kind    string `json:"kind"`
	Scope   string `json:"scope"`
	InCache bool   `json:"inCache"`
	Path    string `json:"path"`
	Exists  bool   `json:"exists"`
	Bytes   int64  `json:"bytes"`
	Files   int    `json:"files"`
	// Entries 是子项数，子项型条目用它显示「44 项」；非子项型为 0。
	Entries int  `json:"entries"`
	Approx  bool `json:"approx"`
	// Blocked 是因正在使用而未纳入统计与删除的子项数（活动浏览器实例）。
	Blocked int  `json:"blocked"`
	Pending bool `json:"pending"`
}

// Tile 汇总条里一格。
type Tile struct {
	Scope      string `json:"scope"`
	Label      string `json:"label"`
	Path       string `json:"path"`
	Bytes      int64  `json:"bytes"`
	Files      int    `json:"files"`
	OtherBytes int64  `json:"otherBytes"`
	OtherFiles int    `json:"otherFiles"`
	Available  bool   `json:"available"`
}

// Report 一次扫描的全部结果。
type Report struct {
	Items        []Item   `json:"items"`
	Tiles        []Tile   `json:"tiles"`
	CacheBytes   int64    `json:"cacheBytes"`
	DataBytes    int64    `json:"dataBytes"`
	Truncated    bool     `json:"truncated"`
	WorkspaceSet bool     `json:"workspaceSet"`
	Pending      []string `json:"pending"`
	ScannedAt    int64    `json:"scannedAt"`
}

// tileDefs 汇总条的三格，顺序即界面顺序。
var tileDefs = []struct {
	scope string
	label string
}{
	{ScopeApp, "应用数据目录"},
	{ScopeWorkspace, "工作区 .cadt"},
	{ScopeTemp, "系统临时目录"},
}

// Scan 统计占用。workspaceRoot 是调用方（前端当前标签页所在工作区）的根目录，
// 空串时工作区条目按「不存在」处理——本应用可以多窗口各开一个工作区，根目录只能由调用方给。
func (s *Service) Scan(workspaceRoot string) Report {
	workspaceRoot = normalizeWorkspace(workspaceRoot)
	budget := ScanMaxEntries
	pending := s.readPending()
	specs := s.specs()
	report := Report{WorkspaceSet: workspaceRoot != "", Pending: pending, ScannedAt: time.Now().UnixMilli()}
	items := make([]Item, 0, len(specs))
	for _, sp := range specs {
		item := s.scanItem(sp, workspaceRoot, &budget, pending)
		if item.Kind == KindCache {
			report.CacheBytes += item.Bytes
		} else {
			report.DataBytes += item.Bytes
		}
		items = append(items, item)
	}
	report.Items = items
	report.Truncated = budget <= 0
	report.Tiles = s.buildTiles(items, specs, workspaceRoot)
	return report
}

func normalizeWorkspace(workspaceRoot string) string {
	workspaceRoot = strings.TrimSpace(workspaceRoot)
	if workspaceRoot == "" {
		return ""
	}
	return filepath.Clean(workspaceRoot)
}

func (s *Service) scanItem(sp spec, workspaceRoot string, budget *int, pending []string) Item {
	item := Item{
		ID:      sp.id,
		Label:   sp.label,
		Note:    sp.note,
		Kind:    sp.kind,
		Scope:   sp.scope,
		InCache: sp.inCache,
	}
	var out usage
	for _, t := range sp.targets {
		if item.Path == "" {
			item.Path = t.resolve(s, workspaceRoot)
		}
		out.add(s.measureTarget(t, workspaceRoot, budget))
		item.Blocked += s.targetBlockedCount(t, t.resolve(s, workspaceRoot))
	}
	item.Bytes = out.bytes
	item.Files = out.files
	item.Entries = out.entries
	item.Approx = out.approx
	// 空目录算「不存在」：一行要有东西可清才在界面上亮出来
	item.Exists = out.bytes > 0 || out.entries > 0 || out.files > 0
	item.Pending = containsID(pending, sp.id)
	return item
}

// buildTiles 逐格汇总：条目按归属格子相加，再补上该格根目录下没被任何条目覆盖的子项。
func (s *Service) buildTiles(items []Item, specs []spec, workspaceRoot string) []Tile {
	tiles := make([]Tile, 0, len(tileDefs))
	for _, def := range tileDefs {
		root := s.tileRoot(def.scope, workspaceRoot)
		tile := Tile{Scope: def.scope, Label: def.label, Path: root}
		covered := map[string]bool{}
		for _, item := range items {
			if tileOfItemScope(item.Scope) != def.scope {
				continue
			}
			tile.Bytes += item.Bytes
			tile.Files += item.Files
			tile.Available = tile.Available || item.Exists
		}
		for _, sp := range specs {
			if tileOfItemScope(sp.scope) != def.scope {
				continue
			}
			for _, name := range s.specTopLevelNames(sp, root, workspaceRoot) {
				covered[name] = true
			}
		}
		// %TEMP% 是系统共享目录，只有本应用前缀的东西归我们统计，不能把别人的文件算进「其他」。
		if def.scope != ScopeTemp && root != "" {
			other := leftoverUsage(root, covered)
			tile.OtherBytes = other.bytes
			tile.OtherFiles = other.files
			tile.Available = tile.Available || other.files > 0
		}
		tiles = append(tiles, tile)
	}
	return tiles
}

// tileOfItemScope 条目归到哪一格：WebView2 就住在应用数据目录里，与应用数据同格。
func tileOfItemScope(scope string) string {
	if scope == ScopeWebview {
		return ScopeApp
	}
	return scope
}

func (s *Service) tileRoot(scope, workspaceRoot string) string {
	switch scope {
	case ScopeWorkspace:
		return s.workspaceCadtRoot(workspaceRoot)
	case ScopeTemp:
		return s.scratchDir()
	default:
		return s.appRoot()
	}
}

// specTopLevelNames 条目实际占住的、相对所在格根目录的第一层名字。
// 格子按直接子项补「其他」，只要子项名被覆盖过就不会重复计数。
func (s *Service) specTopLevelNames(sp spec, root, workspaceRoot string) []string {
	if root == "" {
		return nil
	}
	names := make([]string, 0, len(sp.targets))
	for _, t := range sp.targets {
		path := t.resolve(s, workspaceRoot)
		if path == "" {
			continue
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		names = append(names, strings.Split(filepath.ToSlash(rel), "/")[0])
	}
	return names
}

// leftoverUsage 统计根目录下未被条目覆盖的直接子项。以点开头的条目（待清理标记、锁文件）
// 是内部控制件，不计进「其他」，否则用户会看到一块既看不懂又清不掉的容量。
func leftoverUsage(root string, covered map[string]bool) usage {
	out := usage{}
	entries, err := os.ReadDir(root)
	if err != nil {
		return out
	}
	budget := ScanMaxEntries
	for _, entry := range entries {
		name := entry.Name()
		if covered[name] || strings.HasPrefix(name, ".") {
			continue
		}
		out.add(measurePath(filepath.Join(root, name), &budget))
	}
	return out
}

func containsID(ids []string, id string) bool {
	for _, item := range ids {
		if item == id {
			return true
		}
	}
	return false
}
