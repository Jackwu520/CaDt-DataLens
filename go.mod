module datalens

go 1.26.0

require (
	git.sr.ht/~jackmordaunt/go-toast/v2 v2.0.3
	github.com/aymanbagabas/go-pty v0.2.3
	github.com/wailsapp/go-webview2 v1.0.22
	github.com/wailsapp/wails/v3 v3.1.0
	golang.org/x/sys v0.49.0
	golang.org/x/text v0.43.0
	modernc.org/sqlite v1.62.0
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/coder/websocket v1.8.14 // indirect
	github.com/creack/pty v1.1.24 // indirect
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/ebitengine/purego v0.11.1 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/go-sql-driver/mysql v1.10.2 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jchv/go-winloader v0.0.0-20210711035445-715c2860da7e // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.1.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/u-root/u-root v0.16.0 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/term v0.46.0 // indirect
	modernc.org/libc v1.80.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)

// go-webview2 本地补丁：开出 Chromium 参数注入点（禁用 WebView2 原生迷你菜单）。
// 相对上游 v1.0.22 只新增 webviewloader/app_browser_args.go + 三处调用点；升级依赖需重新套用。
replace github.com/wailsapp/go-webview2 => ./third_party/go-webview2
