//go:build !windows

package sandbox

import (
	"os/exec"
)

// 非 Windows 上不存在受限令牌：一律按「沙箱不可用」处理（fail-closed），
// 调用方据此拒绝执行命令，不允许静默裸跑。
type Sandbox struct {
	policy Policy
}

func New(p Policy) (*Sandbox, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return nil, ErrUnavailable
}

func (s *Sandbox) Enforcement() string { return EnforcementPartial }
func (s *Sandbox) TempDir() string     { return "" }
func (s *Sandbox) Configure(cmd *exec.Cmd) error {
	return ErrUnavailable
}
func (s *Sandbox) Env(base []string) []string {
	return base
}
func (s *Sandbox) Start(cmd *exec.Cmd) error { return ErrUnavailable }
func (s *Sandbox) Run(cmd *exec.Cmd) error   { return ErrUnavailable }
func (s *Sandbox) Close() error              { return nil }

// Scan / Revoke 只在 Windows 上有意义（其它平台没有受限令牌与 ACL 授权）。
func Scan(root string) (*GrantState, error) {
	return nil, ErrUnavailable
}

func Revoke(root string) (*GrantState, error) {
	return nil, ErrUnavailable
}
