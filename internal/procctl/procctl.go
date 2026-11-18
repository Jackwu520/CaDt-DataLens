// Package procctl 运行通道与命令桥共用的进程注册、取消与参数校验。
//
// run（F5 运行代码）与 cmdbridge（插件命令 / git 浅集成 / AI 终端命令）共用同一张
// 取消表，因此这里的上限与 id 冲突检查是全局口径：两边加起来不超过 MaxRunning。
// 取消一律杀整棵进程树——Git for Windows 的 bash wrapper 只杀父进程等于没杀。
package procctl

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"datalens/internal/executil"
)

// MaxRunning 同时运行的流式进程上限（run 与命令桥共用一张取消表）。
const MaxRunning = 16

var (
	mu      sync.Mutex
	cancels = map[string]context.CancelFunc{}
)

// Register 把一个可取消的进程登记进共享取消表；id 重复或达到上限时返回错误。
func Register(id string, cancel context.CancelFunc) error {
	mu.Lock()
	defer mu.Unlock()
	if _, exists := cancels[id]; exists {
		return fmt.Errorf("任务 id %q 已在运行", id)
	}
	if len(cancels) >= MaxRunning {
		return fmt.Errorf("同时运行的任务超过上限 %d", MaxRunning)
	}
	cancels[id] = cancel
	return nil
}

// Unregister 从取消表移除（进程自然结束或调用方自行取消后）。
func Unregister(id string) {
	mu.Lock()
	delete(cancels, id)
	mu.Unlock()
}

// Stop 取消并移除；返回该 id 是否正在运行。不存在时静默成功。
func Stop(id string) bool {
	mu.Lock()
	cancel, ok := cancels[id]
	delete(cancels, id)
	mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// ApplyCancel 配置取消行为：context 到期/取消时杀整棵进程树，
// WaitDelay 兜底强制关闭管道，保证超时与停止语义在 wrapper shell 下依然成立。
func ApplyCancel(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return executil.KillProcessTree(cmd) }
	cmd.WaitDelay = 3 * time.Second
}

// NormalizeArgs 校验可执行文件与参数个数。
func NormalizeArgs(exe string, args []string) error {
	if strings.TrimSpace(exe) == "" {
		return fmt.Errorf("exe 不能为空")
	}
	if len(args) > 128 {
		return fmt.Errorf("参数个数超过上限 128")
	}
	return nil
}

// WorkDir 归一工作目录：空值表示继承当前目录。
func WorkDir(cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		return "", nil
	}
	return cwd, nil
}
