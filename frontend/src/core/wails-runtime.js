// wails-runtime.js：Wails v3 运行时适配层。
//
// v2 用全局 window.runtime + window.go.main.App；v3 提供 ES module /wails/runtime.js，
// 且不再注入全局绑定对象。这里做三件事，让 main.js 与各域模块保持既有调用形式：
//   1. 动态加载 /wails/runtime.js（@vite-ignore：这是运行期由 app 资产服务器提供的 URL，
//      不能在 Vite 构建期解析；浏览器直开 mock 调试时 404 → 返回 null，调用方走 mock 分支）；
//   2. 把 v3 的 Events/Window/Application/Browser 映射成 v2 runtime 的同名方法；
//   3. 用 Call.ByName 生成 backend Proxy（main.App.<Method>），951 处 backend.XXX 零改动。

let runtimePromise = null;

// runtimeURL 用变量包一层：Rollup 对字符串字面量的动态 import 仍会尝试解析，
// 改成变量 + @vite-ignore 才会原样保留到运行期（/wails/runtime.js 由 app 提供）。
const runtimeURL = '/wails/runtime.js';

// loadWailsRuntime 加载 app 内置运行时；非 Wails 环境（浏览器 mock 调试）返回 null。
export function loadWailsRuntime() {
    if (!runtimePromise) {
        runtimePromise = import(/* @vite-ignore */ runtimeURL).catch(() => null);
    }
    return runtimePromise;
}

// createRuntimeAdapter 把 v3 runtime 命名空间包装成 v2 兼容面（rt.* 的调用点不动）。
export function createRuntimeAdapter(runtime) {
    if (!runtime) return null;
    const {Events, Window, Application, Browser} = runtime;
    return {
        // v2 的 EventsOn 回调直接收 payload；v3 给 WailsEvent{name,data,sender}。
        EventsOn(name, cb) {
            return Events.On(name, (ev) => cb(ev ? ev.data : undefined, ev));
        },
        EventsOff(name) {
            Events.Off(name);
        },
        EventsEmit(name, data) {
            return Events.Emit(name, data);
        },
        BrowserOpenURL(url) {
            return Browser.OpenURL(url);
        },
        WindowSetSize(width, height) {
            return Window.SetSize(width, height);
        },
        WindowSetMinSize(width, height) {
            return Window.SetMinSize(width, height);
        },
        WindowGetSize() {
            return Window.Size();
        },
        WindowIsFullscreen() {
            return Window.IsFullscreen();
        },
        WindowFullscreen() {
            return Window.Fullscreen();
        },
        WindowUnfullscreen() {
            return Window.Unfullscreen();
        },
        WindowClose() {
            return Window.Close();
        },
        WindowMinimise() {
            return Window.Minimise();
        },
        WindowToggleMaximise() {
            return Window.ToggleMaximise();
        },
        WindowIsMaximised() {
            return Window.IsMaximised();
        },
        WindowSetTitle(title) {
            return Window.SetTitle(title);
        },
        WindowSetAlwaysOnTop(onTop) {
            return Window.SetAlwaysOnTop(!!onTop);
        },
        Quit() {
            return Application.Quit();
        },
        // v3 文件拖放需要页面里有 [data-file-drop-target]（index.html 的 body 已加），
        // 事件名 common:WindowFilesDropped，载荷 {filenames,x,y,elementDetails}。
        OnFileDrop(cb) {
            return Events.On('common:WindowFilesDropped', (ev) => {
                const d = (ev && ev.data) || {};
                cb(d.x, d.y, d.filenames || []);
            });
        },
    };
}

// createBackendProxy 把 v3 绑定调用包装成 v2 的 backend 对象形状。
// FQN 规则见 v3 bindings.go：<packagePath>.<TypeName>.<MethodName>，
// 根包 App 即 main.App.<Method>。
export function createBackendProxy(Call, packagePrefix = 'main.App') {
    if (!Call || typeof Call.ByName !== 'function') return null;
    return new Proxy({}, {
        get(_target, prop) {
            if (typeof prop !== 'string') return undefined;
            // 防止 Promise 链/JSON 序列化把 Proxy 当 thenable 或普通对象展开。
            if (prop === 'then' || prop === 'toJSON' || prop === 'constructor' || prop === 'inspect') return undefined;
            return (...args) => Call.ByName(`${packagePrefix}.${prop}`, ...args);
        },
    });
}
