// AI 会话磁盘存储：JSONL 事件日志（唯一真源）+ 每会话 meta.json。
// 纯编解码/重放与磁盘适配放在一起，但代码只依赖注入的 backend，不碰 DOM。

export const AI_SESSION_SCHEMA = 1;

const IMAGE_EXT = {
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/png': 'png',
};

export function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

// 机械提醒注入块（给模型看的，不渲染）：silent 标记是后来才加的，修复前的历史会话
// 里没有这个字段——按内容前缀识别，加载回填时照常隐藏。新注入块的判定不依赖这里。
export function isSilentInjection(content) {
    return /^<task_todos_check>/.test(textOf(content).trim());
}

export function safeImageName(image) {
    const id = textOf(image && image.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'img';
    const ext = IMAGE_EXT[textOf(image && image.mime)] || 'png';
    return id + '.' + ext;
}

export function metaSignature(meta) {
    return JSON.stringify(Object.assign({}, meta, {updatedAt: 0}));
}

// 消息指纹：追加式日志只按 _mid 比对公共前缀，消息落盘后被就地改写（工具 running→done、
// 审批 pending→approved、子代理/后台作业收敛…）不会触发重写，重启重放就会读到旧状态
// ——最典型的表现是工具明明执行成功，重启后却成了「执行被中断」。
// 这里只对会被就地改写的字段取轻量指纹（不序列化正文，工具轮次里每轮都要算），
// 持久化时发现指纹变了就从该消息处截断重写。
export function messageFingerprint(message) {
    if (!message || typeof message !== 'object') return '';
    const approval = message.approval && typeof message.approval === 'object' ? message.approval : null;
    const ask = message.ask && typeof message.ask === 'object' ? message.ask : null;
    const envAsk = message.envAsk && typeof message.envAsk === 'object' ? message.envAsk : null;
    const agent = message.agent && typeof message.agent === 'object' ? message.agent : null;
    const bg = message.bg && typeof message.bg === 'object' ? message.bg : null;
    return [
        textOf(message.role),
        textOf(message.status),
        message.interrupted === true ? 1 : 0,
        textOf(message.content).length,
        textOf(message.error).length,
        approval ? textOf(approval.state) + ':' + textOf(approval.source) + ':' + textOf(approval.remember) : '',
        ask ? textOf(ask.state) + ':' + textOf(ask.source) + ':' + textOf(ask.answer).length : '',
        envAsk ? textOf(envAsk.state) : '',
        agent ? textOf(agent.state) + ':' + (Number(agent.rounds) || 0) + ':' + textOf(agent.summary).length : '',
        bg ? textOf(bg.state) + ':' + (bg.code == null ? '' : Number(bg.code)) : '',
        Array.isArray(message.images) ? message.images.length : 0,
        Number(message.turnMs) || 0,
        Number(message.thinkMs) || 0,
        Number(message.finishedAt) || 0,
    ].join('|');
}

// ---------- 事件编码 ----------

export function encodeSessionHeader(session) {
    return {
        v: AI_SESSION_SCHEMA,
        t: 'header',
        id: textOf(session && session.id),
        title: textOf(session && session.title),
        createdAt: Number(session && session.createdAt) || 0,
        workspace: textOf(session && session.workspace),
    };
}

// 事件里不保存 base64：图片已落 images/ 时只留 file 引用。
// 只有在落盘失败、没有 file 引用时才退回内嵌 data，宁可撑大也不丢图。
export function serializeSessionMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const out = {};
    for (const key of Object.keys(message)) {
        if (key === '_mid' || key === '_stored' || key.startsWith('_')) continue;
        if (key === 'images') continue;
        out[key] = message[key];
    }
    if (Array.isArray(message.images)) {
        out.images = message.images
            .filter((image) => image && typeof image === 'object')
            .map((image) => {
                const copy = {};
                for (const key of Object.keys(image)) {
                    if (key === 'data' && image.file) continue;
                    copy[key] = image[key];
                }
                return copy;
            });
    }
    return out;
}

export function encodeMessageEvent(message, mid, archived) {
    const payload = serializeSessionMessage(message);
    if (!payload || !mid) return null;
    const event = {v: AI_SESSION_SCHEMA, t: 'msg', mid, m: payload};
    if (archived) event.a = 1;
    return event;
}

export function encodeTruncateEvent(keep) {
    return {v: AI_SESSION_SCHEMA, t: 'truncate', keep: Math.max(0, Number(keep) || 0)};
}

export function encodeArchiveEvent(keep, summary) {
    return {
        v: AI_SESSION_SCHEMA,
        t: 'archive',
        keep: Math.max(0, Number(keep) || 0),
        summary: summary && typeof summary === 'object' ? summary : null,
    };
}

export function encodeResetEvent() {
    return {v: AI_SESSION_SCHEMA, t: 'reset'};
}

export function encodeMetaEvent(patch) {
    return {v: AI_SESSION_SCHEMA, t: 'meta', patch: patch && typeof patch === 'object' ? patch : {}};
}

