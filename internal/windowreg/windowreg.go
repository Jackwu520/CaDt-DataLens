// Package windowreg：多窗口进程注册表（跨工作区会话复用的「该工作区已开在哪」账本）。
//
// 磁盘布局（应用数据根/windows/）：
//   <windowId>/meta.json   —— 窗口元数据（atomfile 原子写）
//   <windowId>/inbox/      —— 跨窗口投递信箱（别的窗口写请求进来）
//   <windowId>.lease       —— resourcelease 独占锁（在目录之外）：进程活着就持有，
//                             崩溃后内核自动释放，Sweep 按它判残留；锁文件不随 Release 删除，
//                             由本包 Close/Sweep 负责清理配对文件。
//
// 纯引擎：不 import main、不碰 App、不发 Wails 事件——信箱变化的通知走
// internal/watch 的 resource-changed（根壳挂监听），存活判定走 resourcelease。
// 方案见 docs/unfinished-plans/multi-window-session-reuse.md。
package windowreg

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/resourcelease"
)

// 孤儿 lease（有锁文件无目录）的兜底清理年龄：可能是正在注册中的窗口，新的不许动。
const orphanLeaseMaxAge = 24 * time.Hour

// Entry 是一个窗口在注册表里的元数据，即 meta.json 的内容。
// 浮窗 / 调试控制台窗口在根壳 ensureWindowReg 就不注册（比方案初版的 floating
// 标记位更严），因此没有 floating 字段——登记了的窗口都是可匹配候选。
type Entry struct {
	WindowID  string `json:"windowId"`
	PID       int    `json:"pid"`
	Workspace string `json:"workspace"` // 归一化后写入；空 = 不参与匹配
	StartedAt int64  `json:"startedAt"`
	Heartbeat int64  `json:"heartbeat"`
}

// Registry 是本窗口在注册表中的句柄：持有租约、维护 meta 目录、驱动心跳。
type Registry struct {
	mu        sync.Mutex
	root      string // <应用数据>/windows
	dir       string // <root>/<windowId>
	leasePath string
	lease     *resourcelease.Lease
	entry     Entry
	stop      chan struct{}
	stopped   sync.Once
}

// Register 创建本窗口的注册条目。内部顺序固定为「先 Acquire 租约、后建目录写 meta」，
// 防止别的窗口恰好 Sweep 时在「目录已建、租约未取」的窗口期把本窗口误判为残留。
func Register(root string, entry Entry) (*Registry, error) {
	if entry.WindowID == "" {
		entry.WindowID = newWindowID()
	}
	if entry.PID <= 0 {
		entry.PID = os.Getpid()
	}
	now := time.Now().UnixMilli()
	if entry.StartedAt <= 0 {
		entry.StartedAt = now
	}
	if entry.Heartbeat <= 0 {
		entry.Heartbeat = now
	}
	// workspace 在写入前归一（与前端 sessionPathKey 同口径），保证跨进程比较同键。
	entry.Workspace = NormalizeWorkspace(entry.Workspace)

	leasePath := filepath.Join(root, entry.WindowID+".lease")
	lease, err := resourcelease.Acquire(leasePath, resourcelease.Owner{
		PID:   entry.PID,
		Label: "window:" + entry.WindowID,
	})
	if err != nil {
		return nil, fmt.Errorf("窗口注册表租约获取失败 %s: %w", entry.WindowID, err)
	}

	dir := filepath.Join(root, entry.WindowID)
	if err := os.MkdirAll(filepath.Join(dir, "inbox"), 0o755); err != nil {
		lease.Release()
		return nil, fmt.Errorf("窗口注册表目录创建失败: %w", err)
	}
	reg := &Registry{
		root:      root,
		dir:       dir,
		leasePath: leasePath,
		lease:     lease,
		entry:     entry,
		stop:      make(chan struct{}),
	}
	if err := reg.writeMeta(); err != nil {
		lease.Release()
		_ = os.RemoveAll(dir) // 与「失败不留痕」口径一致：不留无主目录等 Sweep
		return nil, err
	}
	return reg, nil
}

