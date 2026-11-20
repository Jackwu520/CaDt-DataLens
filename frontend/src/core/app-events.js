// app-events.js：多窗口事件桥接层（所有 EventsOn 的唯一入口）。
//
// v3 的 window.EmitEvent 会广播到所有窗口（wails#6608），多窗口下控制命令会被
// 每个窗口各执行一次、高频流会跨窗空转。这里给订阅加范围过滤，P1 单窗口行为不变，
// P2 多窗口时按 sender / 工作区 / ID 归属自然隔离。
//
// 约定：域模块不再直接调 rt.EventsOn；需要订阅时经 main.js 暴露的
// window.__appEvents 或依赖注入的桥实例（守卫测试强制）。

import {acceptWorkspace, EVENT_SCOPES} from './event-scope.js';

// createAppEventBridge 创建桥。
//   rt          v2 兼容 runtime（真实适配器或 mockRt），只需 EventsOn
//   windowName  本窗口名（v3 Window.Name()）；为空 = 不按 sender 过滤（浏览器 mock 调试）
//   logf        调试日志（丢弃/异常）
export function createAppEventBridge({rt, windowName = null, logf = () => {}} = {}) {
    const handlers = new Map(); // name -> [{ cb, accept }]
    const subscribed = new Set();

    function subscribe(name) {
        if (subscribed.has(name)) return;
        if (!rt || typeof rt.EventsOn !== 'function') return;
        subscribed.add(name);
        rt.EventsOn(name, (payload, ev) => {
            const list = handlers.get(name);
            if (!list || !list.length) return;
            for (const h of list.slice()) {
                try {
                    if (!h.accept(payload, ev)) continue;
                    h.cb(payload, ev);
                } catch (err) {
                    logf(`事件处理失败 ${name}：${(err && err.message) || err}`);
                }
            }
        });
    }

    // add 注册处理器并返回解绑函数（解绑只摘处理器；runtime 订阅保留，避免频繁 Off/On）。
    function add(name, cb, accept) {
        if (!(name in EVENT_SCOPES)) logf(`事件未在 event-scope 登记：${name}`);
        let list = handlers.get(name);
        if (!list) handlers.set(name, (list = []));
        const entry = {cb, accept};
        list.push(entry);
        subscribe(name);
        return () => {
            const current = handlers.get(name);
            if (!current) return;
            const idx = current.indexOf(entry);
            if (idx >= 0) current.splice(idx, 1);
        };
    }

    const acceptAll = () => true;

    return {
        // onApp：全局状态，所有窗口都处理（消费者自行去重）
        onApp(name, cb) {
            return add(name, cb, acceptAll);
        },
        // onWindow：控制命令，只认 sender === 本窗口名；mock（无窗口名）直通
        onWindow(name, cb) {
            return add(name, cb, (_payload, ev) => {
                if (!windowName) return true;
                const sender = ev && ev.sender;
                if (!sender) {
                    logf(`窗口事件 ${name} 缺少 sender，已丢弃`);
                    return false;
                }
                return sender === windowName;
            });
        },
        // onWorkspace：payload.root 与本窗口工作区一致才收（同工作区多窗口都收）
        onWorkspace(name, getWorkspace, cb) {
            return add(name, cb, (payload) => {
                if (!windowName) return true;
                const ws = getWorkspace && getWorkspace();
                return acceptWorkspace(payload, ws);
            });
        },
        // onOwned：按本窗口注册表判定 ID 归属
        onOwned(name, owns, cb) {
            return add(name, cb, (payload) => {
                if (!windowName) return true;
                return !!owns(payload);
            });
        },
        // onResource：按 kind/key 判定资源监听归属
        onResource(name, owns, cb) {
            return add(name, cb, (payload) => {
                if (!windowName) return true;
                return !!owns(payload);
            });
        },
        dispose() {
            handlers.clear();
            subscribed.clear();
        },
    };
}

// 供测试与调试：当前登记的事件名集合。
export function knownScopeNames() {
    return Object.keys(EVENT_SCOPES);
}

// ---- 模块级就绪队列 ----
// 域模块（run-ui 等在模块顶层 mount 的）可能早于 main.js 创建桥就订阅；
// 统一经 whenAppEvents 排队，桥就绪后（setAppEventBridge）再按序注册。

let activeBridge = null;
let pendingBindings = [];

// setAppEventBridge 由 main.js 在创建桥后调用，随后回放排队订阅。
export function setAppEventBridge(bridge) {
    activeBridge = bridge;
    const queued = pendingBindings;
    pendingBindings = [];
    for (const fn of queued) {
        try { fn(bridge); } catch (err) { console.debug('[app-events] 排队订阅失败', err); }
    }
}

// whenAppEvents 桥就绪即执行，否则排队。
export function whenAppEvents(fn) {
    if (activeBridge) {
        try { fn(activeBridge); } catch (err) { console.debug('[app-events] 订阅失败', err); }
        return;
    }
    pendingBindings.push(fn);
}

// onAppEvent 是全局事件订阅的简写（域模块用；仍走桥）。
export function onAppEvent(name, cb) {
    whenAppEvents((bridge) => bridge.onApp(name, cb));
}
