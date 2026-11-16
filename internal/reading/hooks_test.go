package reading

// 测试环境没有 main 包的预览资源注册表：给一个稳定 token 即可。
func init() {
	RegisterPreviewRoot = func(string) (string, error) { return "test-preview-token", nil }
}
