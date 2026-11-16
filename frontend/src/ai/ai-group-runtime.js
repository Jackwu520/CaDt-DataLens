// ai-group-runtime.js：群聊运行时——群状态、磁盘适配、加载/创建/删除、发言路径与流事件。
// G2 单发言路径：按成员模型窗口组装请求（§3.11/§7.1）→ AISendChat → 流事件 → 超时/停止 → 落盘。
// G3 在此接主持人循环；G1 的群状态 / 创建 / 删除 / 订阅保持不变。
// main.js 把 ai-* 事件转发到 handleEvent（payload.id === roundId 精确认领）；侧栏与
// 标签页视图经 subscribe 拿快照。
import {aiClampInt, aiNowId} from './ai-constants.js';
import {
    GROUP_MEMBER_MAX,
    GROUP_MEMBER_MIN,
    TIMEOUT_PRESETS,
    buildMemberMessages,
    foldPrivateSteps,
    memberTimeouts,
    normalizeChair,
    normalizeGroupMeta,
} from './ai-group-model.js';
import {
    createGroupStoreAdapter,
    encodeGroupEvent,
    encodeGroupMessage,
    groupHeaderLine,
    replayGroupLog,
} from './ai-group-store.js';

export function createAIGroupRuntime(deps) {
    const backend = deps.backend;
    const store = createGroupStoreAdapter(backend);
    const getAIConfig = typeof deps.getAIConfig === 'function' ? deps.getAIConfig : (() => null);
    const resolveModel = typeof deps.resolveModel === 'function' ? deps.resolveModel : (() => null);
    const flash = deps.flash || (() => {});
    const openGroupTab = deps.openGroupTab || null;
    const getWorkspace = deps.getWorkspace || (() => '');

    // groupId → {meta, messages, events, loaded}
    const groups = new Map();
    // roundId → 流记录（发言中）；结束后移除
    const streams = new Map();
    const groupSeq = new Map();
    let listMode = 'sessions';
    let initPromise = null;
    const listeners = new Set();

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function notify() {
        const snap = snapshot();
        for (const fn of listeners) {
            try {
                fn(snap);
            } catch (e) {
                console.error('群聊订阅回调失败', e);
            }
        }
    }

    function snapshot() {
        return {listMode, groups: groupList()};
    }

    function groupList() {
        return [...groups.values()].map((g) => g.meta).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    async function refreshList() {
        const metas = await store.list();
        const seen = new Set();
        for (const raw of metas || []) {
            let meta = null;
            try {
                meta = normalizeGroupMeta(JSON.parse(raw));
            } catch (e) {
                continue; // 坏 meta 跳过（正文 header 兜底由 Go 侧 synthesize 完成）
            }
            if (!meta.id) continue;
            seen.add(meta.id);
            const existing = groups.get(meta.id);
            if (existing) {
                existing.meta = {...existing.meta, ...meta, updatedAt: Math.max(existing.meta.updatedAt || 0, meta.updatedAt || 0)};
            } else {
                groups.set(meta.id, {meta, messages: [], events: [], loaded: false});
            }
        }
        for (const id of [...groups.keys()]) {
            if (!seen.has(id)) groups.delete(id);
        }
        notify();
    }

    function init() {
        if (initPromise) return initPromise;
        initPromise = refreshList().catch((e) => {
            flash('群聊列表加载失败：' + ((e && e.message) || e), true);
        });
        return initPromise;
    }

    function setListMode(mode) {
        if (mode !== 'sessions' && mode !== 'groups') return;
        if (listMode === mode) return;
        listMode = mode;
        notify();
    }

    async function ensureLoaded(id) {
        const g = groups.get(id);
        if (!g || g.loaded) return g;
        const text = await store.read(id);
        const replay = replayGroupLog(text);
        g.messages = replay.messages;
        g.events = replay.events;
        g.loaded = true;
        return g;
    }

    async function openGroup(id) {
        const g = groups.get(id);
        if (!g) return null;
        try {
            await ensureLoaded(id);
        } catch (e) {
            flash('群聊记录读取失败：' + ((e && e.message) || e), true);
            return null;
        }
        if (openGroupTab) openGroupTab({groupId: id, title: g.meta.title});
        return g;
    }

    function agentsOf(config) {
        return (config && Array.isArray(config.agents)) ? config.agents : [];
    }

    // ---------- 创建 / 删除 / meta ----------

    async function createGroup(spec) {
        const source = spec && typeof spec === 'object' ? spec : {};
        const config = getAIConfig();
        const agents = agentsOf(config);
        const memberIds = (Array.isArray(source.memberIds) ? source.memberIds : [])
            .filter((id) => agents.some((agent) => agent && agent.id === id && agent.enabled));
        if (memberIds.length < GROUP_MEMBER_MIN) {
            return {ok: false, error: '至少选择 ' + GROUP_MEMBER_MIN + ' 位可用成员'};
        }
        if (memberIds.length > GROUP_MEMBER_MAX) {
            return {ok: false, error: '最多 ' + GROUP_MEMBER_MAX + ' 位成员'};
        }
        const chairSpec = {...(source.chair && typeof source.chair === 'object' ? source.chair : {})};
        if (chairSpec.kind === 'ai') {
            const chairAgent = agents.find((agent) => agent && agent.id === chairSpec.agentId);
            if (!chairAgent) return {ok: false, error: '主持人智能体不可用，请重新选择'};
            chairSpec.modelRef = chairAgent.modelRef;
        } else if (chairSpec.kind === 'member') {
            if (!memberIds.includes(chairSpec.agentId)) return {ok: false, error: '兼任主持人必须是群成员'};
            chairSpec.modelRef = '';
        } else {
            chairSpec.kind = 'user';
            chairSpec.agentId = '';
            chairSpec.modelRef = '';
        }
        const preset = source.timeoutPreset === 'lenient' ? TIMEOUT_PRESETS.lenient : TIMEOUT_PRESETS.standard;
        const id = aiNowId('group-');
        const meta = normalizeGroupMeta({
            id,
            title: source.title || '未命名群聊',
            topic: source.topic || '',
            goal: source.goal,
            memberIds,
            mode: 'roundtable',
            chair: normalizeChair(chairSpec),
            maxRounds: source.maxRounds,
            roundMode: 'sequential',
            timeouts: preset.timeouts,
            workspace: getWorkspace() || '',
        });
        meta.updatedAt = Date.now();
        try {
            await store.writeMeta(id, JSON.stringify(meta));
            await store.append(id, groupHeaderLine(meta) + '\n');
        } catch (e) {
            return {ok: false, error: '群聊创建失败：' + ((e && e.message) || e)};
        }
        groups.set(id, {meta, messages: [], events: [], loaded: true});
        notify();
        if (openGroupTab) openGroupTab({groupId: id, title: meta.title});
        return {ok: true, id};
    }

    async function deleteGroup(id) {
        try {
            await store.remove(id);
        } catch (e) {
            flash('删除群聊失败：' + ((e && e.message) || e), true);
            return {ok: false};
        }
        groups.delete(id);
        notify();
        return {ok: true};
    }

    async function saveMeta(id, mutator) {
        const g = groups.get(id);
        if (!g) return;
        if (typeof mutator === 'function') mutator(g.meta);
        g.meta.updatedAt = Date.now();
        try {
            await store.writeMeta(id, JSON.stringify(g.meta));
        } catch (e) {
            flash('群聊状态保存失败：' + ((e && e.message) || e), true);
        }
        notify();
    }

    // ---------- 发言路径（G2，§7.1 / §3.11 / §3.12） ----------

    function currentRound(meta) {
        return Math.max(1, (meta && meta.discussion && meta.discussion.round) || 1);
    }

    function participantsText(meta, agents, self) {
        const lines = ['用户：提出议题、随时插话、点名成员。'];
        for (const id of (meta && meta.memberIds) || []) {
            if (self && id === self.id) continue;
            const agent = agents.find((item) => item && item.id === id);
            lines.push(`- ${agent ? agent.name : '已删除成员'}${agent && agent.role ? '：' + agent.role : ''}`);
        }
        return lines.join('\n');
    }

    // 私有日志 JSONL → 步骤记录数组（坏行跳过）
    function parsePrivateSteps(text) {
        const out = [];
        for (const line of String(text || '').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const item = JSON.parse(trimmed);
                if (item && item.gid) out.push(item);
            } catch (e) {
                continue;
            }
        }
        return out;
    }

    async function appendSystemEvent(groupId, evt) {
        const g = groups.get(groupId);
        if (!g) return;
        try {
            await store.append(groupId, encodeGroupEvent({...evt, ts: Date.now()}) + '\n');
        } catch (e) {
            console.error('群聊系统事件落盘失败', e);
        }
        g.events.push({...evt, ts: Date.now()});
    }

    function activeStreamOf(groupId) {
        for (const stream of streams.values()) {
            if (stream.groupId === groupId) return stream;
        }
        return null;
    }

    function clearTimers(stream) {
        if (stream.timers.first) {
            clearTimeout(stream.timers.first);
            stream.timers.first = null;
        }
        if (stream.timers.total) {
            clearTimeout(stream.timers.total);
            stream.timers.total = null;
        }
    }

    function fireTimeout(stream, which) {
        if (stream.finished) return;
        stream.timedOutBy = which;
        stream.timeout = true;
        stream.statusNote = which === 'first' ? '超时未发言' : '发言超时，已停止';
        try {
            backend.AIStop(stream.roundId);
        } catch (e) {
            console.error('AIStop 失败', e);
        }
        notify();
    }

    // 指定成员发言一次（G2 手动路径 / G3 主持人循环的执行单元）。
    // opts.focus：主持人/用户给本条发言的焦点（<chair_focus>）。
    async function speak(groupId, agentId, opts = {}) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        if (activeStreamOf(groupId)) return {ok: false, error: '已有成员正在发言（串行轮）'};
        const config = getAIConfig();
        const agents = agentsOf(config);
        const agent = agents.find((item) => item && item.id === agentId);
        if (!agent || !agent.enabled) return {ok: false, error: '成员不可用或已停用'};
        if ((g.meta.mutedAgentIds || []).includes(agentId)) return {ok: false, error: '该成员已被静音'};
        const resolved = resolveModel(agent.modelRef);
        if (!resolved || !resolved.profileCfg) return {ok: false, error: `${agent.name} 的模型不可用（账号或模型已删除）`};
        try {
            await ensureLoaded(groupId);
        } catch (e) {
            return {ok: false, error: '群聊记录读取失败：' + ((e && e.message) || e)};
        }
        const timeouts = memberTimeouts(g.meta, agent, config.profiles);
        const focus = String((opts && opts.focus) || '').trim();
        // 私有过程加载 + 确定性折叠（§3.11：只压自己的私有过程，共享对话不压缩）
        let ownSteps = [];
        try {
            ownSteps = parsePrivateSteps(await store.privateRead(groupId, agentId));
        } catch (e) {
            console.error('私有日志读取失败', e);
        }
        const window = resolved.entry && resolved.entry.contextWindow || g.meta.context.preferredWindow || 262144;
        const privateBudget = Math.max(1024, Math.round(window * 0.12));
        const folded = foldPrivateSteps(ownSteps, privateBudget);
        const built = buildMemberMessages({
            member: agent,
            group: g.meta,
            sharedMessages: g.messages,
            ownSteps: folded.steps,
            participantsText: participantsText(g.meta, agents, agent),
            boardText: '',
            focus,
            outputLanguage: (config && config.outputLanguage) || 'zh',
            memberWindow: window,
        });
        // 上下文门禁（§3.11）：共享对话装不下 → 该成员本轮停止参与，其他成员继续
        if (built.overflow) {
            await appendSystemEvent(groupId, {
                type: 'context-overflow',
                agentId,
                text: `${agent.name} 的上下文装不下全部群聊对话（估算 ${built.estimateTokens} > 预算 ${built.budget}），本轮停止参与；可压缩群聊数据或换更大窗口模型`,
            });
            return {ok: false, error: `${agent.name} 的上下文不足，已跳过（可压缩群聊数据或换更大窗口模型）`};
        }

        const seq = (groupSeq.get(groupId) || 0) + 1;
        groupSeq.set(groupId, seq);
        const roundId = groupId + '#' + agentId + '-' + seq;
        const stream = {
            roundId,
            groupId,
            agentId,
            agentName: agent.name,
            agentColor: agent.color,
            modelName: resolved.label || (resolved.entry && resolved.entry.model) || '',
            content: '',
            thinking: '',
            startedAt: Date.now(),
            firstActivityAt: 0,
            finished: false,
            timeout: false,
            timedOutBy: '',
            statusNote: '',
            error: '',
            timers: {first: null, total: null},
        };
        streams.set(roundId, stream);
        stream.timers.first = setTimeout(() => fireTimeout(stream, 'first'), timeouts.firstActivityMs);
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), timeouts.totalMs);
        notify();
        try {
            const sendResult = backend.AISendChat(roundId, resolved.profileCfg, built.messages, [], aiClampInt(config && config.retryMax, 0, 10, 5));
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return {ok: false, error: '发送失败：' + ((e && e.message) || e)};
        }
        return {ok: true, roundId};
    }

    function touch(stream) {
        if (!stream.firstActivityAt) {
            stream.firstActivityAt = Date.now();
            if (stream.timers.first) {
                clearTimeout(stream.timers.first);
                stream.timers.first = null;
            }
        }
    }

    async function persistSpeech(stream, info) {
        const g = groups.get(stream.groupId);
        if (!g) return;
        const gid = aiNowId('gm-');
        const finishedAt = Date.now();
        const msg = {
            gid,
            role: 'assistant',
            agentId: stream.agentId,
            agentName: stream.agentName,
            agentColor: stream.agentColor,
            model: stream.modelName,
            content: stream.content,
            ts: finishedAt,
            turnId: stream.roundId,
            round: currentRound(g.meta),
            replyTo: '',
            addressedTo: [],
            stance: '',
            groupBlock: null,
            usage: info.usage || null,
            hasPrivate: !!stream.thinking,
            timing: {
                startedAt: stream.startedAt,
                firstActivityAt: stream.firstActivityAt,
                finishedAt,
                ttftMs: stream.firstActivityAt ? stream.firstActivityAt - stream.startedAt : 0,
                totalMs: finishedAt - stream.startedAt,
            },
            timeout: stream.timeout,
            status: info.status,
            error: info.error || '',
        };
        try {
            await store.append(stream.groupId, encodeGroupMessage(msg) + '\n');
            g.messages.push(msg);
            if (stream.thinking) {
                const step = {
                    gid,
                    agentId: stream.agentId,
                    steps: [{kind: 'thinking', text: stream.thinking, signature: info.thinkingSignature || ''}],
                    ts: finishedAt,
                };
                await store.privateAppend(stream.groupId, stream.agentId, JSON.stringify(step) + '\n');
            }
            await saveMeta(stream.groupId, (meta) => {
                meta.messageCount = (meta.messageCount || 0) + 1;
                meta.lastMessageId = gid;
            });
        } catch (e) {
            flash('群聊消息落盘失败：' + ((e && e.message) || e), true);
        }
        if (info.status === 'timeout') {
            await appendSystemEvent(stream.groupId, {
                type: 'speech-timeout',
                agentId: stream.agentId,
                text: `${stream.agentName} 超时未完成发言（${stream.timedOutBy === 'first' ? '等待期内无输出' : '总时长超限'}），已跳过；下一轮可再请`,
            });
        }
    }

    function finishStream(stream, payload) {
        if (stream.finished) return;
        stream.finished = true;
        clearTimers(stream);
        const stopped = payload && payload.finishReason === 'stopped';
        const status = stream.timeout ? 'timeout' : (stopped ? 'stopped' : 'done');
        persistSpeech(stream, {
            status,
            usage: (payload && payload.usage) || null,
            thinkingSignature: (payload && payload.thinkingSignature) || '',
        });
        streams.delete(stream.roundId);
        notify();
    }

    function failStream(stream, message) {
        if (stream.finished) return;
        stream.finished = true;
        clearTimers(stream);
        stream.error = message;
        persistSpeech(stream, {status: stream.timeout ? 'timeout' : 'error', error: message, usage: null});
        streams.delete(stream.roundId);
        notify();
    }

    // ai-* 流事件入口（main.js 转发）：按 payload.id 精确认领本运行时发起的请求；
    // 不属于群 roundId 命名空间的事件静默忽略（主面板有自己的路由）。
    function handleEvent(name, payload) {
        const stream = streams.get(String((payload && payload.id) || ''));
        if (!stream) return;
        if (name === 'ai-chunk') {
            stream.content += String((payload && payload.delta) || '');
            touch(stream);
        } else if (name === 'ai-think') {
            stream.thinking += String((payload && payload.delta) || '');
            touch(stream);
        } else if (name === 'ai-retry') {
            stream.statusNote = `重试 ${payload.attempt}/${payload.max}：${payload.reason || ''}`;
        } else if (name === 'ai-queue') {
            stream.statusNote = payload.waitMs ? '排队等待限流…' : '';
        } else if (name === 'ai-param-adjust') {
            stream.statusNote = payload.message || '参数已自动调整';
        } else if (name === 'ai-done') {
            finishStream(stream, payload);
        } else if (name === 'ai-error') {
            failStream(stream, (payload && payload.message) || '请求失败');
        }
        notify();
    }

    // ---------- 用户消息与停止 ----------

    async function sendUserMessage(groupId, text) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const content = String(text || '').trim();
        if (!content) return {ok: false, error: '消息为空'};
        try {
            await ensureLoaded(groupId);
        } catch (e) {
            return {ok: false, error: '群聊记录读取失败：' + ((e && e.message) || e)};
        }
        const gid = aiNowId('gm-');
        const msg = {
            gid,
            role: 'user',
            agentId: '',
            agentName: '',
            agentColor: '',
            model: '',
            content,
            ts: Date.now(),
            turnId: '',
            round: currentRound(g.meta),
            replyTo: '',
            addressedTo: [],
            stance: '',
            groupBlock: null,
            usage: null,
            hasPrivate: false,
            timing: null,
            timeout: false,
            status: 'done',
            error: '',
        };
        try {
            await store.append(groupId, encodeGroupMessage(msg) + '\n');
        } catch (e) {
            return {ok: false, error: '消息落盘失败：' + ((e && e.message) || e)};
        }
        g.messages.push(msg);
        await saveMeta(groupId, (meta) => {
            meta.messageCount = (meta.messageCount || 0) + 1;
            meta.lastMessageId = gid;
        });
        return {ok: true, gid};
    }

    // 停止整场：roundId 都以 groupId# 开头，Go 侧前缀匹配全部取消（取消路径补发
    // ai-done finishReason=stopped → finishStream 归档）
    function stopAll(groupId) {
        try {
            backend.AIStop(groupId);
        } catch (e) {
            console.error('AIStop 失败', e);
        }
    }

    function stopOne(groupId, agentId) {
        const stream = activeStreamOf(groupId);
        if (stream && stream.agentId === agentId) {
            try {
                backend.AIStop(stream.roundId);
            } catch (e) {
                console.error('AIStop 失败', e);
            }
        }
    }

    return {
        init,
        refreshList,
        setListMode,
        getListMode: () => listMode,
        groupList,
        groupById: (id) => groups.get(id) || null,
        openGroup,
        createGroup,
        deleteGroup,
        saveMeta,
        subscribe,
        handleEvent,
        speak,
        sendUserMessage,
        stopAll,
        stopOne,
        activeStreamOf,
        store,
    };
}
