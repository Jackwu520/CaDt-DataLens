//go:build !windows

// 非 Windows 上不存在受限令牌，保留空入口让 `go build ./...` 与交叉编译守卫通过。
package main

func main() {}
