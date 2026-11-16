//go:build !windows

package executil

import "os/exec"

func HideCommandWindow(cmd *exec.Cmd) {}
