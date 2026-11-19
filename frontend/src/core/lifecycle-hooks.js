// lifecycle-hooks.js：工作区生命周期钩子的纯函数——条目归一化 / 上限校验 / 工作区过滤 /
// 动作审批规格 / 执行汇总。存储在 settings.lifecycleHooks（localStorage，AI 没有任何
// 写通道——这是「AI 写入必审批不可绕过」的前提，方案见
// docs/finished-plans/workspace-lifecycle-hooks.md §5）。
// 2026-11-21 由 precommands.js 改名：旧名 pre-command 只表达「前置命令」，与 9 个事件
// （含 post-tool-use / stop 这类事后钩子）不符。

export const LIFECYCLE_HOOK_EVENT = 'workspace-open'; // 缺省事件（老数据无 event 字段时沿用）

// 9 个生命周期事件：2 个工作区级 + 7 个 AI 会话/工具级（对齐 ZCode 钩子语义）
// 'ai-session-start' 是一期旧名，作为合法别名保留（normalize 时统一改写成 session-start），
// 让已存盘的老配置继续可读可执行。
export const LIFECYCLE_HOOK_EVENTS = [
    LIFECYCLE_HOOK_EVENT,          // 打开工作区（打开 / 切回 / 启动恢复）
    'workspace-close',             // 关闭工作区（显式关闭 / 切走）
    'session-start',               // AI 会话开始（空会话第一轮流起前，阻塞）
    'ai-session-start',            // 旧名兼容别名（归一化改写为 session-start）
    'user-prompt-submit',          // 用户提交每轮 prompt（阻塞）
    'pre-tool-use',                // 工具调用前（阻塞，支持 matchTools）
    'post-tool-use',               // 工具调用成功后（fire-and-forget，支持 matchTools）
    'post-tool-use-failure',       // 工具调用失败后（fire-and-forget，支持 matchTools）
    'permission-request',          // 权限审批发起时（阻塞，支持 matchTools）
    'stop',                        // 用户停止生成（fire-and-forget）
];
// 设置页下拉只显示规范名（隐藏旧别名，避免用户创建新别名条目）
export const LIFECYCLE_HOOK_EVENT_OPTIONS = LIFECYCLE_HOOK_EVENTS.filter((e) => e !== 'ai-session-start');
export const LIFECYCLE_HOOK_EVENT_LABELS = {
    'workspace-open': '打开工作区',
    'workspace-close': '关闭工作区',
    'session-start': '会话开始',
    'ai-session-start': '会话开始', // 旧别名同标签
    'user-prompt-submit': '提交用户输入',
    'pre-tool-use': '工具调用前',
    'post-tool-use': '工具成功后',
    'post-tool-use-failure': '工具失败后',
    'permission-request': '权限请求时',
    'stop': '停止生成时',
};
// 工具级事件：按工具名匹配（matchTools），其余事件忽略匹配器按工作区过滤
export const LIFECYCLE_HOOK_TOOL_EVENTS = ['pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'permission-request'];
// 阻塞型事件：起轮/工具调用/审批要等命令跑完才继续；其余 fire-and-forget
export const LIFECYCLE_HOOK_BLOCKING_EVENTS = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'permission-request'];

export function eventLabel(event) {
    return LIFECYCLE_HOOK_EVENT_LABELS[event] || String(event || '');
}
export function isToolEvent(event) {
    return LIFECYCLE_HOOK_TOOL_EVENTS.includes(event);
}
export function isBlockingEvent(event) {
    return LIFECYCLE_HOOK_BLOCKING_EVENTS.includes(event);
}

