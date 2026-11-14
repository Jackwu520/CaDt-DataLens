package main

// 补丁（.patch / .diff）解析、匹配规划、两阶段应用与撤销。
//
// 设计要点（详见 docs/finished-plans/ai-patch-approval.md）：
//   - 解析与应用全部在 Go 侧，AI 面板只是调用方之一，CLI 也能直接用；
//   - 匹配严格：上下文必须完整、位置必须唯一、同一文件位移必须全局一致；
//   - 预览即契约：预览时算定每个 hunk 的落点与基线哈希，应用时逐条复核；
//   - 两阶段：先全部预演（不写盘），再按 atomic / partial 模式提交；
//   - 备份是字节快照，撤销据此还原；写盘用 temp + rename，永不出现半截文件。

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"time"
)

const (
	patchMaxTextBytes = 2 << 20   // 外部 / CLI 补丁文本上限
	patchAIMaxBytes   = 256 << 10 // AI 单次提交上限（与 AI_WRITE_LIMIT 对齐）
	patchMaxFiles     = 200
	patchMaxHunks     = 500
	patchMaxFileBytes = 10 << 20 // 参与补丁的单文件上限（与只读阈值一致）
	patchOffsetLimit  = 200
	patchPlanTTL      = 30 * time.Minute
	patchRetainCount  = 50
	patchRetainDays   = 30
	patchKeepPatches  = 512 << 10 // index.jsonl 压缩阈值
)

// 错误码：给 UI 与模型共用，不要随意改名。
const (
	patchErrParse        = "PATCH_PARSE"
	patchErrEmpty        = "PATCH_EMPTY"
	patchErrLimit        = "PATCH_LIMIT"
	patchErrPathDenied   = "PATCH_PATH_DENIED"
	patchErrUnsupported  = "PATCH_UNSUPPORTED"
	patchErrHunkConflict = "PATCH_HUNK_CONFLICT"
	patchErrFileDrift    = "PATCH_FILE_DRIFT"
	patchErrUserDenied   = "PATCH_USER_DENIED"
	patchErrApplyIO      = "PATCH_APPLY_IO"
	patchErrRollback     = "PATCH_ROLLBACK_FAILED"
	patchErrBusy         = "PATCH_BUSY"
	patchErrFileLocked   = "PATCH_FILE_LOCKED"
	patchErrConcurrent   = "PATCH_CONCURRENT_MODIFIED"
	patchErrNoBackup     = "PATCH_NO_BACKUP"
	patchErrDiskFull     = "PATCH_DISK_FULL"
	patchErrNotRequested = "PATCH_NOT_REQUESTED"
	patchErrBackend      = "PATCH_BACKEND"
)

type patchError struct {
	Code   string `json:"code"`
	Msg    string `json:"message"`
	Detail string `json:"detail,omitempty"`
}

func (e *patchError) Error() string {
	if e.Detail != "" {
		return e.Code + ": " + e.Msg + "（" + e.Detail + "）"
	}
	return e.Code + ": " + e.Msg
}

func newPatchError(code, msg string) *patchError { return &patchError{Code: code, Msg: msg} }

func patchErrorOf(err error) *patchError {
	var pe *patchError
	if errors.As(err, &pe) {
		return pe
	}
	return &patchError{Code: patchErrBackend, Msg: err.Error()}
}

// ===== 对外结构（Wails 直接序列化给前端） =====

type PatchLineOut struct {
	T       string `json:"t"`
	Text    string `json:"text"`
	OldLine int    `json:"oldLine,omitempty"`
	NewLine int    `json:"newLine,omitempty"`
}

type PatchHunkOut struct {
	Index       int            `json:"index"`
	Header      string         `json:"header"`
	OldStart    int            `json:"oldStart"`
	OldCount    int            `json:"oldCount"`
	NewStart    int            `json:"newStart"`
	NewCount    int            `json:"newCount"`
	Status      string         `json:"status"`
	Reason      string         `json:"reason,omitempty"`
	ApplyAtLine int            `json:"applyAtLine"`
	Lines       []PatchLineOut `json:"lines"`
}

