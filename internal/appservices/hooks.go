package appservices

// 宿主注入（main 包的根壳在 init 中接线）。

// Logf 诊断日志（main/logging.go 的 writeAppLog）。
var Logf func(level, format string, args ...any)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
