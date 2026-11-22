//go:build !windows

package desktopmcp

// install_other.go：非 Windows 平台桩（桌面控制是 Win32 / UIA 能力，别处不可用）。
// 必须能通过交叉编译，见 AGENTS.md 的「_other.go 桩同样要能编译」。

import (
	"context"
	"errors"
)

func installPlatform(ctx context.Context, wheelPath string, emit func(Progress)) ([]string, error) {
	return nil, errors.New("桌面控制只支持 Windows")
}