type PatchFileOut struct {
	RelPath  string         `json:"relPath"`
	Kind     string         `json:"kind"`
	Status   string         `json:"status"`
	Reason   string         `json:"reason,omitempty"`
	Added    int            `json:"added"`
	Removed  int            `json:"removed"`
	Offset   int            `json:"offset"`
	BaseHash string         `json:"baseHash,omitempty"`
	Enc      string         `json:"enc,omitempty"`
	EOL      string         `json:"eol,omitempty"`
	HasBOM   bool           `json:"hasBom,omitempty"`
	Hunks    []PatchHunkOut `json:"hunks"`
}

type PatchPreview struct {
	PlanID      string         `json:"planId"`
	PatchID     string         `json:"patchId"`
	Summary     string         `json:"summary"`
	Root        string         `json:"root"`
	PatchPath   string         `json:"patchPath"`
	Files       []PatchFileOut `json:"files"`
	Added       int            `json:"added"`
	Removed     int            `json:"removed"`
	Applicable  bool           `json:"applicable"`
	CreatedAt   int64          `json:"createdAt"`
	DefaultMode string         `json:"defaultMode"`
	External    bool           `json:"external,omitempty"`
	// 当前根下目标文件普遍缺失时，就近探测到的高命中率目录（仅建议，不自动切换）
	SuggestedRoot   string `json:"suggestedRoot,omitempty"`
	SuggestedHits   int    `json:"suggestedHits,omitempty"`
	SuggestedNeeded int    `json:"suggestedNeeded,omitempty"`
}

type PatchFileResult struct {
	RelPath string `json:"relPath"`
	Status  string `json:"status"` // applied | skipped | failed
	Reason  string `json:"reason,omitempty"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
}

type PatchApplyResult struct {
	OK         bool              `json:"ok"`
	Code       string            `json:"code,omitempty"`
	Message    string            `json:"message,omitempty"`
	Mode       string            `json:"mode"`
	Applied    int               `json:"applied"`
	Skipped    int               `json:"skipped"`
	Added      int               `json:"added"`
	Removed    int               `json:"removed"`
	Files      []PatchFileResult `json:"files"`
	RevertID   string            `json:"revertId,omitempty"`
	BackupDir  string            `json:"backupDir,omitempty"`
	Unrestored []string          `json:"unrestored,omitempty"`
}

type PatchRevertResult struct {
	OK      bool     `json:"ok"`
	Code    string   `json:"code,omitempty"`
	Message string   `json:"message,omitempty"`
	Files   []string `json:"files"`
}

type PatchMeta struct {
	ID         string   `json:"id"`
	Summary    string   `json:"summary"`
	FileName   string   `json:"fileName"`
	CreatedAt  int64    `json:"createdAt"`
	Root       string   `json:"root"`
	Files      []string `json:"files"`
	Added      int      `json:"added"`
	Removed    int      `json:"removed"`
	Status     string   `json:"status"`
	Mode       string   `json:"mode,omitempty"`
	AppliedAt  int64    `json:"appliedAt,omitempty"`
	RevertedAt int64    `json:"revertedAt,omitempty"`
	PatchPath  string   `json:"patchPath,omitempty"`
}

// ===== 内部模型 =====

type patchLine struct {
	T     byte // ' ' / '+' / '-'
	Text  string
	NoEOL bool
}

type patchHunk struct {
	OldStart, OldCount int
	NewStart, NewCount int
	Header             string
	LineNo             int
	Lines              []patchLine
}

type patchFile struct {
	RawOld, RawNew string
	RelPath        string
	Kind           string // modify | add | delete | unsupported
	UnsupportedMsg string
	Hunks          []patchHunk
	Added, Removed int
}

type patchDoc struct {
	Files          []patchFile
	Added, Removed int
}

var patchHunkRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func shortHash(h string) string {
	if len(h) > 8 {
		return h[:8]
	}
	return h
}
