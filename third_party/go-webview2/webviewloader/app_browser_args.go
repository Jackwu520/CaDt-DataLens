// CaDt-DataLens 本地补丁（相对上游 go-webview2 v1.0.22）。
//
// 上游会在 init() 与每次创建 WebView2 环境时调用 preventEnvAndRegistryOverrides()，
// 把 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 强制置空（或重写成宿主传入的 args），
// 用来屏蔽外部环境变量 / 注册表覆盖。副作用是：宿主在 main() 里 os.Setenv 的
// Chromium 参数根本到不了浏览器进程。
//
// 这里开一个显式注入点：宿主在 wails.Run 之前设置 ExtraBrowserArguments，
// 由两处一并合并进去：
//   1. environmentOptions.AdditionalBrowserArguments()（COM API，最可靠的通道）
//   2. preventEnvAndRegistryOverrides()（环境变量，兼容 native_webview2loader 路径）
// ExtraBrowserArguments 为空时，所有行为与上游完全一致。
//
// 升级上游 go-webview2 时，只需重新套用这一个新增文件 + 三处调用点
// （env_create_options.go / env_create.go / native_module.go）。
package webviewloader

import "strings"

// ExtraBrowserArguments 由宿主应用在创建 WebView2 环境之前设置。
var ExtraBrowserArguments string

// mergeBrowserArguments 把注入参数合并进 base。若两边都有 --disable-features=，
// 把 feature 并到同一个开关里：Chromium 虽会合并重复的 feature 开关，
// 但保持单一开关更稳妥，也避免覆盖上游（Wails）已有的禁用项。
func mergeBrowserArguments(base string) string {
	base = strings.TrimSpace(base)
	extra := strings.TrimSpace(ExtraBrowserArguments)
	if extra == "" {
		return base
	}

	const flag = "--disable-features="
	if strings.HasPrefix(extra, flag) {
		features := strings.TrimPrefix(extra, flag)
		if i := strings.Index(base, flag); i >= 0 {
			j := i + len(flag)
			k := j
			for k < len(base) && base[k] != ' ' {
				k++
			}
			existing := base[j:k]
			have := map[string]bool{}
			for _, f := range strings.Split(existing, ",") {
				have[f] = true
			}
			for _, f := range strings.Split(features, ",") {
				if f != "" && !have[f] {
					existing += "," + f
					have[f] = true
				}
			}
			return base[:j] + existing + base[k:]
		}
	}

	if base == "" {
		return extra
	}
	if strings.Contains(base, extra) {
		return base
	}
	return base + " " + extra
}
