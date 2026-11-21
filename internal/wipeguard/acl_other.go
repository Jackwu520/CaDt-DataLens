//go:build !windows

// acl_other.go：非 Windows 平台暂不套防删 ACL（跨平台评估见 docs/reports/cross-platform.md）。
// 目录落在工作区之外，工作区级删除波及不到；防线自防暂只有 Windows 实现。
package wipeguard

// protectRoot 非 Windows 平台是 no-op（保持签名一致，桩必须能编译）。
func protectRoot(string) error { return nil }

// unprotectRoot 非 Windows 平台是 no-op。
func unprotectRoot(string) error { return nil }
