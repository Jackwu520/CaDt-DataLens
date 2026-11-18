// fingerprint.go：L2 结构指纹与告警判定（方案 §5.3 / §5.4）。
//
// 顶层与一级永远测（毫秒级）；全树文件数按墙钟 + 条目预算，超预算 Sampled=true，
// FileCount 条件失效但 RootEntries / Markers 照判。判定只看「减少」，不看新增。
package wipeguard

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/search"
)

// Fingerprint 工作区结构指纹。
type Fingerprint struct {
	RootEntries int             `json:"rootEntries"` // 顶层条目数（含目录）
	Depth1Dirs  int             `json:"depth1Dirs"`  // 一级子目录数
	Markers     map[string]bool `json:"markers"`     // 关键标记的存在性（.git / go.mod / package.json）
	FileCount   int             `json:"fileCount"`   // 全树文件数；-1 = 未测（超预算）
	Sampled     bool            `json:"sampled"`     // 是否因预算降级
}

// fingerprintMarkers 关键标记（相对路径，存在即真）。`.git` 消失是本次事故形态的核心信号。
var fingerprintMarkers = []string{".git", "go.mod", "package.json"}

// 指纹预算：全树文件数统计的墙钟与条目双上限（方案 §5.3）。
const (
	fingerprintWallBudget   = 200 * time.Millisecond
	fingerprintEntryBudget  = 50000
	// RootEntries / 文件数判定的保守门槛：太小的树波动大，不判（方案 §10「阈值偏保守」）。
	warnMinRootEntries = 5
	warnMinFileCount   = 10
)

// skipFingerprintDir 指纹遍历（FileCount）跳过的目录：与工作区检索同一张忽略表，
// 另加 .cadt（应用自己的状态目录，AI 写它属于正常行为，不计入破坏判定）。
func skipFingerprintDir(name string) bool {
	lower := strings.ToLower(name)
	return lower == ".git" || lower == ".cadt" || search.SkipDir(name)
}

// Take 对工作区根取一次结构指纹。root 不存在时返回零值指纹（RootEntries=0）。
// 调用方（前端）负责节流：同一会话 3 秒内不重复取。
func Take(root string) Fingerprint {
	fp := Fingerprint{FileCount: -1, Markers: map[string]bool{}}
	if root == "" {
		return fp
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return fp
	}
	fp.RootEntries = len(entries)
	for _, e := range entries {
		if e.IsDir() {
			fp.Depth1Dirs++
		}
	}
	for _, m := range fingerprintMarkers {
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(m))); err == nil {
			fp.Markers[m] = true
		}
	}
	deadline := time.Now().Add(fingerprintWallBudget)
	count := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // 读不到的条目跳过（权限 / 竞态删除），不中断
		}
		if d.IsDir() {
			if path != root && skipFingerprintDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		count++
		if count > fingerprintEntryBudget || time.Now().After(deadline) {
			return errStopWalk
		}
		return nil
	})
	switch {
	case err == nil:
		fp.FileCount = count
	case err == errStopWalk:
		fp.Sampled = true // 超预算：FileCount 保持 -1，RootEntries / Markers 照判
	default:
		// 根不可读等异常：FileCount 保持 -1（未测），不算采样降级
	}
	return fp
}

// errStopWalk 预算耗尽的哨兵错误（不外泄）。
var errStopWalk = fmt.Errorf("fingerprint budget exhausted")

// Verdict 判定结论（跨绑定返回用）。
type Verdict struct {
	Level  string `json:"level"`  // critical / warn / ""
	Reason string `json:"reason"`
}

// Compare 对比前后指纹返回判定（Wails 绑定用；判定单一来源在 Go，前端不复制阈值）。
func Compare(before, after Fingerprint) Verdict {
	level, reason := ShouldWarn(before, after)
	return Verdict{Level: level, Reason: reason}
}

// ShouldWarn 对比前后指纹，返回告警级别与原因。only 明显的「消失」才告警，避免噪音。
// 级别：critical（停会话级）/ warn（黄条提示）/ ""（无事）。
func ShouldWarn(before, after Fingerprint) (level, reason string) {
	// 整仓清空：本次事故形态（根条目 98 → 1，只剩重建的 .cadt）。
	if before.RootEntries >= warnMinRootEntries && after.RootEntries <= 1 {
		return "critical", fmt.Sprintf("整仓顶层条目被清空（%d → %d）", before.RootEntries, after.RootEntries)
	}
	// 关键标记消失：.git / go.mod / package.json 在 before 存在、after 没了。
	for _, m := range fingerprintMarkers {
		if before.Markers[m] && !after.Markers[m] {
			return "critical", fmt.Sprintf("关键标记消失：%s", m)
		}
	}
	// 顶层少了四成以上（方案 §5.4：after < before * 0.6）。
	if before.RootEntries >= warnMinRootEntries && after.RootEntries*10 < before.RootEntries*6 {
		return "warn", fmt.Sprintf("顶层条目大幅减少（%d → %d）", before.RootEntries, after.RootEntries)
	}
	// 文件数腰斩：任一侧未测（-1 / Sampled）即跳过。
	if before.FileCount >= 0 && after.FileCount >= 0 &&
		before.FileCount >= warnMinFileCount && after.FileCount*2 < before.FileCount {
		return "warn", fmt.Sprintf("全树文件数腰斩（%d → %d）", before.FileCount, after.FileCount)
	}
	return "", ""
}
