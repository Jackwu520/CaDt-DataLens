// event-scope.js：多窗口事件范围表（唯一分类来源）。
// 与 docs/finished-plans/wails-v3-event-filtering.md §3 对齐；新增订阅必须先登记这里。
//
// scope:
//   app       全局状态，所有窗口都应处理（消费者自行去重）
//   window    控制命令，只给目标窗口（sender === 本窗口名）
//   workspace 按 payload.root 匹配本窗口工作区
//   resource  按 kind/key 匹配本窗口注册的资源监听
//   owned     ID 归属，按本窗口注册表判定
//   session   会话级，由 AI 面板按 sessionId 判定

export const EVENT_SCOPES = Object.freeze({
    // AI 流式（面板按 sessionId 自行判定；P2 可收紧为 session 谓词）
    'ai-chunk': 'session',
    'ai-think': 'session',
    'ai-toolcall': 'session',
    'ai-done': 'session',
    'ai-error': 'session',
    'ai-retry': 'session',
    'ai-param-adjust': 'session',
    'ai-queue': 'session',

    // 全局状态
    'sched-fire': 'app',
    'schedules-changed': 'app',
    'mcp-tools-changed': 'app',
    'mcp-status-changed': 'app',
    'ai-timer-fired': 'app',
    'ai-timer-stopped': 'app',

    // 工作区 / 资源
    'workspace-changed': 'workspace',
    'resource-changed': 'resource',

    // 窗口控制命令
    'confirm-close': 'window',
    'open-targets': 'window',
    'app-open-settings': 'window',
    'app-open-memo': 'window',
    'app-open-ai-session': 'window',
    'ai-notify-activate': 'window',

    // ID 归属（流式；P1 注册为 onApp，消费者已按 id 过滤；P2 收紧为 onOwned）
    'term-out': 'owned',
    'term-exit': 'owned',
    'cmd-out': 'owned',
    'cmd-exit': 'owned',
    'run-out': 'owned',
    'run-exit': 'owned',
    'browser-nav': 'owned',
    'browser-title': 'owned',
    'browser-error': 'owned',
    'reading-search-progress': 'owned',
});

// scopeOf 返回事件分类，未登记的事件按 app 处理（桥会记一条调试日志提醒登记）。
export function scopeOf(name) {
    return EVENT_SCOPES[name] || 'app';
}

// pathKey 把路径归一成可比较的小写 key（分隔符统一、去尾斜杠）。
export function pathKey(p) {
    return String(p == null ? '' : p)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

// acceptWorkspace 判断事件载荷是否属于本窗口工作区。
export function acceptWorkspace(payload, workspace) {
    const root = payload && payload.root;
    if (!root || !workspace) return false;
    return pathKey(root) === pathKey(workspace);
}
