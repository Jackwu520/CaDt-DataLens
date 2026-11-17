package cmdbridge

import (
	"strings"

	"datalens/internal/chardec"
)

// 沙箱拒绝的特征串：命令本身失败 + stderr 命中这些才算「沙箱拒绝」，否则按普通失败记。
// 宁可漏判（记成 error）也不要误判——把「工具链崩了」记成「沙箱拒绝」会误导排查。
var sandboxDenialSignatures = []string{
	"拒绝访问",
	"没有权限",
	"Access is denied",
	"Access denied",
	"is denied", // PowerShell: "Access to the path '…' is denied."
	"ACCESS_DENIED",
	"UnauthorizedAccess",
	"Permission denied",
}

// detectSandboxDenial 判断一次受限执行的失败是否由 ACL 拒绝造成。
// 子进程 stderr 可能是 UTF-8（PowerShell）或 GBK（cmd / 原生程序），统一按自动探测解码。
func detectSandboxDenial(code int, stderr string) bool {
	if code == 0 || strings.TrimSpace(stderr) == "" {
		return false
	}
	text := stderr
	if decoded, _, err := chardec.DecodeBytes([]byte(stderr), ""); err == nil {
		text = decoded
	}
	for _, sig := range sandboxDenialSignatures {
		if strings.Contains(text, sig) {
			return true
		}
	}
	return false
}
