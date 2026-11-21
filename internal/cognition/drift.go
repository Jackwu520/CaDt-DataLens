// drift.go：工作区清单扫描 + baseline 读写 + 四态 drift 判定（§4.1）。
// 清单来源是 fs 遍历（git 不是前提），忽略表复用 internal/search 的 SkipDir，并**自带 .cadt 整树
// 排除**——已核实 SkipDir/SkipPath 都不含 .cadt（只排 .cadt/worktree），不加这道闸卷文件自己
// 每次都会被报成 Missing。目录条目豁免 Stale（目录 mtime 随子项增删全变，必噪音化）。
// 作用域排除文件 ignore.txt 在卷目录里（AI 经 cognition_edit 的 ignore 参数整卷替换，用户
// 手工编辑不受限），gitignore 简化语法，解析/匹配复用 search 的排除表机器（与
// .cadt/config/search-ignore 刻意解耦——可搜索 ≠ 可索引）：被排除的文件不进清单、不报
// Missing；它在 .cadt 整树排除之下，自身永不进清单（无自指问题）。
package cognition

import (
	"datalens/internal/atomfile"
	"datalens/internal/search"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ScannedFile 清单扫描出的一个常规文件（相对路径正斜杠 + mtime/size）。
type ScannedFile struct {
	Path   string `json:"path"`
	Mtime  int64  `json:"mtime"` // 毫秒
	Size   int64  `json:"size"`
}

// ScanWorkspace 预算内的全树扫描（§4.1：唯一的全树成本，千文件级 < 20 ms）。
// 超 maxScanFiles 截断并标记 truncated——数据目录误跑不会爬完整棵树。
func ScanWorkspace(root string) (files []ScannedFile, truncated bool, err error) {
	rules := search.LoadIgnoreRulesAt(filepath.Join(root, filepath.FromSlash(DirName), IgnoreName))
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // 读不到的子树跳过，不炸整趟扫描
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if rel == ".cadt" || strings.HasPrefix(rel, ".cadt/") || search.SkipDir(name) ||
				rules.ShouldSkipDir(name, rel) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if rules.ShouldSkipFile(d.Name(), rel) {
			return nil // 作用域排除：不进清单、不报 Missing
		}
		if len(files) >= maxScanFiles {
			truncated = true
			return filepath.SkipAll
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		files = append(files, ScannedFile{
			Path:  rel,
			Mtime: info.ModTime().UnixMilli(),
			Size:  info.Size(),
		})
		return nil
	})
	return files, truncated, err
}

// Baseline 首建/簿记的治理状态：路径（PathKey）→ mtime/size 快照 + 当前卷指纹（CAS 基准）。
// 只记录「有文件条目且文件存在」的路径——Stale 只对条目文件判定，全量记录只会虚胖 baseline.json。
type Baseline struct {
	Fingerprint string                  `json:"fingerprint"`
	Files       map[string]BaselineFile `json:"files"`
}

type BaselineFile struct {
	Mtime int64 `json:"mtime"`
	Size  int64 `json:"size"`
	At    int64 `json:"at"`
}

func LoadBaseline(path string) (*Baseline, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var b Baseline
	if err := json.Unmarshal(data, &b); err != nil {
		return nil, false, err // 损坏视为缺失，由 status 全量重建
	}
	return &b, true, nil
}

func SaveBaseline(path string, b *Baseline) error {
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomic(path, data)
}

// DriftList 一个 drift 态的总量 + 样例（样例封顶，总量照实——报告别被大仓淹死）。
type DriftList struct {
	Total   int      `json:"total"`
	Samples []string `json:"samples,omitempty"`
}

type Drift struct {
	Missing    DriftList `json:"missing"`    // 工作区有文件、索引无条目（目录条目覆盖的除外）
	Orphan     DriftList `json:"orphan"`     // 索引有条目、文件没了
	Stale      DriftList `json:"stale"`      // 文件变了、条目语义可能失效（仅文件条目）
	Unbaselined DriftList `json:"unbaselined"` // 条目不在 baseline（簿记没闭环）
}

func (l *DriftList) add(path string) {
	l.Total++
	if len(l.Samples) < driftSampleCap {
		l.Samples = append(l.Samples, path)
	}
}

// ComputeDrift 四态判定（纯函数，表驱动测试）。
//   - Missing：fs 文件既无同键条目、也不在任何目录条目前缀下；
//   - Orphan：文件条目的文件不在 fs；目录条目按「fs 里没有该前缀下的文件」判空；
//   - Stale：文件条目在 fs 且在 baseline，但 mtime/size 与记录不一致（目录条目豁免）；
//   - Unbaselined：文件条目不在 baseline 记录里（baseline 缺失时全部算——保守方向）。
func ComputeDrift(entries []Entry, files []ScannedFile, baseline *Baseline) Drift {
	var drift Drift
	fileByKey := make(map[string]ScannedFile, len(files))
	for _, f := range files {
		fileByKey[PathKey(f.Path)] = f
	}
	var dirKeys []string
	entryKeys := make(map[string]bool, len(entries))
	for _, e := range entries {
		key := PathKey(e.Path)
		if e.Dir() {
			dirKeys = append(dirKeys, key)
		} else {
			entryKeys[key] = true
		}
	}
	covered := func(fileKey string) bool {
		if entryKeys[fileKey] {
			return true
		}
		for _, dirKey := range dirKeys {
			if strings.HasPrefix(fileKey, dirKey) {
				return true
			}
		}
		return false
	}
	// Missing：fs 有、索引无（保持 fs 顺序，稳定输出）
	for _, f := range files {
		key := PathKey(f.Path)
		if !covered(key) {
			drift.Missing.add(f.Path)
		}
	}
	// Orphan / Stale / Unbaselined：按条目走
	for _, e := range entries {
		key := PathKey(e.Path)
		if e.Dir() {
			live := false
			for fileKey := range fileByKey {
				if strings.HasPrefix(fileKey, key) {
					live = true
					break
				}
			}
			if !live {
				drift.Orphan.add(e.Path)
			}
			continue
		}
		f, inFS := fileByKey[key]
		if !inFS {
			drift.Orphan.add(e.Path)
		}
		var rec BaselineFile
		var inBase bool
		if baseline != nil {
			rec, inBase = baseline.Files[key]
		}
		if !inBase {
			drift.Unbaselined.add(e.Path)
			continue
		}
		if inFS && (rec.Mtime != f.Mtime || rec.Size != f.Size) {
			drift.Stale.add(e.Path)
		}
	}
	return drift
}

// BuildBaseline 首建/恢复时从「文件条目 ∩ fs」构建 baseline（Stale 只对条目文件判定，§4.1）。
func BuildBaseline(entries []Entry, files []ScannedFile, fingerprint string, now int64) *Baseline {
	fileByKey := make(map[string]ScannedFile, len(files))
	for _, f := range files {
		fileByKey[PathKey(f.Path)] = f
	}
	b := &Baseline{Fingerprint: fingerprint, Files: map[string]BaselineFile{}}
	for _, e := range entries {
		if e.Dir() {
			continue
		}
		if f, ok := fileByKey[PathKey(e.Path)]; ok {
			b.Files[PathKey(e.Path)] = BaselineFile{Mtime: f.Mtime, Size: f.Size, At: now}
		}
	}
	return b
}

// SortStrings 样例稳定排序（报告可复现）。
func SortStrings(list []string) {
	sort.Strings(list)
}
