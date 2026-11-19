// precommands.js：工作区预指令的纯函数——条目归一化 / 上限校验 / 工作区过滤 /
// 动作审批规格 / 执行汇总。存储在 settings.preCommands（localStorage，AI 没有任何
// 写通道——这是「AI 写入必审批不可绕过」的前提，方案见
// docs/finished-plans/workspace-precommands.md §5）。

export const PRECMD_EVENT = 'workspace-open'; // 缺省事件（老数据无 event 字段时沿用）
export const PRECMD_EVENTS = [PRECMD_EVENT, 'workspace-close', 'ai-session-start'];
export const PRECMD_EVENT_LABELS = {
    'workspace-open': '打开工作区',
    'workspace-close': '关闭工作区',
    'ai-session-start': 'AI 会话开始',
};
export function eventLabel(event) {
    return PRECMD_EVENT_LABELS[event] || String(event || '');
}
export const PRECMD_MAX_TOTAL = 20;           // 全局条目上限
export const PRECMD_MAX_PER_WS = 10;          // 单工作区条目上限
export const PRECMD_COMMAND_MAX = 2000;       // 命令文本上限
export const PRECMD_TIMEOUT_DEFAULT = 30000;
export const PRECMD_TIMEOUT_MIN = 1000;
export const PRECMD_TIMEOUT_MAX = 600000;
export const PRECMD_ID_PREFIX = 'pc-';        // 条目 id 前缀（同 memo 的 blk-/it- 惯例）

function newId() {
    return PRECMD_ID_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
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
export function normalizePreCommand(raw, prev) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const command = String(src.command != null ? src.command : (prev ? prev.command : '')).trim();
    if (!command) return {ok: false, error: '命令不能为空'};
    if (command.length > PRECMD_COMMAND_MAX) {
        return {ok: false, error: '命令超过长度上限 ' + PRECMD_COMMAND_MAX + ' 字符'};
    }
    const event = String(src.event != null ? src.event : (prev ? prev.event : PRECMD_EVENT) || PRECMD_EVENT);
    if (!PRECMD_EVENTS.includes(event)) {
        return {ok: false, error: '未知的事件类型：' + event + '（可用：' + PRECMD_EVENTS.join(' / ') + '）'};
    }
    const timeoutRaw = src.timeoutMs != null ? src.timeoutMs : (prev ? prev.timeoutMs : PRECMD_TIMEOUT_DEFAULT);
    const timeoutMs = Math.min(PRECMD_TIMEOUT_MAX,
        Math.max(PRECMD_TIMEOUT_MIN, Math.round(numOr(timeoutRaw, PRECMD_TIMEOUT_DEFAULT))));
    const origin = src.origin === 'ai' ? 'ai'
        : src.origin === 'user' ? 'user'
        : (prev && prev.origin === 'ai') ? 'ai' : 'user';
    const createdAt = Math.round(numOr(prev ? prev.createdAt : src.createdAt, 0)) || Date.now();
    const entry = {
        id: String(src.id != null ? src.id : (prev ? prev.id : '') || '').trim() || newId(),
        ws: String(src.ws != null ? src.ws : (prev ? prev.ws : '') || ''),
        event,
        command,
        timeoutMs,
        enabled: src.enabled != null ? !!src.enabled : (prev ? prev.enabled !== false : true),
        origin,
        createdAt,
    };
    if (!entry.id.startsWith(PRECMD_ID_PREFIX)) entry.id = newId();
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
export function entriesForWorkspace(entries, wsKey, event = PRECMD_EVENT) {
    const key = String(wsKey || '');
    if (!key) return [];
    return (Array.isArray(entries) ? entries : [])
        .filter((e) => e && e.enabled !== false && e.event === event && String(e.ws || '') === key);
}

// 工作区全部条目（不分事件，含停用）：AI 的 get_pre_commands 用——AI 要能看到
// 三个时机的条目才能 update/remove 它们（审查 P1-3）
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
        + ' · 时机：' + eventLabel(entry && entry.event)
        + ' · 超时 ' + formatTimeoutText(entry && entry.timeoutMs)
        + ' · ' + ((entry && entry.enabled === false) ? '停用' : '启用');
}

/**
 * 动作审批规格（op = add | update | remove）：预指令写入一律必弹、风险恒 high，
 * 与权限档无关——调用方（shell/precommands.js）不做任何档位路由。
 * oldEntry 只在 update 传，用于「原值 → 新值」对照。
 */
export function buildPreCommandApprovalSpec(op, entry, wsName, oldEntry) {
    const name = String(wsName || '当前工作区');
    // 审批卡必须给命令**全文**（含多行）：用户批准的与他批准后每次自动执行的必须是同一段
    // 文本（审查 P1-2）；摘要场景（列表行 / 消息中心）才用 commandDigest
    const command = String((entry && entry.command) || '').trim();
    const base = {
        action: op === 'add' ? 'add_pre_command' : op === 'update' ? 'update_pre_command' : 'remove_pre_command',
        risk: 'high',
        source: '设置 → 预指令',
    };
    if (op === 'remove') {
        return {
            ...base,
            title: '删除预指令（' + name + '）',
            target: command,
            oldValue: entrySummary(entry),
            newValue: '（删除）',
            warnings: ['删除后该命令不再随工作区打开自动执行'],
        };
    }
    if (op === 'update') {
        return {
            ...base,
            title: '修改预指令（' + name + '）',
            target: command,
            oldValue: entrySummary(oldEntry),
            newValue: entrySummary(entry),
            warnings: [
                '批准后该命令将在每次打开工作区「' + name + '」时自动执行，无需再次审批',
                '命令以本机权限运行，请确认内容与来源可信',
            ],
        };
    }
    return {
        ...base,
        title: '新增预指令（' + name + '）',
        target: command,
        oldValue: '（无）',
        newValue: entrySummary(entry),
        warnings: [
            '批准后该命令将在每次打开工作区「' + name + '」时自动执行，无需再次审批',
            '命令以本机权限运行，请确认内容与来源可信',
        ],
    };
}

/**
 * 执行汇总（消息中心 body）：首行总览（含 AI 配置计数），失败逐条给命令摘要与原因。
 * results 形如 [{entry, result: {code, stdout, stderr, timedOut} | null, error: string}]
 */
export function summarizePreCommandRuns(results) {
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