// 工具名匹配器：matchTools 是工具名数组（允 mcp__/plugin__ 前缀通配『mcp__*』）；
// 空数组 = 匹配所有工具；对非工具事件恒不参与过滤。
export function toolMatches(entry, toolName) {
    if (!isToolEvent(entry && entry.event)) return false;
    const list = Array.isArray(entry.matchTools) ? entry.matchTools : [];
    if (!list.length) return true;
    const name = String(toolName || '');
    return list.some((raw) => {
        const pattern = String(raw || '').trim();
        if (pattern === '*' || pattern === 'all') return true;
        if (pattern.endsWith('__*')) return name.startsWith(pattern.slice(0, -1)); // 'mcp__*' → 前缀 mcp__
        return pattern === name;
    });
}
export const LIFECYCLE_HOOK_MAX_TOTAL = 20;           // 全局条目上限
export const LIFECYCLE_HOOK_MAX_PER_WS = 10;          // 单工作区条目上限
export const LIFECYCLE_HOOK_COMMAND_MAX = 2000;       // 命令文本上限
export const LIFECYCLE_HOOK_TIMEOUT_DEFAULT = 30000;
export const LIFECYCLE_HOOK_TIMEOUT_MIN = 1000;
export const LIFECYCLE_HOOK_TIMEOUT_MAX = 600000;
export const LIFECYCLE_HOOK_ID_PREFIX = 'lh-';        // 条目 id 前缀（同 memo 的 blk-/it- 惯例）
// 旧前缀只读兼容：存量条目（pc-）不必在保存时被换 id，否则 AI 手里/会话里的 id 会失效
export const LIFECYCLE_HOOK_LEGACY_ID_PREFIX = 'pc-';

