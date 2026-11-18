// Package integration Windows 文件关联、右键菜单与 PATH 集成。
//
// 只做注册表与用户级 PATH 的读写，不改系统级设置、不需要管理员权限；
// 平台实现在 integration_windows.go，其它平台是空实现。
package integration

// Registrar 系统集成引擎（无状态）。
type Registrar struct{}
