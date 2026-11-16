// ai-group-runtime.js：群聊运行时——群状态、磁盘适配、加载/创建/删除、发言路径与流事件。
// G2 单发言路径：按成员模型窗口组装请求（§3.11/§7.1）→ AISendChat → 流事件 → 超时/停止 → 落盘。
// G3 在此接主持人循环；G1 的群状态 / 创建 / 删除 / 订阅保持不变。
// main.js 把 ai-* 事件转发到 handleEvent（payload.id === roundId 精确认领）；侧栏与
// 标签页视图经 subscribe 拿快照。
import {aiClampInt, aiEstimateTokens, aiNowId} from './ai-constants.js';
import {
    GROUP_MEMBER_MAX,
    GROUP_MEMBER_MIN,
    GROUP_OUTPUT_RESERVE_TOKENS,
    TIMEOUT_PRESETS,
    applyStatePatch,
    buildChairMessages,
    buildMemberMessages,
    chairTimeouts,
    fallbackPlan,
    foldPrivateSteps,
    mergeGroupBlock,
    memberTimeouts,
    minutesFromBoard,
    normalizeChair,
    normalizeGroupMeta,
    parseChairContract,
    parseGroupBlock,
    parseMentions,
    sanitizeChairPlan,
    stripGroupBlock,
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
            chair: false,
            groupBlock: null,
            contract: null,
            timers: {first: null, total: null},
        };
        stream.done = new Promise((resolve) => {
            stream.resolve = resolve;
        });
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
        return {ok: true, roundId, done: stream.done};
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
            stance: (stream.groupBlock && stream.groupBlock.stance) || '',
            groupBlock: stream.groupBlock || null,
            usage: info.usage || null,
            hasPrivate: !!stream.thinking && !stream.noPrivate,
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
            chair: stream.chair === true,
        };
        try {
            await store.append(stream.groupId, encodeGroupMessage(msg) + '\n');
            g.messages.push(msg);
            if (stream.thinking && !stream.noPrivate) {
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

    async function finishStream(stream, payload) {
        if (stream.finished) return;
        stream.finished = true;
        clearTimers(stream);
        // 主持人流：先解析契约——chairMessage 进正文、原文不落盘（§3.6）；解析失败按错误归档
        if (stream.chair) {
            const contract = parseChairContract(stream.content);
            stream.contract = contract;
            if (!contract) {
                stream.error = '主持人输出无法解析为调度 JSON';
            } else {
                stream.content = contract.chairMessage || '';
            }
        } else {
            // 成员流：剥离 ```group 围栏，结构化块进 groupBlock（§3.5）
            stream.groupBlock = parseGroupBlock(stream.content);
            if (stream.groupBlock) stream.content = stripGroupBlock(stream.content);
        }
        const stopped = payload && payload.finishReason === 'stopped';
        const status = stream.timeout ? 'timeout' : (stopped ? 'stopped' : (stream.error ? 'error' : 'done'));
        await persistSpeech(stream, {
            status,
            usage: (payload && payload.usage) || null,
            thinkingSignature: (payload && payload.thinkingSignature) || '',
            error: stream.error,
        });
        streams.delete(stream.roundId);
        notify();
        if (stream.resolve) {
            stream.resolve({
                status,
                content: stream.content,
                contract: stream.contract,
                usage: (payload && payload.usage) || null,
                error: stream.error,
            });
        }
    }

    async function failStream(stream, message) {
        if (stream.finished) return;
        stream.finished = true;
        clearTimers(stream);
        stream.error = message;
        const status = stream.timeout ? 'timeout' : 'error';
        await persistSpeech(stream, {status, error: message, usage: null});
        streams.delete(stream.roundId);
        notify();
        if (stream.resolve) {
            stream.resolve({status, content: stream.content, contract: null, usage: null, error: message});
        }
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
        // 用户点名（§3.9）：@A / @全体成员 → 强制进下一次调度
        noteMentions(groupId, content);
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

    // ---------- 讨论引擎（G3，§3.3 / §3.6 / §3.7 / §3.9） ----------

    // 讨论状态为内存态：重启后按 meta.discussion.round 恢复展示，讨论需手动继续
    const discussions = new Map();

    function discussionOf(groupId) {
        let d = discussions.get(groupId);
        if (!d) {
            d = {
                running: false,
                paused: false,
                abort: false,
                phase: 'idle',        // idle | opening | speaking | review | paused | ended
                plan: [],
                nextPlan: null,
                roundDone: false,
                spokenThisRound: new Set(),
                forcedIds: [],        // 用户点名队列（优先于主持人计划，§3.9）
                speeches: 0,
                tokens: 0,
                startedAt: 0,
                chairFails: 0,
                needMinutes: false,
                error: '',
            };
            discussions.set(groupId, d);
        }
        return d;
    }

    function discussionSnapshot(groupId) {
        const d = discussions.get(groupId);
        const g = groups.get(groupId);
        if (!d || !g) return null;
        return {
            running: d.running,
            paused: d.paused,
            phase: d.phase,
            round: currentRound(g.meta),
            maxRounds: g.meta.maxRounds,
            speeches: d.speeches,
            spokenCount: d.spokenThisRound.size,
            memberCount: g.meta.memberIds.length,
            error: d.error,
        };
    }

    function chairAgentOf(meta, agents) {
        if (!meta.chair || meta.chair.kind === 'user') return null;
        return agents.find((item) => item && item.id === meta.chair.agentId) || null;
    }

    async function pauseForChairProblem(groupId, type, text) {
        const d = discussionOf(groupId);
        await appendSystemEvent(groupId, {type, text});
        d.paused = true;
        d.phase = 'paused';
        d.error = text;
        notify();
    }

    // 主持人一次调度调用（opening / review / minutes）。契约解析与 chairMessage 归档
    // 在 finishStream 内完成（chair 流）；这里只等结果并做回退判定。
    async function chairTurn(groupId, kind) {
        const g = groups.get(groupId);
        const config = getAIConfig();
        const agents = agentsOf(config);
        const meta = g.meta;
        const chairAgent = chairAgentOf(meta, agents);
        if (!chairAgent) return {ok: false, noChair: true};
        const resolved = resolveModel(chairAgent.modelRef);
        if (!resolved || !resolved.profileCfg) return {ok: false, error: `${chairAgent.name}（主持人）的模型不可用`};
        let chairSteps = [];
        try {
            chairSteps = parsePrivateSteps(await store.privateRead(groupId, chairAgent.id));
        } catch (e) { /* 私有日志读取失败按无过程处理 */ }
        const window = (resolved.entry && resolved.entry.contextWindow) || meta.context.preferredWindow || 262144;
        const folded = foldPrivateSteps(chairSteps, Math.max(1024, Math.round(window * 0.12)));
        const built = buildChairMessages({
            chairAgent,
            meta,
            sharedMessages: g.messages,
            chairSteps: folded.steps,
            kind,
            outputLanguage: (config && config.outputLanguage) || 'zh',
            memberWindow: window,
        });
        if (built.overflow) {
            return {ok: false, overflow: true, error: '主持人的上下文装不下全部群聊对话'};
        }
        const seq = (groupSeq.get(groupId) || 0) + 1;
        groupSeq.set(groupId, seq);
        const roundId = groupId + '#chair-' + kind + '-' + seq;
        const timeouts = chairTimeouts(meta, chairAgent, config.profiles);
        const stream = {
            roundId,
            groupId,
            agentId: chairAgent.id,
            agentName: '主持人',
            agentColor: chairAgent.color,
            modelName: resolved.label || '',
            content: '',
            thinking: '',
            startedAt: Date.now(),
            firstActivityAt: 0,
            finished: false,
            timeout: false,
            timedOutBy: '',
            statusNote: '主持人正在整理本轮…',
            error: '',
            chair: true,
            groupBlock: null,
            contract: null,
            timers: {first: null, total: null},
        };
        stream.done = new Promise((resolve) => {
            stream.resolve = resolve;
        });
        streams.set(roundId, stream);
        stream.timers.first = setTimeout(() => fireTimeout(stream, 'first'), timeouts.totalMs);
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), timeouts.totalMs);
        notify();
        try {
            const sendResult = backend.AISendChat(roundId, resolved.profileCfg, built.messages, [], aiClampInt(config && config.retryMax, 0, 10, 5));
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return {ok: false, error: '主持人调用失败：' + ((e && e.message) || e)};
        }
        const result = await stream.done;
        if (result.status !== 'done') return {ok: false, error: result.error || ('主持人调用' + result.status)};
        if (!result.contract) return {ok: false, parseFailed: true, error: result.error || '主持人输出无法解析'};
        return {ok: true, contract: result.contract};
    }

    function nextSpeaker(groupId) {
        const d = discussionOf(groupId);
        const g = groups.get(groupId);
        const meta = g.meta;
        // 用户点名优先（§3.9）：即使本轮已发言也允许追问；同一点名只消费一次
        while (d.forcedIds.length) {
            const id = d.forcedIds.shift();
            if (meta.memberIds.includes(id)) return {agentId: id, focus: '用户点名，请回应相关问题', agendaItem: ''};
        }
        while (d.plan.length) {
            const item = d.plan.shift();
            if (meta.memberIds.includes(item.agentId) && !d.spokenThisRound.has(item.agentId)) return item;
        }
        // 回退：本轮未发言成员按名单顺序（§3.6）
        const fallback = fallbackPlan({memberIds: meta.memberIds, mutedAgentIds: meta.mutedAgentIds, spokenThisRound: [...d.spokenThisRound]});
        return fallback.length ? fallback[0] : null;
    }

    async function generateMinutes(groupId, source) {
        const g = groups.get(groupId);
        if (!g) return;
        const text = (source && source.minutesText) || minutesFromBoard(g.meta);
        const chairAgent = chairAgentOf(g.meta, agentsOf(getAIConfig()));
        const gid = aiNowId('gm-');
        const msg = {
            gid,
            role: 'assistant',
            agentId: chairAgent ? chairAgent.id : 'chair',
            agentName: '主持人',
            agentColor: chairAgent ? chairAgent.color : '',
            model: (source && source.modelName) || '',
            content: text,
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
            chair: true,
            kind: 'minutes',
        };
        try {
            await store.append(groupId, encodeGroupMessage(msg) + '\n');
            g.messages.push(msg);
            await saveMeta(groupId, (meta) => {
                meta.minutes = {text, createdAt: Date.now(), source: (source && source.source) || 'board'};
                meta.messageCount = (meta.messageCount || 0) + 1;
                meta.lastMessageId = gid;
            });
        } catch (e) {
            flash('纪要落盘失败：' + ((e && e.message) || e), true);
        }
    }

    async function runDiscussion(groupId) {
        const d = discussionOf(groupId);
        const g = groups.get(groupId);
        if (!g || d.running) return;
        d.running = true;
        d.error = '';
        if (d.phase === 'idle' || d.phase === 'ended') d.phase = 'opening';
        notify();
        try {
            while (!d.abort) {
                const meta = g.meta;
                if (d.paused) {
                    d.phase = 'paused';
                    notify();
                    return;
                }
                if (d.startedAt && Date.now() - d.startedAt > (meta.timeouts.discussionTotalMs || 900000)) {
                    await appendSystemEvent(groupId, {type: 'budget', text: '整场讨论达到时长上限，已停止并生成纪要'});
                    d.needMinutes = true;
                    break;
                }
                if (d.speeches >= (meta.maxSpeeches || 12)) {
                    await appendSystemEvent(groupId, {type: 'budget', text: `达到发言次数上限（${meta.maxSpeeches}），已停止并生成纪要`});
                    d.needMinutes = true;
                    break;
                }
                if (d.phase === 'opening') {
                    if (!meta.chair || meta.chair.kind === 'user') {
                        // 用户主持：无开场调用，计划=成员顺序（§3.1 用户主持）
                        d.plan = fallbackPlan({memberIds: meta.memberIds, mutedAgentIds: meta.mutedAgentIds, spokenThisRound: []});
                        d.spokenThisRound = new Set();
                        d.phase = 'speaking';
                        continue;
                    }
                    const chair = await chairTurn(groupId, 'opening');
                    if (!chair.ok) {
                        if (chair.overflow) {
                            await pauseForChairProblem(groupId, 'chair-overflow', '主持人的上下文装不下全部群聊对话，讨论已暂停；请压缩群聊数据或更换主持人');
                            return;
                        }
                        d.chairFails++;
                        if (d.chairFails >= 2) {
                            await pauseForChairProblem(groupId, 'chair-fail', '主持人连续两次输出无法解析，讨论已暂停；可更换主持人或用「请发言」手动调度');
                            return;
                        }
                        d.plan = fallbackPlan({memberIds: meta.memberIds, mutedAgentIds: meta.mutedAgentIds, spokenThisRound: []});
                        d.spokenThisRound = new Set();
                        d.phase = 'speaking';
                        continue;
                    }
                    d.chairFails = 0;
                    const agents = agentsOf(getAIConfig());
                    d.plan = sanitizeChairPlan(chair.contract.plan, {
                        agents,
                        memberIds: meta.memberIds,
                        mutedAgentIds: meta.mutedAgentIds,
                        spokenThisRound: [],
                    });
                    d.spokenThisRound = new Set();
                    await saveMeta(groupId, (meta2) => {
                        if (chair.contract.statePatch) applyStatePatch(meta2, chair.contract.statePatch);
                        for (const item of chair.contract.plan) {
                            if (item.agendaItem && !meta2.discussion.agenda.includes(item.agendaItem)) {
                                meta2.discussion.agenda.push(item.agendaItem);
                            }
                        }
                        meta2.discussion.round = 1;
                    });
                    d.phase = 'speaking';
                    continue;
                }
                if (d.phase === 'speaking') {
                    const next = nextSpeaker(groupId);
                    if (!next) {
                        d.phase = 'review';
                        continue;
                    }
                    const r = await speak(groupId, next.agentId, {focus: next.focus});
                    if (!r.ok) {
                        // 成员不可用 / 上下文不足：标记本轮已处理并继续（不阻塞整轮，§3.16）
                        d.spokenThisRound.add(next.agentId);
                        continue;
                    }
                    const result = await r.done;
                    d.speeches++;
                    d.spokenThisRound.add(next.agentId);
                    d.tokens += (result.usage && result.usage.totalTokens) || 0;
                    const last = g.messages[g.messages.length - 1];
                    if (last && last.groupBlock) {
                        await saveMeta(groupId, (meta2) => mergeGroupBlock(meta2, last.agentId, last.agentName || '', last.groupBlock));
                    }
                    continue;
                }
                if (d.phase === 'review') {
                    let roundDone = true;
                    let nextPlan = null;
                    let minutesText = null;
                    if (meta.chair && meta.chair.kind !== 'user') {
                        const chair = await chairTurn(groupId, 'review');
                        if (!chair.ok) {
                            if (chair.overflow) {
                                await pauseForChairProblem(groupId, 'chair-overflow', '主持人的上下文装不下全部群聊对话，讨论已暂停；请压缩群聊数据或更换主持人');
                                return;
                            }
                            d.chairFails++;
                            if (d.chairFails >= 2) {
                                await pauseForChairProblem(groupId, 'chair-fail', '主持人连续两次输出无法解析，讨论已暂停；可更换主持人或用「请发言」手动调度');
                                return;
                            }
                            // 回退：本轮结束，进下一轮或收敛（§3.6）
                        } else {
                            d.chairFails = 0;
                            const contract = chair.contract;
                            await saveMeta(groupId, (meta2) => {
                                if (contract.statePatch) applyStatePatch(meta2, contract.statePatch);
                                if (contract.chairMessage) meta2.discussion.lastRoundSummary = contract.chairMessage.slice(0, 300);
                            });
                            roundDone = contract.roundComplete === true;
                            nextPlan = sanitizeChairPlan(contract.plan, {
                                agents: agentsOf(getAIConfig()),
                                memberIds: meta.memberIds,
                                mutedAgentIds: meta.mutedAgentIds,
                                spokenThisRound: [],
                            });
                            minutesText = contract.minutes;
                            if (contract.done) {
                                d.needMinutes = true;
                                if (minutesText) await generateMinutes(groupId, {minutesText, source: 'polish', modelName: '主持人'});
                                break;
                            }
                        }
                    }
                    if (roundDone) {
                        if (currentRound(meta) >= (meta.maxRounds || 2)) {
                            d.needMinutes = true;
                            break;
                        }
                        await saveMeta(groupId, (meta2) => {
                            meta2.discussion.round = currentRound(meta2) + 1;
                        });
                        d.spokenThisRound = new Set();
                        d.plan = Array.isArray(nextPlan) ? nextPlan : [];
                        d.phase = 'speaking';
                        continue;
                    }
                    // 轮未完（adaptive 剩余安排）：继续本轮发言
                    d.plan = Array.isArray(nextPlan) ? nextPlan : [];
                    d.phase = 'speaking';
                    continue;
                }
                break; // 未知阶段兜底退出
            }
        } finally {
            d.running = false;
            if (d.needMinutes) {
                d.needMinutes = false;
                d.phase = 'ended';
                if (!g.meta.minutes) await generateMinutes(groupId, {source: 'board'});
            } else if (d.phase !== 'paused') {
                d.phase = 'idle';
            }
            notify();
        }
    }

    function startDiscussion(groupId) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const d = discussionOf(groupId);
        if (d.running) return {ok: false, error: '讨论已在进行'};
        if (d.paused) return resumeDiscussion(groupId);
        d.abort = false;
        d.paused = false;
        d.startedAt = Date.now();
        d.speeches = 0;
        d.tokens = 0;
        d.phase = g.meta.discussion.round > 0 ? 'speaking' : 'opening';
        runDiscussion(groupId);
        return {ok: true};
    }

    function pauseDiscussion(groupId) {
        // 当前发言说完后停（§3.9）；在飞请求不打断
        discussionOf(groupId).paused = true;
        notify();
        return {ok: true};
    }

    function resumeDiscussion(groupId) {
        const d = discussionOf(groupId);
        if (!d.paused) return {ok: false, error: '讨论未处于暂停'};
        d.paused = false;
        d.abort = false;
        // 暂停把 phase 置成 'paused'；恢复后回到发言阶段（计划与轮次状态保持不变）
        if (d.phase === 'paused') d.phase = 'speaking';
        runDiscussion(groupId);
        return {ok: true};
    }

    function endDiscussion(groupId) {
        const d = discussionOf(groupId);
        d.abort = true;
        d.needMinutes = true;
        // 「结束并总结」立即中断在飞请求（§3.9）
        stopAll(groupId);
        notify();
        return {ok: true};
    }

    // 用户插话里的点名（§3.9）：@A / @全体成员 → 强制进下一次调度
    function noteMentions(groupId, text) {
        const g = groups.get(groupId);
        if (!g) return;
        const agents = agentsOf(getAIConfig());
        const names = g.meta.memberIds
            .map((id) => {
                const agent = agents.find((item) => item && item.id === id);
                return agent ? agent.name : '';
            })
            .filter(Boolean);
        const mentions = parseMentions(text, names);
        if (!mentions.all && !mentions.names.length) return;
        const d = discussionOf(groupId);
        if (mentions.all) {
            for (const id of g.meta.memberIds) {
                if (!d.forcedIds.includes(id)) d.forcedIds.push(id);
            }
        } else {
            for (const name of mentions.names) {
                const agent = agents.find((item) => item && item.name === name);
                if (agent && g.meta.memberIds.includes(agent.id) && !d.forcedIds.includes(agent.id)) {
                    d.forcedIds.push(agent.id);
                }
            }
        }
        appendSystemEvent(groupId, {type: 'mention', text: '用户点名：' + (mentions.all ? '@全体成员' : '@' + mentions.names.join(' @'))});
    }

    // ---------- 手动压缩群聊数据（§3.11：唯一能压缩共享对话的路径） ----------

    // cutoff 计算：默认保留最近 keepRounds 轮全文（§16.14）；keepRounds=0 表示全部进摘要
    function computeCutoff(messages, keepRounds) {
        const list = Array.isArray(messages) ? messages : [];
        const rounds = [...new Set(list.map((m) => m.round || 1))].sort((a, b) => a - b);
        if (!rounds.length) return '';
        if (keepRounds <= 0) return ''; // 全部摘要
        const keepFrom = rounds[Math.max(0, rounds.length - keepRounds)];
        const first = list.find((m) => (m.round || 1) === keepFrom);
        return first ? first.gid : '';
    }

    async function compressShared(groupId, opts = {}) {
        const g = groups.get(groupId);
        if (!g) return {ok: false, error: '群聊不存在'};
        const config = getAIConfig();
        const agents = agentsOf(config);
        // 摘要模型：指定 > 主持人 > 最大窗口成员（§16.13）
        let ref = opts.modelRef || '';
        if (!ref) {
            const chair = chairAgentOf(g.meta, agents);
            if (chair && chair.modelRef) ref = chair.modelRef;
        }
        let resolved = ref ? resolveModel(ref) : null;
        if (!resolved) {
            let best = null;
            for (const id of g.meta.memberIds) {
                const agent = agents.find((item) => item && item.id === id);
                if (!agent) continue;
                const cap = resolveModel(agent.modelRef);
                if (cap && cap.entry && (!best || (cap.entry.contextWindow || 0) > (best.entry.contextWindow || 0))) {
                    best = {...cap, agent};
                }
            }
            resolved = best;
        }
        if (!resolved || !resolved.profileCfg) return {ok: false, error: '没有可用的摘要模型'};
        const keepRounds = Number.isFinite(opts.keepRounds) ? Math.max(0, Math.round(opts.keepRounds)) : 1;
        const cutoff = computeCutoff(g.messages, keepRounds);
        if (keepRounds > 0 && !cutoff) return {ok: false, error: '对话还没有轮次分组，暂无法压缩'};
        const covered = g.messages.filter((m) => (keepRounds > 0 ? (m.round || 1) < (g.messages.find((x) => x.gid === cutoff) || {round: 1}).round : true));
        if (!covered.length) return {ok: false, error: '没有可压缩的历史（最近轮已全文保留）'};
        const window = (resolved.entry && resolved.entry.contextWindow) || 262144;
        const dialogueText = covered
            .map((m) => (m.role === 'user' ? '[用户] ' : '[' + (m.agentName || '成员') + '] ') + (m.content || ''))
            .join('\n\n');
        if (800 + aiEstimateTokens(dialogueText) > window) {
            return {ok: false, error: '所选摘要模型装不下待压缩的对话，请换更大窗口的模型'};
        }
        const messages = [
            {role: 'system', content: '你是讨论记录摘要器：把群聊对话压成一份中文摘要，保留共识、分歧（双方观点）、未决问题、行动项与关键论证；不新增观点、不遗漏分歧；3000 字以内。'},
            {role: 'user', content: '请摘要以下群聊对话（这是完整历史中较早的部分，最近一轮全文保留在原日志）：\n\n' + dialogueText},
        ];
        const seq = (groupSeq.get(groupId) || 0) + 1;
        groupSeq.set(groupId, seq);
        const roundId = groupId + '#compress-' + seq;
        const stream = {
            roundId,
            groupId,
            agentId: 'compress',
            agentName: '摘要器',
            agentColor: '',
            modelName: resolved.label || '',
            content: '',
            thinking: '',
            startedAt: Date.now(),
            firstActivityAt: 0,
            finished: false,
            timeout: false,
            timedOutBy: '',
            statusNote: '正在生成共享摘要…',
            error: '',
            chair: false,
            noPrivate: true,
            groupBlock: null,
            contract: null,
            timers: {first: null, total: null},
        };
        stream.done = new Promise((resolve) => {
            stream.resolve = resolve;
        });
        streams.set(roundId, stream);
        stream.timers.first = setTimeout(() => fireTimeout(stream, 'first'), g.meta.timeouts.chairMs || 60000);
        stream.timers.total = setTimeout(() => fireTimeout(stream, 'total'), g.meta.timeouts.chairThinkingMs || 240000);
        notify();
        try {
            const sendResult = backend.AISendChat(roundId, resolved.profileCfg, messages, [], aiClampInt(config && config.retryMax, 0, 10, 5));
            Promise.resolve(sendResult).catch((e) => failStream(stream, (e && e.message) || String(e)));
        } catch (e) {
            failStream(stream, (e && e.message) || String(e));
            return {ok: false, error: '摘要调用失败：' + ((e && e.message) || e)};
        }
        const result = await stream.done;
        if (result.status !== 'done' || !result.content) {
            return {ok: false, error: result.error || '摘要生成失败'};
        }
        await saveMeta(groupId, (meta) => {
            meta.sharedSummary = {
                text: result.content,
                cutoffGid: cutoff,
                createdAt: Date.now(),
                createdBy: 'user',
                summarizerModel: resolved.label || '',
            };
        });
        await appendSystemEvent(groupId, {
            type: 'compress',
            text: `群聊数据已压缩：摘要覆盖 ${covered.length} 条历史消息，最近 ${keepRounds} 轮全文保留；原始日志未删除`,
        });
        return {ok: true};
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
        // 讨论引擎（G3）
        startDiscussion,
        pauseDiscussion,
        resumeDiscussion,
        endDiscussion,
        discussionSnapshot,
        compressShared,
        store,
    };
}