// Root 返回注册表根目录（信箱监听与测试用）。
func (r *Registry) Root() string { return r.root }

// WindowID 返回本窗口 id。
func (r *Registry) WindowID() string { return r.entry.WindowID }

// InboxDir 返回本窗口的信箱目录（watch 监听入口）。
func (r *Registry) InboxDir() string { return filepath.Join(r.dir, "inbox") }

// Update 改写本窗口的工作区（打开/关闭/切换文件夹时调用），顺带刷新 heartbeat。
func (r *Registry) Update(workspace string) error {
	r.mu.Lock()
	r.entry.Workspace = NormalizeWorkspace(workspace)
	r.entry.Heartbeat = time.Now().UnixMilli()
	err := r.writeMetaLocked()
	r.mu.Unlock()
	return err
}

// Touch 刷新 heartbeat。
func (r *Registry) Touch() error {
	r.mu.Lock()
	r.entry.Heartbeat = time.Now().UnixMilli()
	err := r.writeMetaLocked()
	r.mu.Unlock()
	return err
}

// StartHeartbeat 启动后台心跳 goroutine；Close 时停止。
// meta 写失败时尝试重建目录自愈（目录被外部清掉的场景）。
func (r *Registry) StartHeartbeat(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-ticker.C:
				if err := r.Touch(); err != nil {
					_ = os.MkdirAll(r.dir, 0o755)
					_ = r.Touch()
				}
			}
		}
	}()
}

// Close 释放租约并删除本窗口的注册痕迹。顺序固定：停心跳 → release 租约
// （Windows 上持锁句柄未释放时删除文件会失败）→ 删目录 → 删配对 lease 文件。
// 各步失败不阻断（Sweep 会兜底），幂等可重复调用。
func (r *Registry) Close() {
	r.stopped.Do(func() {
		close(r.stop)
		r.lease.Release()
		_ = os.RemoveAll(r.dir)
		_ = os.Remove(r.leasePath)
		_ = os.Remove(r.leasePath + ".owner")
	})
}

// writeMeta 走锁内路径的包装（Register 时未持 mu）。
func (r *Registry) writeMeta() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writeMetaLocked()
}

func (r *Registry) writeMetaLocked() error {
	raw, err := json.Marshal(r.entry)
	if err != nil {
		return fmt.Errorf("窗口元数据序列化失败: %w", err)
	}
	if err := atomfile.WriteFileAtomic(filepath.Join(r.dir, "meta.json"), raw); err != nil {
		return fmt.Errorf("窗口元数据写入失败: %w", err)
	}
	return nil
}

// NormalizeWorkspace 与前端 sessionPathKey（shell/session-restore.js）同口径：
// 反斜杠转正斜杠、去尾部连续斜杠、转小写。跨进程/跨端的路径比较必须用同一键。
// 「同口径」以盘符与常规（中文/ASCII）路径为准——两端的 Unicode 大小写映射在
// 个别特殊字符上有差异（如 İ），对 Windows 路径比较无实际影响。
func NormalizeWorkspace(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	for len(p) > 0 && p[len(p)-1] == '/' {
		p = p[:len(p)-1]
	}
	return strings.ToLower(p)
}

// newWindowID 生成 pid-随机后缀 形式的窗口 id；不用裸 pid（会复用）。
func newWindowID() string {
	return fmt.Sprintf("%d-%s", os.Getpid(), randHex(4))
}

// newReqID 生成请求 id：随机 hex，由 Go 侧生成（前端可控的 reqId 含路径分隔符
// 可借文件名写到任意路径，见方案 §6 安全条目）。
func newReqID() string { return randHex(8) }

// validReqID 校验请求 id 是小写 hex token（防路径分隔符/.. 注入）。
func validReqID(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func randHex(nBytes int) string {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 失败在 Windows 上基本不可能；退化用纳秒时间戳。
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
