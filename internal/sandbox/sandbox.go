// Package sandbox 给子进程圈定文件写效应（Windows 受限令牌 + ACL）。
//
// 语义对齐 dsh（deepseek-harness）的 sandbox 子系统：
//   - read-only：不授权任何写根，子进程只能读；
//   - workspace-write：只允许写「工作区根」与「本次执行的私有 temp」；
//   - danger-full-access：不本包的事——调用方直接裸跑，不创建 Sandbox。
//
// 本包只管写效应。读、网络、进程可见性都不在范围内，enforcement 如实标 partial。
package sandbox

import (
	"errors"
	"fmt"
	"strings"
)

// Mode 是文件效应档位（词表与 dsh 一致，便于文档互认）。
type Mode string

const (
	ReadOnly         Mode = "read-only"
	WorkspaceWrite   Mode = "workspace-write"
	DangerFullAccess Mode = "danger-full-access"
)

// EnforcementPartial 是本后端如实的完整度自述：硬链接别名可绕过能力 SID、
// 读不受 ACL 限制、被别的 AppContainer 打过包 SID 的树读不了。
const EnforcementPartial = "partial"

// GrantState 描述一个目录上留下的沙箱授权痕迹。
//
// workspace-write 会在写根上留下三样东西（见方案 §3.3）：能力 SID 的 allow ACE、
// Everyone 的 FILE_DELETE_CHILD deny、Low 完整性标签。前两者随目录存在而存在，
// 标签更是永久的——`icacls` 也撤不掉（S-1-4-x-y 是派生 SID，解析失败报 1332），
// 只能走本包的 Revoke。
type GrantState struct {
	Root string `json:"root"`
	// WorkspaceSID 是本次派生出来的能力 SID（S-1-4-x-y）。同一目录永远是同一个值。
	WorkspaceSID string `json:"workspaceSid"`
	// Granted 表示能力 SID 的写权 ACE 还在。
	Granted bool `json:"granted"`
	// DenyPresent 表示 Everyone 的 FILE_DELETE_CHILD deny 还在。
	DenyPresent bool `json:"denyPresent"`
	// Labeled 表示目录上还有 Low 完整性标签。
	Labeled bool `json:"labeled"`
}

// Residue 报告是否还有任何痕迹需要清理。
func (g GrantState) Residue() bool {
	return g.Granted || g.DenyPresent || g.Labeled
}

// ErrUnavailable 表示沙箱不可用（受限令牌、ACL 或 Job 创建失败）。
// 调用方必须据此拒绝执行，**不得**降级裸跑。
var ErrUnavailable = errors.New("sandbox: 沙箱不可用")

// ErrDangerFullAccess 表示该档位不需要也不允许创建沙箱。
var ErrDangerFullAccess = errors.New("sandbox: danger-full-access 由调用方直接执行，不创建沙箱")

// Policy 是一次执行的完整文件效应策略。
type Policy struct {
	// Mode 决定授权形态。
	Mode Mode
	// WorkspaceRoot 是 workspace-write 的唯一写根（绝对路径）；其它档位忽略。
	WorkspaceRoot string
	// TempDir 是本次执行专用的私有临时目录（绝对路径）；空表示不授权临时目录。
	// workspace-write 下它必须与 WorkspaceRoot 互不包含。
	TempDir string
	// ShareConsole 让子进程继承宿主的（隐藏）控制台，而不是 DETACHED_PROCESS。
	//
	// 两种启动形态都是实测结论（方案 §8.1）：受限令牌下 CREATE_NO_WINDOW /
	// CREATE_NEW_CONSOLE 一律 0xC0000142，只能「不建控制台」或「继承已存在的控制台」。
	// 但 PowerShell 5.1 在无控制台时**静默退出、什么都不执行**，所以跑 PowerShell
	// 必须走这条；cmd.exe 两种都行。宿主没有控制台时本包会 AllocConsole 后立刻隐藏。
	ShareConsole bool
}

// Confined 报告该策略是否需要沙箱。
func (p Policy) Confined() bool {
	return p.Mode == ReadOnly || p.Mode == WorkspaceWrite
}

// Validate 校验策略本身（与平台无关的部分）。
func (p Policy) Validate() error {
	switch p.Mode {
	case ReadOnly:
		if strings.TrimSpace(p.TempDir) != "" {
			return fmt.Errorf("sandbox: read-only 不接受 temp 目录")
		}
		return nil
	case WorkspaceWrite:
		if strings.TrimSpace(p.WorkspaceRoot) == "" {
			return fmt.Errorf("sandbox: workspace-write 需要 workspaceRoot")
		}
		return nil
	case DangerFullAccess:
		return ErrDangerFullAccess
	default:
		return fmt.Errorf("sandbox: 未知档位 %q", string(p.Mode))
	}
}

// ParseMode 解析档位字符串（前端传来的值不信任，非法值必须报错）。
func ParseMode(raw string) (Mode, error) {
	switch Mode(strings.TrimSpace(raw)) {
	case ReadOnly:
		return ReadOnly, nil
	case WorkspaceWrite:
		return WorkspaceWrite, nil
	case DangerFullAccess:
		return DangerFullAccess, nil
	default:
		return "", fmt.Errorf("sandbox: 未知档位 %q", raw)
	}
}
