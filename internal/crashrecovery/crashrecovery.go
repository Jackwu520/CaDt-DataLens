// Package crashrecovery 崩溃检测标记：GUI 会话启动时写下「活着」标记，优雅退出摘除；
// 异常退出（panic / 强杀 / 断电）时标记遗留，下次启动据此执行崩溃自愈清理。
// 壳接线（清理动作）在仓库根 crashrecovery_app.go；背景事故见
// docs/reports/incident-2026-11-23-search-panic-crash.md。
//
// 标记按会话一文件放在 appdata/session-alive/ 下：多实例（不同 exe 副本）与调试控制台等
// 辅助进程各有各的文件，互不覆盖、互不误删。只做检测，不做清理——清理要动 storage 与
// 工作区，留在壳层。
package crashrecovery

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"datalens/internal/appdata"
)

// markerDirName 存活标记目录（appdata 下）。
const markerDirName = "session-alive"

// markerFreshWindow 刚写下的标记可能还没写完（WriteFile 非原子），
// 这么新的残缺文件不判定为垃圾，留给下一轮。
const markerFreshWindow = time.Minute

// Marker 一个 GUI 会话的存活标记。
type Marker struct {
	PID       int    `json:"pid"`
	Exe       string `json:"exe"`
	Mode      string `json:"mode"`      // main / float / debug
	StartedAt string `json:"startedAt"` // RFC3339Nano
	Log       string `json:"log"`       // 本次会话运行日志路径，排障用
}

// ownSession 本会话标记的身份（MarkExited 只摘自己写的文件）。
var ownSession struct {
	pid       int
	startedAt string
}

// processAliveFn 存活探针，测试可替换。
var processAliveFn = processAlive

// MarkAlive 登记本次 GUI 会话存活。appdata 不可用或写失败时返回错误，
// 调用方降级处理（无标记 = 该次崩溃不会触发自愈，功能不受影响）。
func MarkAlive(mode, logPath string) error {
	return markAliveAt(appdata.Root(), mode, logPath)
}

// MarkExited 优雅退出：只摘本会话自己的标记；别的实例的文件不动。
// MarkAlive 未成功时无事可做。
func MarkExited() {
	if ownSession.pid == 0 || ownSession.startedAt == "" {
		return
	}
	markExitedAt(appdata.Root(), ownSession.pid, ownSession.startedAt)
}

// TakeAbandoned 启动时清点遗留标记：属主进程已不在的按「上次异常退出」取走
// （删文件并返回内容），属主还活着的是另一实例在跑，原样保留。
// 幂等；多实例并发启动时最多一个实例拿到同一标记。
func TakeAbandoned() (*Marker, bool) {
	return takeAbandonedAt(appdata.Root())
}

func markAliveAt(root, mode, logPath string) error {
	if root == "" {
		return errors.New("crashrecovery: appdata 根不可用")
	}
	dir := markerDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	startedAt := time.Now().Format(time.RFC3339Nano)
	m := Marker{
		PID:       os.Getpid(),
		Exe:       os.Args[0],
		Mode:      mode,
		StartedAt: startedAt,
		Log:       logPath,
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	// 文件名里的时刻用纯数字（RFC3339 带冒号，Windows 文件名不允许）
	name := fmt.Sprintf("pid-%d-%d.json", m.PID, time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		return err
	}
	ownSession.pid = m.PID
	ownSession.startedAt = startedAt
	return nil
}

func markExitedAt(root string, pid int, startedAt string) {
	entries, err := os.ReadDir(markerDir(root))
	if err != nil {
		return
	}
	for _, e := range entries {
		m, ok := readMarker(filepath.Join(markerDir(root), e.Name()))
		if !ok || m.PID != pid || m.StartedAt != startedAt {
			continue
		}
		_ = os.Remove(filepath.Join(markerDir(root), e.Name()))
	}
}

func takeAbandonedAt(root string) (*Marker, bool) {
	if root == "" {
		return nil, false
	}
	dir := markerDir(root)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, false
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		m, ok := readMarker(p)
		if !ok {
			// 残缺文件：刚写下的留给写它的进程，超时的顺手清掉避免永久堆积
			if freshEnough(p) {
				continue
			}
			_ = os.Remove(p)
			continue
		}
		if processAliveFn(m.PID) {
			continue
		}
		if err := os.Remove(p); err != nil {
			continue
		}
		return &m, true
	}
	return nil, false
}

func markerDir(root string) string {
	return filepath.Join(root, markerDirName)
}

func readMarker(path string) (Marker, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Marker{}, false
	}
	var m Marker
	if json.Unmarshal(data, &m) != nil || m.PID <= 0 {
		return Marker{}, false
	}
	return m, true
}

// freshEnough 文件是否新到「可能还在写」——残缺但新鲜的标记不当垃圾清。
func freshEnough(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) < markerFreshWindow
}