function newId() {
    return LIFECYCLE_HOOK_ID_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// 工作区显示名（D:\a\proj → proj），与 baseNameOf 同语义；给审批卡 / 消息中心用
export function wsDisplayName(dir) {
    const text = String(dir || '').replace(/[\\/]+$/, '');
    const idx = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return idx >= 0 ? text.slice(idx + 1) : text;
}

// 命令摘要：只取第一行、压缩空白、截断——审批卡 / 汇总文案用，不拼多行命令
export function commandDigest(command, max = 60) {
    const text = String(command || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function formatTimeoutText(ms) {
    const n = Math.round(Number(ms) || 0);
    if (n <= 0) return '不限';
    if (n < 60000) return Math.round(n / 1000) + ' 秒';
    if (n % 60000 === 0) return (n / 60000) + ' 分钟';
    return Math.round(n / 1000) + ' 秒';
}

function numOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 归一化单条条目。raw 给增量的新字段，prev 给沿用字段（部分更新共用一条通路）。
 * 非法（空命令 / 超长 / 未知 event）返回 {ok:false, error}；超时越界钳制不报错。
 * origin 语义 = 「最后写入方」：src.origin 显式给 'ai'/'user' 时采纳，否则沿用 prev。
 */
export function normalizeLifecycleHook(raw, prev) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const command = String(src.command != null ? src.command : (prev ? prev.command : '')).trim();
    if (!command) return {ok: false, error: '命令不能为空'};
    if (command.length > LIFECYCLE_HOOK_COMMAND_MAX) {
        return {ok: false, error: '命令超过长度上限 ' + LIFECYCLE_HOOK_COMMAND_MAX + ' 字符'};
    }
    const eventRaw = String(src.event != null ? src.event : (prev ? prev.event : LIFECYCLE_HOOK_EVENT) || LIFECYCLE_HOOK_EVENT);
    const event = eventRaw === 'ai-session-start' ? 'session-start' : eventRaw; // 旧名改写为规范名
    if (!LIFECYCLE_HOOK_EVENTS.includes(event)) {
        return {ok: false, error: '未知的事件类型：' + event + '（可用：' + LIFECYCLE_HOOK_EVENTS.join(' / ') + '）'};
    }
    const timeoutRaw = src.timeoutMs != null ? src.timeoutMs : (prev ? prev.timeoutMs : LIFECYCLE_HOOK_TIMEOUT_DEFAULT);
    const timeoutMs = Math.min(LIFECYCLE_HOOK_TIMEOUT_MAX,
        Math.max(LIFECYCLE_HOOK_TIMEOUT_MIN, Math.round(numOr(timeoutRaw, LIFECYCLE_HOOK_TIMEOUT_DEFAULT))));
    const origin = src.origin === 'ai' ? 'ai'
        : src.origin === 'user' ? 'user'
        : (prev && prev.origin === 'ai') ? 'ai' : 'user';
    const createdAt = Math.round(numOr(prev ? prev.createdAt : src.createdAt, 0)) || Date.now();
    // 工具匹配器（仅工具级事件有意义）：最多 20 个、每个 ≤60 字符、去重、去空
    const matchRaw = src.matchTools != null ? src.matchTools : (prev ? prev.matchTools : []);
    const matchTools = [...new Set((Array.isArray(matchRaw) ? matchRaw : [])
        .map((t) => String(t || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
    const entry = {
        id: String(src.id != null ? src.id : (prev ? prev.id : '') || '').trim() || newId(),
        ws: String(src.ws != null ? src.ws : (prev ? prev.ws : '') || ''),
        event,
        command,
        timeoutMs,
        enabled: src.enabled != null ? !!src.enabled : (prev ? prev.enabled !== false : true),
        matchTools,
        origin,
        createdAt,
    };
    if (!entry.id.startsWith(LIFECYCLE_HOOK_ID_PREFIX) && !entry.id.startsWith(LIFECYCLE_HOOK_LEGACY_ID_PREFIX)) {
        entry.id = newId();
    }
    // 执行回显字段（仅展示）：沿用 prev，或随写入透传
    if (prev && prev.lastRunAt) entry.lastRunAt = prev.lastRunAt;
    if (prev && prev.lastCode != null) entry.lastCode = prev.lastCode;
    if (src.lastRunAt != null) {
        const t = Math.round(numOr(src.lastRunAt, 0));
        if (t > 0) entry.lastRunAt = t;
    }
    if (src.lastCode != null) {
        const c = Number(src.lastCode);
        if (Number.isFinite(c)) entry.lastCode = c;
    }
    return {ok: true, entry};
}

/**
 * 数组归一化：非法条目丢弃、id 冲突重生成、超全局上限时保留**尾部**（最后配置的赢）。
 * 只在写入点调用；读取处容忍存量脏数据。
 */
// 生效条目：启用 + 事件匹配 + 工作区匹配（ws 已是 sessionPathKey 归一化后的 key）
export function entriesForWorkspace(entries, wsKey, event = LIFECYCLE_HOOK_EVENT) {
    const key = String(wsKey || '');
    if (!key) return [];
    return (Array.isArray(entries) ? entries : [])
        .filter((e) => e && e.enabled !== false && e.event === event && String(e.ws || '') === key);
}

// 工作区全部条目（不分事件，含停用）：AI 的 get_lifecycle_hooks 用——AI 要能看到
// 全部事件的条目才能 update/remove 它们（审查 P1-3）
export function allEntriesForWorkspace(entries, wsKey) {
    const key = String(wsKey || '');
    if (!key) return [];
    return (Array.isArray(entries) ? entries : []).filter((e) => String(e.ws || '') === key);
}

// 工作区条目计数（新增前的单工作区上限校验用；enabled 与否都占额）
export function countForWorkspace(entries, wsKey) {
    const key = String(wsKey || '');
    return (Array.isArray(entries) ? entries : []).filter((e) => String(e.ws || '') === key).length;
}

function entrySummary(entry) {
    return '命令：' + commandDigest(entry && entry.command, 160)
        + ' · 时机：' + (eventLabel(entry && entry.event) || '默认时机')
        + ' · 超时 ' + formatTimeoutText(entry && entry.timeoutMs)
        + (isToolEvent(entry && entry.event)
            ? ' · 匹配工具 ' + ((entry.matchTools && entry.matchTools.length) ? entry.matchTools.join('/') : '全部')
            : '')
        + ' · ' + ((entry && entry.enabled === false) ? '停用' : '启用');
}

/**
 * 动作审批规格（op = add | update | remove）：生命周期钩子写入一律必弹、风险恒 high，
 * 与权限档无关——调用方（shell/lifecycle-hooks.js）不做任何档位路由。
 * oldEntry 只在 update 传，用于「原值 → 新值」对照。
 * 刻意没有 run 动作：AI 验证命令走 run_command（full 档直通更快、工具卡更详细），
 * 按条目执行没有独立价值；用户手动验证走设置页列表行的「运行」按钮。
 */
export function buildLifecycleHookApprovalSpec(op, entry, wsName, oldEntry) {
    const name = String(wsName || '当前工作区');
    const when = eventLabel(entry && entry.event) || '默认时机';
    // 审批卡必须给命令**全文**（含多行）：用户批准的与他批准后每次自动执行的必须是同一段
    // 文本（审查 P1-2）；摘要场景（列表行 / 消息中心）才用 commandDigest
    const command = String((entry && entry.command) || '').trim();
    const base = {
        action: op === 'add' ? 'add_lifecycle_hook'
            : op === 'update' ? 'update_lifecycle_hook'
            : 'remove_lifecycle_hook',
        risk: 'high',
        source: '设置 → 生命周期',
    };
    if (op === 'remove') {
        return {
            ...base,
            title: '删除生命周期钩子（' + name + '）',
            target: command,
            oldValue: entrySummary(entry),
            newValue: '（删除）',
            warnings: ['删除后该命令不再随「' + when + '」事件自动执行'],
        };
    }
    if (op === 'update') {
        return {
            ...base,
            title: '修改生命周期钩子（' + name + '）',
            target: command,
            oldValue: entrySummary(oldEntry),
            newValue: entrySummary(entry),
            warnings: [
                '批准后该命令将在「' + when + '」（' + name + '）时自动执行，无需再次审批',
                '命令以本机权限运行，请确认内容与来源可信',
            ],
        };
    }
    return {
        ...base,
        title: '新增生命周期钩子（' + name + '）',
        target: command,
        oldValue: '（无）',
        newValue: entrySummary(entry),
        warnings: [
            '批准后该命令将在「' + when + '」（' + name + '）时自动执行，无需再次审批',
            '命令以本机权限运行，请确认内容与来源可信',
        ],
    };
}

/**
 * 执行汇总（消息中心 body）：首行总览（含 AI 配置计数），失败逐条给命令摘要与原因。
 * results 形如 [{entry, result: {code, stdout, stderr, timedOut} | null, error: string}]
 */
export function summarizeLifecycleHookRuns(results) {
    const list = Array.isArray(results) ? results : [];
    const total = list.length;
    const aiCount = list.filter((r) => r.entry && r.entry.origin === 'ai').length;
    const failedRows = list.filter((r) => r.error || !r.result || r.result.timedOut || r.result.code !== 0);
    const head = '共 ' + total + ' 条'
        + (aiCount ? '（其中 ' + aiCount + ' 条为 AI 配置）' : '')
        + (failedRows.length ? '，失败 ' + failedRows.length + ' 条' : '，全部成功');
    const lines = [head];
    for (const r of failedRows) {
        const reason = r.error ? ('执行失败：' + commandDigest(r.error, 160))
            : (r.result && r.result.timedOut) ? '超时被终止'
            : ('退出码 ' + (r.result && r.result.code));
        lines.push('✕ ' + commandDigest(r.entry && r.entry.command, 60) + ' — ' + reason);
        // stderr 尾部（单行压平、截 200）：排障时能看到失败原因细节（方案 §6 承诺）
        const stderr = r.result && String(r.result.stderr || '').trim();
        if (stderr) {
            const tail = stderr.replace(/\s+/g, ' ');
            lines.push('  stderr: ' + (tail.length > 200 ? '…' + tail.slice(-200) : tail));
        }
    }
    return lines.join('\n');
}