export function encodeSessionLines(events) {
    if (!Array.isArray(events) || !events.length) return '';
    const lines = [];
    for (const event of events) {
        if (!event) continue;
        try {
            lines.push(JSON.stringify(event));
        } catch (e) {}
    }
    return lines.length ? lines.join('\n') + '\n' : '';
}

// ---------- 重放 ----------

export function replaySessionLog(text) {
    const result = {
        header: null,
        messages: [],
        archived: [],
        summary: null,
        meta: {},
        issues: 0,
        torn: false,
    };
    const raw = textOf(text);
    if (!raw) return result;
    const lines = raw.split('\n');
    if (!raw.endsWith('\n')) {
        // 没有换行结尾的尾行视为未提交；append 前也会把它截掉，保持读写一致。
        result.torn = true;
        lines.pop();
    } else {
        lines.pop();
    }
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event = null;
        try {
            event = JSON.parse(trimmed);
        } catch (e) {
            result.issues++;
            continue;
        }
        if (!event || typeof event !== 'object') {
            result.issues++;
            continue;
        }
        if (Number(event.v) > AI_SESSION_SCHEMA) {
            result.issues++;
            continue;
        }
        switch (event.t) {
            case 'header':
                result.header = event;
                break;
            case 'msg': {
                if (!event.m || typeof event.m !== 'object') {
                    result.issues++;
                    break;
                }
                const message = Object.assign({}, event.m, {_mid: textOf(event.mid)});
                (event.a ? result.archived : result.messages).push(message);
                break;
            }
            case 'truncate': {
                const keep = Math.max(0, Math.min(result.messages.length, Number(event.keep) || 0));
                result.messages = result.messages.slice(0, keep);
                break;
            }
            case 'archive': {
                const keep = Math.max(0, Math.min(result.messages.length, Number(event.keep) || 0));
                const moved = result.messages.slice(0, keep);
                result.messages = result.messages.slice(keep);
                result.archived = result.archived.concat(moved);
                if (event.summary && typeof event.summary === 'object') result.summary = event.summary;
                break;
            }
            case 'reset':
                result.messages = [];
                result.archived = [];
                result.summary = null;
                break;
            case 'meta': {
                const patch = event.patch && typeof event.patch === 'object' ? event.patch : {};
                Object.assign(result.meta, patch);
                if (Object.prototype.hasOwnProperty.call(patch, 'summary')) {
                    result.summary = patch.summary && typeof patch.summary === 'object' ? patch.summary : null;
                }
                break;
            }
            default:
                result.issues++;
                break;
        }
    }
    return result;
}

export function buildSessionMeta(session) {
    const summary = session && session.summary && typeof session.summary === 'object' ? session.summary : null;
    return {
        v: AI_SESSION_SCHEMA,
        id: textOf(session && session.id),
        title: textOf(session && session.title),
        createdAt: Number(session && session.createdAt) || 0,
        updatedAt: Number(session && session.updatedAt) || 0,
        workspace: textOf(session && session.workspace),
        scope: ['read', 'edit', 'auto', 'full'].includes(session && session.scope) ? session.scope : 'read',
        profileId: textOf(session && session.profileId),
        modelId: textOf(session && session.modelId),
        systemPrompt: textOf(session && session.systemPrompt),
        promptTemplateId: textOf(session && session.promptTemplateId),
        planMode: !!(session && session.planMode),
        browserTabId: textOf(session && session.browserTabId),
        round: Number(session && session.round) || 0,
        archivedAt: Number(session && session.archivedAt) || 0,
        pinned: !!(session && session.pinned),
        // 后台结束、用户尚未查看的会话：'' / 'done' / 'error'（列表右侧状态圆点用）
        unread: session && (session.unread === 'done' || session.unread === 'error') ? session.unread : '',
        messageCount: Array.isArray(session && session.messages) ? session.messages.length : 0,
        archivedCount: Array.isArray(session && session.archived) ? session.archived.length : 0,
        logFile: textOf(session && session.logFile),
        logSavedAt: Number(session && session.logSavedAt) || 0,
        todos: Array.isArray(session && session.todos) ? session.todos : [],
        // 本会话任务提醒（AI reminder_* 工具 / 面板弹层维护；跟随会话存储，会话删了提醒也没了）
        reminders: Array.isArray(session && session.reminders) ? session.reminders : [],
        changes: Array.isArray(session && session.changes) ? session.changes : [],
        approvedPaths: Array.isArray(session && session.approvedPaths) ? session.approvedPaths : [],
        // 已批准的工作区外读根（读审批卡「本会话记住」；跨重启保留授权）
        readRoots: Array.isArray(session && session.readRoots) ? session.readRoots : [],
        // 支线对话：指向母会话 id（普通会话为空）。sideOf 不嵌套——创建时已扁平化到一层。
        sideOf: textOf(session && session.sideOf),
        summary,
    };
}
