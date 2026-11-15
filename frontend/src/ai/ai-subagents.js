// ai-subagents.js：子代理域（spawn_agent 运行时 / HUD 头部角标与 chips 弹层 / 后台作业归类 /
// 详情视图的正文渲染与输入行）。详情视图挂在宿主给的根节点上：主窗口是内容区标签页
// （bridge-agent-view.js），悬浮窗退回面板内覆盖层 #ai-agent-view。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// 顺手删除了 sessionHasLiveBgJob 的重复定义（原 10923/10933 两份逐字相同，后者覆盖前者，保留一份）。
// hudReady/AGENT_STATE_LABEL 与 AI_SUB_* 常量随域迁入；chipsPopKind 经访问器读写。
import {iconSvg} from '../core/icons.js';
import {createTextarea} from '../core/form-controls.js';
import {aiClampInt, aiNowId, aiTextOf, AI_COMPACT_SYSTEM_PROMPT} from './ai-constants.js';
import {AI_TOOL_DEFS} from './ai-tool-defs.js';
import {inspectToolArguments} from './ai-tool-args.js';
import {buildSettlementNotice, buildAskNotice} from './ai-agent-notices.js';
import {compactTranscriptOf, computeCompactCutoff, buildCompactSummary, applyCompactToSession, buildCompactMessages, compactThresholdOf, COMPACT_KEEP_TAIL} from './ai-compact.js';

// 收件箱双队列的纯函数部分（导出供单测：消费顺序与来源前缀是「插队优先、主/用户可辨」的
// 唯一依据，闭包里改动不易测，这里单独留出来）。
// 消费顺序：step（插队）在前、turn（排队）在后——两者各自保持入队顺序。
export function takeInboxBatch(inbox) {
    if (!inbox) return [];
    return [...(inbox.step || []).splice(0), ...(inbox.turn || []).splice(0)];
}

// 来源前缀：主代理消息与用户插话在子代理上下文里必须能区分（agentView 输入行）。
export function inboxMessageText(item) {
    const prefix = item && item.from === 'user' ? '［用户插话］' : '［主代理消息］';
    return prefix + ' ' + String((item && item.text) || '');
}

// 冷唤醒准入：终态记录的可用性判断（失败 / 停止 / 上下文已回收都拒绝，附原因）。
export function canReviveRecord(record) {
    if (!record) return {ok: false, reason: 'missing'};
    if (record.state === 'error' || record.state === 'stopped') return {ok: false, reason: 'terminated'};
    if (record.continuable === false || !record.session) return {ok: false, reason: 'recycled'};
    return {ok: true, reason: ''};
}

// 记录是否诞生于本次唤醒之前（陈旧）：冷唤醒给旧记录打 revivedAt，新一轮落账时
// finishedAt 会超过它。wait_agent 只有确认不陈旧才允许把 record 当结论返回，
// 否则会把上一轮的结果当成本轮结果交给主代理（2026-11-15 实测缺陷）。
export function isStaleRecord(record) {
    if (!record || !record.revivedAt) return false;
    return (Number(record.finishedAt) || 0) < record.revivedAt;
}

// 子代理权限档：**继承父会话**，不写死 readonly。
// 读的边界（工作区内 / 可访问工作区外）由权限档决定，而「只读」由工具白名单
// （subToolsForScope）保证——子代理拿不到任何写工具，幻觉调用也会被 allowed 集合挡掉。
// 所以这里继承父档只放开路径范围：父会话是完全权限时，子代理读工作区外文件不该被拦，
// 否则跨目录调研只能由主代理逐段喂内容，多一层反而更慢更贵。
const SUB_SCOPES = ['read', 'edit', 'auto', 'full'];
export function subAgentScopeOf(parentScope) {
    return SUB_SCOPES.includes(parentScope) ? parentScope : 'read';
}

// 工具主参数速览：优先取「点名到具体对象」的字段，避免把整段 JSON 塞进工具行标题。
export function agentToolArgBrief(args) {
    let parsed = null;
    try {
        parsed = typeof args === 'string' ? JSON.parse(args || '{}') : (args || null);
    } catch (e) {
        return '';
    }
    if (!parsed || typeof parsed !== 'object') return '';
    for (const key of ['path', 'pattern', 'query', 'url', 'name', 'task', 'prompt', 'text']) {
        const value = parsed[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        const line = value.replace(/\s+/g, ' ').trim();
        return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }
    return '';
}

// 详情视图的块模型（导出供单测：块 key 与顺序是增量渲染「不重复、不丢块」的唯一依据）。
// 运行态取子代理自己的消息数组，终态取内存转录——两者形状不同，但都收敛到同一组块。
export function agentMessageBlocks(messages) {
    const blocks = [];
    (messages || []).forEach((m, index) => {
        if (!m) return;
        if (m.role === 'user') {
            blocks.push({key: 'm' + index, kind: 'user', text: String(m.content || '')});
        } else if (m.role === 'assistant') {
            const text = String(m.content || '').trim();
            // 思考与流式中间态不渲染，只看已落定的正文与工具
            if (text) blocks.push({key: 'm' + index, kind: 'assistant', text});
        } else if (m.role === 'tool') {
            blocks.push({
                key: 'm' + index, kind: 'tool', name: m.name,
                arg: agentToolArgBrief(m.arguments),
                text: String(m.content || ''), error: m.status === 'error',
            });
        }
    });
    return blocks;
}

export function agentTranscriptBlocks(transcript) {
    const blocks = [];
    (transcript || []).forEach((entry, index) => {
        if (!entry) return;
        if (entry.role === 'assistant') blocks.push({key: 't' + index, kind: 'assistant', text: String(entry.text || '')});
        else if (entry.role === 'tool') blocks.push({key: 't' + index, kind: 'tool', name: entry.name, text: String(entry.text || '')});
    });
    return blocks;
}

// 终态记录的块：**沿用运行态那套消息块**（key 同样是 m<i>），末尾补一张结论摘要卡。
// 为什么不能换成「摘要 + 转录」：done → 唤醒（agent_send / 用户插话）→ done 是子代理最常见的
// 交互形态，两套模型交替会让块 key 从 m<i> 变成 t<i>，正文节点整批删除重建——滚动位置被钳走、
// 图表卡片的 Shadow DOM 全毁，视图看起来就是「每来一条消息就跳回顶部」（2026-11-16 实测）。
// 摘要是本轮 assistant 正文的拷贝时不再重复挂：重复会多出一块，收尾瞬间高度又抖一次。
export function agentRecordBlocks(messages, summary) {
    const blocks = agentMessageBlocks(messages);
    const text = String(summary == null ? '' : summary).trim();
    if (!text) return blocks;
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    if (last && last.kind === 'assistant' && String(last.text || '').trim() === text) return blocks;
    blocks.push({key: 'summary', kind: 'summary', text});
    return blocks;
}

// 签名里带 streaming 标记：流式期间可视化卡片只占位，块落定后签名变化，
// 再渲染一次把占位换成真实卡片（与主消息区的 renderSig/streaming 写法同源）。
export function agentBlockSig(block, streaming) {
    const text = String((block && block.text) || '');
    return (block && block.kind) + '|' + (streaming ? 's' : 'd') + (block && block.error ? '!' : '') +
        (block && block.arg ? '@' + block.arg : '') +
        '|' + text.length + ':' + text.slice(-96);
}

export function createAISubagents(ctx) {
    const el = ctx.el;
    const panel = ctx.panel;
    const backend = ctx.backend;
    const flash = ctx.flash;
    const renderMarkdown = ctx.renderMarkdown;
    const openTermTab = ctx.openTermTab;
    // 详情视图的宿主出口：主窗口在内容区开标签页（bridge-agent-view.js），悬浮窗退回面板覆盖层
    const openAgentTab = typeof ctx.openAgentTab === 'function' ? ctx.openAgentTab : null;
    const isFloatWindow = typeof ctx.isFloatWindow === 'function' ? ctx.isFloatWindow : () => false;
    // 正文增强链（代码复制钮 / 本地图片 / mermaid·echarts·svg 可视化卡片）：与主消息区同一条
    const enhanceAnswerBody = typeof ctx.enhanceAnswerBody === 'function' ? ctx.enhanceAnswerBody : null;
    const currentSession = ctx.currentSession;
    const persistSessions = ctx.persistSessions;
    const sessionById = ctx.sessionById;
    const entryOf = ctx.entryOf;
    const profileOf = ctx.profileOf;
    const configForProfile = ctx.configForProfile;
    const executeTool = ctx.executeTool;
    // read_image 把画面挂成独立 user 消息：必须在工具批次结束后落盘（批次中途 push 会拆开
    // assistant(tool_calls) 与 tool 结果），与主循环共用面板那一份 flush。
    const flushToolImages = typeof ctx.flushToolImages === 'function' ? ctx.flushToolImages : null;
    const buildApiMessages = ctx.buildApiMessages;
    const refreshToolWrap = ctx.refreshToolWrap;
    const renderSessionList = ctx.renderSessionList;
    const aiDelay = ctx.aiDelay;
    const syncBgCardState = ctx.syncBgCardState;
    const reconcileBgJobs = ctx.reconcileBgJobs;
    const toolArgsErrorText = ctx.toolArgsErrorText;
    const agentRegistry = ctx.agentRegistry;
    const bgJobIndex = ctx.bgJobIndex;
    const bgJobLive = ctx.bgJobLive;
    const bgJobCursors = ctx.bgJobCursors;
    const bgUpdateListeners = ctx.bgUpdateListeners;
    const getChipsPopKind = ctx.getChipsPopKind;
    const setChipsPopKind = ctx.setChipsPopKind;
    const getConfig = ctx.getConfig;
    const newAssistantMessage = ctx.newAssistantMessage;
    const getSessions = ctx.getSessions;
    // 懒加载会话补正文（面板注入）：详情头部的状态兜底要用它——只补「所属会话」这一个，
    // 绝不为了找一个 spawn_agent 记录去扫全部会话。
    const ensureSessionLoaded = typeof ctx.ensureSessionLoaded === 'function'
        ? ctx.ensureSessionLoaded
        : () => Promise.resolve(true);
    // 操作留痕（ai-panel 闭包 helper）：子代理工具拒绝落盘；activity 为空时静默降级
    const logActivity = ctx.logActivity;
    // 压缩判定需要「窗口大小」与「当前上下文估算」——与主会话同一口径，不另立一套
    const contextWindowOf = ctx.contextWindowOf;
    const estimateApiMessagesTokens = ctx.estimateApiMessagesTokens;

    // —— 随域迁入的子代理状态与限额常量（原 ai-panel.js 闭包级）——
    const AI_SUB_LIMIT_DEFAULT = 20;
    const AI_SUB_LIMIT_MAX = 20;
    const AI_SUB_DEPTH_MAX = 20;
    // 主对话没有逐轮硬上限（靠 auto-compact 控体量）；子代理暂无压缩机制，
    // 硬上限是唯一闸门——按重型只读探索/规划的真实体量放宽（1M 窗口模型
    // 数百条消息仍远未满），撞顶时由强制收尾轮产出结论（见 runSubRound）。
    const AI_SUB_ROUNDS_DEFAULT = 50;
    const AI_SUB_MESSAGES_MAX = 400;
    // 终态记录保留上限（LRU）：超出先降级为「仅状态 + 结论摘要、不可续」，再超就删最早的。
    // 冷唤醒与子代理压缩都需要活引用（sub.session / profile / entry），不能 done 即删。
    const AI_SUB_RECORDS_MAX = 20;
    const AI_SUB_SYSTEM_PROMPT = [
        '你是主代理派出的只读子代理：独立完成任务后输出最终结论，不与用户直接交互。',
        '约束：只做只读探索（列目录 / 读文件 / 看图片 / 搜索 / 联网检索 / 记忆读取 / 技能加载）；不要尝试修改文件或执行命令；不要直接向最终用户发问（后台模式可用 ask_user 问主代理，由主代理决定）。',
        '你的工具范围在派出时已固定，无法从会话内放宽：范围外工具会被直接拒绝——不要换参数或写法重试，在最终结论中说明该限制即可，由主代理决定如何处理。',
        'timer_list 是主会话计时器的只读共享时钟：可用来对齐时间基准（正计时已计时长 / 倒计时剩余），但不能启动、停止或打标记；读数只是调用瞬间的快照，不会阻塞等待，不要靠反复调用来「等 N 秒」。',
        // 投递契约（§4.8）：投递层不截断（阶段 B 移除了 8000 字符上限），结论的紧凑性靠这里自律。
        '结果投递契约：主代理只会收到你的最终结论文本，看不到你的完整转录、工具输出或推理过程——最终结论必须自带结果与关键证据（path:line），不要指望父代理从过程记录里找信息。',
        '完成后输出一段结构化最终结论（要点 + 证据 path:line），它是你返回给主代理的唯一结果。',
    ].join('\n');
    let hudReady = false;             // HUD 块执行完才置真，之前的 renderSessionList 调用跳过
    // 详情视图挂载点：主窗口是内容区标签页、悬浮窗是面板内覆盖层。每个挂载点一个 view 对象，
    // 同一子代理可同时开多处（标签页 + 悬浮窗），各自独立节流渲染。
    const agentViews = new Set();
    let overlayView = null;           // 悬浮窗覆盖层上的那个挂载点（最多一个）
    const AGENT_STATE_LABEL = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'};

    const subAgents = new Map();      // subId -> 子代理运行态
    const subAgentTranscripts = new Map(); // spawn key -> [{role, name?, text}]
    // agentId -> 终态记录（含 sub.session / profile / entry 活引用）：冷唤醒、子代理压缩、
    // HUD 兜底都靠它。subAgents 仍只含运行中——事件路由先查 subAgents，records 只作兜底。
    const subAgentRecords = new Map();
    // 子代理压缩流注册表：compactId -> {id, subId, buffer, startedAt, auto, live}。
    // **不能复用全局 oneShot**（§4.10.1）：后台子代理压缩时父会话常在流式，全局锁会互相卡死。
    const subCompacts = new Map();
    let subCompactSeq = 0;
    // 收件箱（阶段 C 起启用）：排队 / 插队 / 提问挂起。这里先建结构，B 阶段不消费。
    function newSubInbox() {
        return {step: [], turn: [], ask: null};
    }

    // 上限统计 subAgents 里所有层级的运行中子代理（不含主代理），由设置页配置。
    function subAgentLimit() {
        return aiClampInt(getConfig().subAgentMax, 1, AI_SUB_LIMIT_MAX, AI_SUB_LIMIT_DEFAULT);
    }

    // 0 = 不设限；N = 子代理最多再往下递归 N 层（depth 从主代理派出的第 1 层开始计）。
    function subAgentMaxDepth() {
        return aiClampInt(getConfig().subAgentMaxDepth, 0, AI_SUB_DEPTH_MAX, 0);
    }

    function subAgentCanSpawn(depth) {
        const maxDepth = subAgentMaxDepth();
        return !maxDepth || depth < maxDepth;
    }

    function subSystemPromptFor(depth, mode) {
        let text = AI_SUB_SYSTEM_PROMPT;
        if (mode === 'background') {
            text += '\n你在后台运行：主代理不会等你结束，完成后由系统把结论通知给它；期间可以安心把探索做完整。';
            text += '\n关键决策点可以用 ask_user 向主代理提问（由主代理决定答案，或转询用户）：等待回答期间你的轮次暂停，约 2 分钟没有回答就请基于现有上下文自行决定并继续。';
        }
        if (subAgentCanSpawn(depth)) {
            text += '\n需要并行 / 隔离调查时可以再用 spawn_agent 派下一层只读子代理（总数与层级受设置限制）；简单问题直接自己做。';
        }
        return text;
    }

    function subToolsForScope(depth, mode) {
        const list = [
            AI_TOOL_DEFS.list_dir, AI_TOOL_DEFS.read_file, AI_TOOL_DEFS.read_image, AI_TOOL_DEFS.search_text,
            AI_TOOL_DEFS.web_search, AI_TOOL_DEFS.web_fetch,
            AI_TOOL_DEFS.memory_list, AI_TOOL_DEFS.memory_read,
            // 主会话计时器的只读快照：子代理与孙代理共用本表，只有读权（不能启动 / 停止 / 打标记）
            AI_TOOL_DEFS.timer_list,
            AI_TOOL_DEFS.skill_use, AI_TOOL_DEFS.env_list,
        ];
        // ask_user 只在后台模式挂载（§4.5 原语 6 的实现陷阱）：阻塞模式的父回合被 await
        // 占住，没人能回答，挂上去必然 120s 超时——按模式硬性区分，不靠提示词自觉。
        if (mode === 'background') list.push(AI_TOOL_DEFS.ask_user);
        if (subAgentCanSpawn(depth)) list.push(AI_TOOL_DEFS.spawn_agent);
        return list;
    }

    function activeSubCount() {
        let n = 0;
        for (const sub of subAgents.values()) if (sub.state === 'running') n++;
        return n;
    }

    function subTranscriptPush(sub, entry) {
        let list = subAgentTranscripts.get(sub.key);
        if (!list) {
            list = [];
            subAgentTranscripts.set(sub.key, list);
        }
        list.push(entry);
        while (list.length > 200) list.shift();
        // 工具行的出现/落定不经过 ai-chunk（长命令执行期间没有增量），详情视图得自己刷，
        // 否则「正在跑的工具」要等下一次正文增量才出现。300ms 节流在 scheduleAgentViewRender 里。
        refreshAgentViewIfOpen(sub.key);
    }

    function subThrottleRender(sub) {
        if (sub.renderTimer) return;
        sub.renderTimer = setTimeout(() => {
            sub.renderTimer = 0;
            const session = sessionById(sub.parentSessionId);
            if (session && sub.parentToolMessage) refreshToolWrap(session, sub.parentToolMessage);
            // 子代理详情视图开着时同步实时刷新（docs/finished-plans/ai-head-agents-terminal.md）
            for (const view of agentViews) {
                if (view.subId ? view.subId === sub.id : view.toolCallId === sub.key) scheduleAgentViewRender(view);
            }
        }, 350);
    }

    // ---- 头部 HUD：会话标题 + 智能体团队 / 后台终端入口 ----
    // 标题显示当前会话标题（自动标题/改名/切换经 renderSessionList 统一走 updateHeadHud）；
    // 两个 chip 是常驻入口：智能体团队（子代理状态）与后台终端（background_command 作业）。
    // 状态注册表声明在闭包顶部（el 之后），这里只放行为函数。

    function sessionTitleOf(sessionId) {
        const session = sessionById(sessionId);
        return session ? (session.title || '新会话') : '';
    }

    function sessionTitleById(id) {
        const session = getSessions().find((s) => s.id === id);
        return session ? (session.title || '新会话') : '';
    }

    function updateHeadIdentity() {
        if (!el.headTitle) return;
        const session = currentSession();
        const title = session ? String(session.title || '').trim() : '';
        el.headTitle.textContent = title || 'AI 助手';
        el.headTitle.dataset.tip = title || 'AI 助手';
    }

    function bgJobStateOf(entry) {
        const bg = entry && entry.message && entry.message.bg;
        return (bg && bg.state) || 'unknown';
    }

    // 头部两个入口与 dsh 一致：只展示「当前会话」的后台任务 / 子代理。
    // 子代理的会话对象带 rootSessionId，因此子代理里启动的后台命令归到根会话名下。
    function rootSessionIdOf(session) {
        if (!session) return '';
        return session.rootSessionId || session.parentSessionId || session.id || '';
    }

    function hudSessionId() {
        const session = currentSession();
        return session ? session.id : '';
    }

    function bgEntryOwnerId(entry) {
        if (!entry) return '';
        return entry.rootSessionId || rootSessionIdOf(entry.session);
    }

    function isBgEntryOfHud(entry) {
        const id = hudSessionId();
        return !!id && bgEntryOwnerId(entry) === id;
    }

    function hudBgEntries() {
        return [...bgJobIndex.values()].filter(isBgEntryOfHud);
    }

    // 某个会话是否还有正在跑的后台命令（会话列表的运行中标记用）
    function sessionHasLiveBgJob(sessionId) {
        if (!sessionId) return false;
        for (const entry of bgJobIndex.values()) {
            if (bgEntryOwnerId(entry) !== sessionId) continue;
            if (bgJobStateOf(entry) === 'running') return true;
        }
        return false;
    }

    function runningBgCount() {
        let n = 0;
        for (const entry of hudBgEntries()) {
            if (bgJobStateOf(entry) === 'running') n++;
        }
        return n;
    }

    function listAgentsForHud() {
        const out = [];
        const seen = new Set();
        const ownerId = hudSessionId();
        const belongs = (owner) => !ownerId || !owner || owner === ownerId;
        for (const sub of subAgents.values()) {
            seen.add(sub.key);
            if (!belongs(sub.rootSessionId || sub.parentSessionId)) continue;
            out.push({toolCallId: sub.key, key: sub.key, subId: sub.id, name: sub.name, task: sub.task,
                depth: sub.depth, state: 'running', startedAt: sub.startedAt,
                mode: sub.mode || 'blocking', continuable: true,
                inboxCount: unseenInboxCount(sub),
                compacting: !!sub.compacting,
                sessionTitle: sessionTitleOf(sub.parentSessionId)});
        }
        for (const [key, meta] of agentRegistry) {
            if (seen.has(key)) continue;
            seen.add(key);
            if (!belongs(meta.rootSessionId || meta.parentSessionId)) continue;
            out.push({...meta, toolCallId: key, key, sessionTitle: sessionTitleOf(meta.parentSessionId)});
        }
        // 终态记录兜底：records 里还活引用着的条目比 registry / 持久化 meta 更新（含续轮后的轮次与摘要）
        for (const rec of subAgentRecords.values()) {
            if (seen.has(rec.key)) continue;
            seen.add(rec.key);
            if (!belongs(rec.rootSessionId || rec.parentSessionId)) continue;
            out.push({
                toolCallId: rec.toolCallId || rec.key, key: rec.key, subId: rec.id, name: rec.name,
                task: rec.task, depth: rec.depth, state: rec.state, startedAt: rec.startedAt,
                rounds: rec.rounds, ms: rec.ms, tokens: rec.tokens, summary: rec.summary,
                mode: rec.mode, continuable: rec.continuable,
                sessionTitle: sessionTitleOf(rec.parentSessionId),
            });
        }
        // 重启后兜底：当前会话持久化的 spawn_agent meta（转录已不在内存）
        const session = currentSession();
        if (session) {
            for (const m of session.messages) {
                const key = (m.agent && m.agent.key) || m.toolCallId;
                if (m.role !== 'tool' || m.name !== 'spawn_agent' || !m.agent || seen.has(key)) continue;
                seen.add(key);
                out.push({toolCallId: key, key, depth: m.agent.depth || 1, name: m.agent.name || '子代理',
                    task: m.agent.task || '', state: m.agent.state || 'done', summary: m.agent.summary || '',
                    rounds: m.agent.rounds || 0, ms: m.agent.ms || 0, tokens: m.agent.tokens || 0,
                    sessionTitle: session.title || ''});
            }
        }
        return out;
    }

    function setChipCount(chip, total, running) {
        if (!chip) return;
        const countEl = chip.querySelector('.ai-chip-count');
        if (countEl) {
            if (total > 0) {
                countEl.textContent = running > 0 ? String(running) : String(total);
                countEl.classList.remove('hidden');
            } else {
                countEl.classList.add('hidden');
            }
        }
        chip.classList.toggle('ai-chip-live', running > 0);
    }

    // 后台作业 / 子代理状态变化：刷新头部角标，并让「会话列表的运行中标记」跟上。
    function notifyBackgroundActivity() {
        refreshHeadChips();
        renderSessionList();
    }

    function refreshHeadChips() {
        const agents = listAgentsForHud();
        const runningAgents = agents.filter((a) => a.state === 'running').length;
        const jobs = hudBgEntries();
        setChipCount(el.chipAgents, agents.length, runningAgents);
        setChipCount(el.chipTerms, jobs.length, runningBgCount());
    }

    function updateHeadHud() {
        if (!hudReady) return;
        updateHeadIdentity();
        refreshHeadChips();
    }

    function hideChipsPop() {
        setChipsPopKind('');
        if (el.chipsPop) el.chipsPop.classList.add('hidden');
    }

    function positionChipsPop(chip) {
        if (!el.chipsPop || !chip) return;
        const panelRect = panel.getBoundingClientRect();
        const chipRect = chip.getBoundingClientRect();
        if (!panelRect.height || !panelRect.width) return;
        // 先显示再量宽：挂在 chip 下方左对齐，超出面板右缘时往回收
        const width = el.chipsPop.offsetWidth || 320;
        el.chipsPop.style.top = (chipRect.bottom - panelRect.top + 6) + 'px';
        let left = chipRect.left - panelRect.left;
        if (left + width > panelRect.width - 8) left = Math.max(8, panelRect.width - width - 8);
        el.chipsPop.style.right = 'auto';
        el.chipsPop.style.left = Math.max(8, left) + 'px';
    }

    function agentStateBadge(state) {
        const span = document.createElement('span');
        span.className = 'ai-agent-badge ai-agent-' + (AGENT_STATE_LABEL[state] ? state : 'done');
        span.textContent = AGENT_STATE_LABEL[state] || '已结束';
        return span;
    }

    function agentStatusIcon(state) {
        if (state === 'running') return iconSvg('refresh', 12);
        if (state === 'exited') return iconSvg('check', 12);
        if (state === 'stopped' || state === 'notfound') return iconSvg('pause', 12);
        return iconSvg('warn', 12);
    }

    function bgJobFirstLine(command) {
        const line = String(command || '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
        if (!line) return '（空命令）';
        return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }

    function taskSnippet(task) {
        const line = String(task || '').replace(/\s+/g, ' ').trim();
        return line.length > 76 ? line.slice(0, 76) + '…' : line;
    }

    function openBgTermInContent(entry) {
        if (!openTermTab) {
            flash('当前宿主不支持内容区标签页', true);
            return;
        }
        const bg = (entry.message && entry.message.bg) || {};
        openTermTab({
            jobId: bg.jobId,
            command: entry.command,
            cwd: entry.cwd,
            state: bgJobStateOf(entry),
        });
    }

    function renderChipsPop(kind) {
        if (!el.chipsPop) return;
        el.chipsPop.textContent = '';
        // 其它域的弹层内容（如计时器）：经 ctx 注入的钩子接管，返回 true 表示已渲染
        if (typeof ctx.renderChipsPopExtra === 'function' && ctx.renderChipsPopExtra(kind, el.chipsPop)) return;
        const title = document.createElement('div');
        title.className = 'ai-chips-pop-title';
        title.textContent = kind === 'agents' ? '智能体团队' : '后台终端';
        el.chipsPop.appendChild(title);
        let rows = 0;
        if (kind === 'agents') {
            const agents = listAgentsForHud().sort((a, b) =>
                ((b.state === 'running') - (a.state === 'running')) || ((b.startedAt || 0) - (a.startedAt || 0)));
            for (const agent of agents) {
                rows++;
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'ai-chips-row';
                row.appendChild(agentStateBadge(agent.state));
                // 收件箱有未消费消息 / 等待主代理回答：单独一枚徽标（不改变 running 语义）
                if (agent.inboxCount > 0) {
                    const wait = document.createElement('span');
                    wait.className = 'ai-agent-badge ai-agent-waiting';
                    wait.textContent = '待处理 ' + agent.inboxCount;
                    wait.dataset.tip = '收件箱里有 ' + agent.inboxCount + ' 条消息还没被消费（子代理下一轮边界会读）';
                    row.appendChild(wait);
                }
                if (agent.compacting) {
                    const compacting = document.createElement('span');
                    compacting.className = 'ai-agent-badge ai-agent-waiting';
                    compacting.textContent = '压缩中';
                    row.appendChild(compacting);
                }
                const main = document.createElement('span');
                main.className = 'ai-chips-main';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'ai-chips-name';
                nameSpan.textContent = agent.name || '子代理';
                const subSpan = document.createElement('span');
                subSpan.className = 'ai-chips-sub';
                const bits = [];
                if (agent.depth > 1) bits.push('第 ' + agent.depth + ' 层');
                bits.push(taskSnippet(agent.task));
                if (agent.sessionTitle) bits.push('@ ' + agent.sessionTitle);
                subSpan.textContent = bits.join(' · ');
                main.append(nameSpan, subSpan);
                main.dataset.tip = (agent.task || '') + (agent.sessionTitle ? '（会话：' + agent.sessionTitle + '）' : '');
                row.appendChild(main);
                const go = document.createElement('span');
                go.className = 'ai-chips-go';
                go.innerHTML = iconSvg('chevron-right', 12);
                row.appendChild(go);
                row.addEventListener('click', () => {
                    hideChipsPop();
                    openAgentView({
                        toolCallId: agent.toolCallId,
                        subId: agent.subId || '',
                        name: agent.name || '子代理',
                        // 详情头部要在这个会话的正文里找 spawn_agent 记录：带上它，就能精确补
                        // 这一个会话（懒加载下别的会话可能只有 meta）
                        sessionId: (currentSession() || {}).id || '',
                    });
                });
                el.chipsPop.appendChild(row);
            }
        } else {
            const jobs = hudBgEntries().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
            for (const entry of jobs) {
                rows++;
                const state = bgJobStateOf(entry);
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'ai-chips-row';
                const icon = document.createElement('span');
                icon.className = 'ai-chips-status ai-status-' + state;
                icon.innerHTML = agentStatusIcon(state);
                row.appendChild(icon);
                const main = document.createElement('span');
                main.className = 'ai-chips-main';
                main.textContent = bgJobFirstLine(entry.command);
                main.dataset.tip = entry.command || '';
                row.appendChild(main);
                const go = document.createElement('span');
                go.className = 'ai-chips-go';
                go.innerHTML = iconSvg('chevron-right', 12);
                row.appendChild(go);
                row.addEventListener('click', () => {
                    hideChipsPop();
                    openBgTermInContent(entry);
                });
                el.chipsPop.appendChild(row);
            }
        }
        if (!rows) {
            const empty = document.createElement('div');
            empty.className = 'ai-chips-empty';
            empty.textContent = kind === 'agents'
                ? '暂无共享任务'
                : '暂无后台命令';
            el.chipsPop.appendChild(empty);
        }
    }

    function toggleChipsPop(kind, chip) {
        if (!el.chipsPop) return;
        if (getChipsPopKind() === kind) {
            hideChipsPop();
            return;
        }
        setChipsPopKind(kind);
        renderChipsPop(kind);
        el.chipsPop.classList.remove('hidden');
        positionChipsPop(chip);
        // 弹层打开时对账后台作业状态：错过的 cmd-exit 不会重放，避免永久显示运行中
        if (kind === 'terms') {
            reconcileBgJobs().then(() => {
                if (getChipsPopKind() !== 'terms') return;
                renderChipsPop('terms');
                positionChipsPop(chip);
            }).catch(() => {});
        }
    }

    // ---- 子代理详情视图（内容区标签页；悬浮窗退回面板内覆盖层） ----
    // 视图不再占满 AI 面板：主窗口点开「智能体团队」的一行 → 内容区标签页（可与主对话并排、
    // 输入框不被遮挡）；悬浮窗没有内容区，仍用 #ai-agent-view 覆盖层。
    // 正文按「块 + 内容签名」增量渲染：子代理流式输出时只重写变化的块——整段重建会销毁
    // mermaid / echarts / svg 卡片的 Shadow DOM，并把滚动位置拉回底部（实测每 300ms 一次）。

    function agentBlock(className, contentText, markdown) {
        const div = document.createElement('div');
        div.className = className;
        if (markdown) div.innerHTML = renderMarkdown(contentText || '');
        else div.textContent = contentText || '';
        return div;
    }

    // 工具行：名称 + 输出。视图是只读速览，超长输出截断（完整输出在父会话的工具卡里）。
    const AGV_TOOL_TEXT_MAX = 4000;

    function agentToolRow(block) {
        const row = document.createElement('div');
        row.className = 'ai-agv-tool';
        const label = document.createElement('span');
        label.className = 'ai-agv-tool-name';
        const pre = document.createElement('pre');
        row.append(label, pre);
        fillAgentToolRow(row, block || {});
        return row;
    }

    function fillAgentToolRow(row, block) {
        row.className = 'ai-agv-tool' + (block.error ? ' error' : '');
        const label = row.querySelector('.ai-agv-tool-name');
        if (label) {
            const suffix = block.error ? ' · 失败' : '';
            label.textContent = (block.name || 'tool') + (block.arg ? ' · ' + block.arg : '') + suffix;
            label.dataset.tip = (block.name || 'tool') + (block.arg ? ' ' + block.arg : '');
        }
        const pre = row.querySelector('pre');
        if (!pre) return;
        const raw = String(block.text || '');
        const cut = raw.length > AGV_TOOL_TEXT_MAX;
        pre.textContent = cut ? raw.slice(0, AGV_TOOL_TEXT_MAX) + '\n…（输出过长，已截断）' : raw;
        pre.dataset.tip = cut ? '完整输出见父会话里这张工具卡' : '';
    }

    // 正文块模型：user / assistant / tool / summary / inbox / tip。
    // key 稳定（消息下标、转录下标或固定名），内容签名变化才重写节点——增量渲染的唯一依据。
    function agentInboxBlock(sub) {
        const inbox = sub.inbox || {step: [], turn: [], ask: null};
        const stepN = (inbox.step || []).length;
        const turnN = (inbox.turn || []).length;
        if (!stepN && !turnN && !inbox.ask) return null;
        const lines = [...(inbox.step || []), ...(inbox.turn || [])].slice(0, 3).map((item) =>
            (item.from === 'user' ? '用户：' : '主代理：') + String(item.text || '').slice(0, 90));
        const ask = inbox.ask ? '等待主代理回答提问（askId=' + (inbox.ask.askId || '') + '）' : '';
        return {
            key: 'inbox',
            kind: 'inbox',
            title: '收件箱 · 排队 ' + turnN + ' 条 · 插队 ' + stepN + ' 条',
            lines,
            ask,
            // 签名只认可见内容：条数变化而文本相同时不必重写
            text: lines.join('\n') + '|' + ask,
        };
    }

    function agentBlocksOf(view) {
        const sub = view.subId ? subAgents.get(view.subId) : null;
        if (sub) {
            const blocks = agentMessageBlocks(sub.session && sub.session.messages);
            const inbox = agentInboxBlock(sub);
            if (inbox) blocks.push(inbox);
            return {blocks, live: true, sub};
        }
        // 终态记录：会话还在内存（done 可续 / 本轮刚收尾）就继续用消息块，别切成「摘要 + 转录」。
        // 两套模型交替 = 每次收尾/唤醒都整段换块，滚动位置与图表卡片全丢（见 agentRecordBlocks）。
        const rec = view.subId ? subAgentRecords.get(view.subId) : null;
        const recMessages = rec && rec.session ? rec.session.messages : null;
        if (recMessages && recMessages.length) {
            return {blocks: agentRecordBlocks(recMessages, rec.summary), live: false, sub: null};
        }
        // 退路：上下文已回收 / 应用重启后内存里没有会话，只剩摘要与转录
        const meta = agentStatusMeta(view);
        const summary = meta && meta.summary ? String(meta.summary) : '';
        const transcript = view.toolCallId ? subAgentTranscripts.get(view.toolCallId) : null;
        const blocks = [];
        if (summary) blocks.push({key: 'summary', kind: 'summary', text: summary});
        if (summary && transcript && transcript.length) {
            blocks.push({key: 'transcript-label', kind: 'label', text: '过程转录'});
        }
        blocks.push(...agentTranscriptBlocks(transcript));
        if (!blocks.length) {
            blocks.push({key: 'empty', kind: 'tip', text: '应用重启后子代理只保留状态与结论摘要；本次没有可显示的转录。'});
        }
        return {blocks, live: false, sub: null};
    }

    function createAgentBlockNode(block) {
        if (block.kind === 'assistant') return agentBlock('ai-agv-msg', '', true);
        if (block.kind === 'user') return agentBlock('ai-agv-user', '', false);
        if (block.kind === 'tip') return agentBlock('ai-agv-live-tip', '', false);
        if (block.kind === 'label') return agentBlock('ai-agv-summary-title', '', false);
        if (block.kind === 'tool') return agentToolRow(block);
        if (block.kind === 'summary') {
            const wrap = document.createElement('div');
            wrap.className = 'ai-agv-summary';
            const title = document.createElement('div');
            title.className = 'ai-agv-summary-title';
            title.textContent = '最终结论';
            const body = document.createElement('div');
            body.className = 'ai-agv-msg';
            wrap.append(title, body);
            return wrap;
        }
        // inbox：标题 + 逐条预览 + 提问挂起提示（与面板里的收件箱预览同款信息）
        const box = document.createElement('div');
        box.className = 'ai-agv-inbox';
        const title = document.createElement('div');
        title.className = 'ai-agv-inbox-title';
        box.appendChild(title);
        for (let i = 0; i < 3; i += 1) {
            const line = document.createElement('div');
            line.className = 'ai-agv-inbox-line';
            line.hidden = true;
            box.appendChild(line);
        }
        const ask = document.createElement('div');
        ask.className = 'ai-agv-inbox-ask';
        ask.hidden = true;
        box.appendChild(ask);
        return box;
    }

    function fillAgentBlockNode(node, block, streaming) {
        if (block.kind === 'tool') {
            fillAgentToolRow(node, block);
            return;
        }
        if (block.kind === 'inbox') {
            const title = node.querySelector('.ai-agv-inbox-title');
            if (title) title.textContent = block.title || '';
            const lines = [...node.querySelectorAll('.ai-agv-inbox-line')];
            lines.forEach((line, i) => {
                const text = (block.lines || [])[i];
                line.hidden = text == null;
                line.textContent = text == null ? '' : text;
            });
            const ask = node.querySelector('.ai-agv-inbox-ask');
            if (ask) {
                ask.hidden = !block.ask;
                ask.textContent = block.ask || '';
            }
            return;
        }
        if (block.kind === 'summary') {
            const body = node.querySelector('.ai-agv-msg');
            if (!body) return;
            paintAgentMarkdown(body, block.text, streaming);
            return;
        }
        if (block.kind === 'assistant') {
            paintAgentMarkdown(node, block.text, streaming);
            return;
        }
        node.textContent = block.text || '';
    }

    // 子代理正文与主消息区走同一条渲染链：Markdown → 代码块复制钮 → 本地图片 → 可视化卡片
    // （mermaid / echarts / svg / html / 关系图 / 词云）。缺了增强链，围栏只会剩一块源码占位。
    function paintAgentMarkdown(node, text, streaming) {
        node.innerHTML = renderMarkdown(text || '');
        if (enhanceAnswerBody) enhanceAnswerBody(node, {streaming: !!streaming});
    }

    function syncAgentBlocks(view, body, state) {
        // 先把阅读位置记下来，再动 DOM：块被删 / 整段换模型时长内容会瞬间缩短，
        // 浏览器会把 scrollTop 钳到新上限（内容短到一屏时直接钳成 0）。只在「原来就在底部」
        // 时吸附是不够的——上翻读的时候也会被钳走，表现就是滚动条自己往顶部跑。
        const prevTop = body.scrollTop;
        // 标签页在后台（display:none）时布局盒为 0：此时任何 scrollTop 写入都会被压成 0，
        // 等切回前台再看就「到顶了」。没有布局盒就只更新 DOM，不碰滚动。
        const measurable = body.clientHeight > 0 && body.scrollHeight > 0;
        // 首帧一律跟到底部：刚打开详情时正文常常一屏放不下（长派单提示词），此时 scrollTop=0
        // 会被误算成「用户在上翻」，于是整轮都不再跟随——表现就是滚动条一直卡在顶部，
        // 内容却还在下面长。落地之后才交由用户的真实位置决定。
        const pinned = !view.scrollReady || !measurable || body.scrollHeight - prevTop - body.clientHeight < 60;
        const blocks = state.blocks;
        const seen = new Set();
        let cursor = body.firstElementChild;
        blocks.forEach((block, index) => {
            seen.add(block.key);
            let node = view.blockNodes.get(block.key);
            if (!node) {
                node = createAgentBlockNode(block);
                node.dataset.agvKey = block.key;
                view.blockNodes.set(block.key, node);
            }
            // 只在「最后一块且子代理仍在跑」时按生成中处理：可视化卡片先占位不建实例
            const streaming = state.live && index === blocks.length - 1 && block.kind === 'assistant';
            const sig = agentBlockSig(block, streaming);
            if (node.dataset.agvSig !== sig) {
                node.dataset.agvSig = sig;
                fillAgentBlockNode(node, block, streaming);
            }
            // 块只追加，正常情况就地命中；万一乱序才搬一次（搬动会重置节点动画，别写成每帧都搬）
            if (node !== cursor) body.insertBefore(node, cursor || null);
            cursor = node.nextElementSibling;
        });
        for (const [key, node] of [...view.blockNodes]) {
            if (seen.has(key)) continue;
            view.blockNodes.delete(key);
            node.remove();
        }
        if (!measurable) return;
        if (pinned) {
            body.scrollTop = body.scrollHeight;
        } else if (body.scrollTop !== prevTop) {
            // 上翻读时把位置还回去（超出新上限会自动钳到 max，不会凭空回到顶部）
            body.scrollTop = prevTop;
        }
        view.scrollReady = true;
    }

    function agentStatusMeta(view) {
        const sub = view && view.subId ? subAgents.get(view.subId) : null;
        if (sub) {
            return {
                state: 'running',
                rounds: sub.flow ? sub.flow.roundNo : 0,
                ms: Math.max(0, Date.now() - sub.startedAt),
                tokens: sub.flow && sub.flow.usage ? (Number(sub.flow.usage.totalTokens) || 0) : 0,
                summary: '',
            };
        }
        // 终态记录（含可冷唤醒的 done）：比 registry 与持久化 meta 都新
        const rec = view && view.subId ? subAgentRecords.get(view.subId) : null;
        if (rec) {
            return {
                state: rec.state,
                rounds: rec.rounds,
                ms: rec.ms,
                tokens: rec.tokens,
                summary: rec.summary,
                mode: rec.mode,
                continuable: rec.continuable,
            };
        }
        const meta = view && view.toolCallId ? agentRegistry.get(view.toolCallId) : null;
        if (meta) return meta;
        // 内存正文兜底：先扫「打开详情时所在的那个会话」，再扫其余**已载体的**会话
        //（懒加载占位没有正文，扫也扫不到；旧实现会白扫几十个空数组）
        const owner = view && view.sessionId ? sessionById(view.sessionId) : null;
        const order = [];
        if (owner) order.push(owner);
        for (const session of getSessions()) {
            if (session !== owner && !session._stub) order.push(session);
        }
        for (const session of order) {
            for (const m of session.messages) {
                const key = (m.agent && m.agent.key) || m.toolCallId;
                if (m.role === 'tool' && m.name === 'spawn_agent' && key === view.toolCallId && m.agent) return m.agent;
            }
        }
        // 所属会话还是占位（启动后没点开过它）：只补这一个会话，补完重画一次头部。
        // 一次单文件读，不会变成「为了一个徽标扫全部会话」。
        if (owner && owner._stub) requestAgentRecordHydrate(view, owner);
        return null;
    }

    // 已发起过「补所属会话」的视图（key = subId / toolCallId），避免每次重画都读一次盘
    const agentRecordHydrateTried = new Set();

    function requestAgentRecordHydrate(view, session) {
        const key = String((view && (view.subId || view.toolCallId)) || '');
        if (!key || agentRecordHydrateTried.has(key)) return;
        agentRecordHydrateTried.add(key);
        Promise.resolve(ensureSessionLoaded(session))
            .then((ok) => { if (ok) scheduleAgentViewRender(view); })
            .catch(() => {});
    }

    // 头部每次重建（按钮随状态增删，代价很小）；正文与输入行是持久节点，正文内部再按块增量。
    function renderAgentHead(view, head) {
        head.textContent = '';
        const meta = agentStatusMeta(view);
        // 覆盖层没有标签栏，需要一个回主代理的出口；标签页靠关标签即可
        if (view.overlay) {
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'ai-icon-btn';
            back.dataset.tip = '返回主代理';
            back.setAttribute('aria-label', '返回主代理');
            back.innerHTML = iconSvg('back', 14);
            back.addEventListener('click', closeAgentView);
            head.appendChild(back);
        }
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ai-agent-view-name';
        nameSpan.textContent = view.name;
        nameSpan.dataset.tip = view.name;
        head.appendChild(nameSpan);
        if (meta) head.appendChild(agentStateBadge(meta.state));
        const liveSub = view.subId ? subAgents.get(view.subId) : null;
        const metaLine = document.createElement('span');
        metaLine.className = 'ai-agent-view-meta';
        const bits = [];
        if (meta && meta.rounds) bits.push('轮次 ' + meta.rounds);
        if (meta && meta.ms) bits.push(Math.max(1, Math.round(meta.ms / 1000)) + 's');
        if (meta && meta.tokens) bits.push((meta.tokens / 1000).toFixed(1) + 'k tok');
        if (meta && meta.mode === 'background') bits.push('后台');
        if (liveSub && liveSub.compacting) bits.push('压缩中');
        if (meta && meta.continuable === false) bits.push('上下文已回收');
        metaLine.textContent = bits.join(' · ');
        head.appendChild(metaLine);
        // 手动压缩入口：运行中 → 请求在下一轮边界执行；done 可续记录 → 立即压缩
        if (liveSub && liveSub.state === 'running' && !liveSub.compacting) {
            const compactBtn = document.createElement('button');
            compactBtn.type = 'button';
            compactBtn.className = 'ai-icon-btn ai-agv-compact';
            compactBtn.dataset.tip = '压缩这个子代理的上下文（当前工具轮结束后执行）';
            compactBtn.setAttribute('aria-label', '压缩上下文');
            compactBtn.innerHTML = iconSvg('eraser', 13);
            compactBtn.addEventListener('click', () => {
                liveSub.compactRequested = true;
                flash('已请求压缩：当前工具轮结束后执行');
                renderAgentView(view);
            });
            head.appendChild(compactBtn);
        } else if (!liveSub && view.subId) {
            const record = subAgentRecords.get(view.subId);
            const compactable = record && canReviveRecord(record).ok && !(record.session && record.session.summary);
            if (compactable) {
                const compactBtn = document.createElement('button');
                compactBtn.type = 'button';
                compactBtn.className = 'ai-icon-btn ai-agv-compact';
                compactBtn.dataset.tip = '立即压缩这个子代理的上下文（之后唤醒以精简上下文继续）';
                compactBtn.setAttribute('aria-label', '压缩上下文');
                compactBtn.innerHTML = iconSvg('eraser', 13);
                compactBtn.addEventListener('click', () => {
                    startSubCompact(record, {auto: false});
                    flash('已发起压缩：完成后唤醒将以精简上下文继续');
                    renderAgentView(view);
                });
                head.appendChild(compactBtn);
            }
        }
        // 后台子代理的结束时机独立于主回合：详情视图必须有手动停止入口（§4.6）
        if (liveSub && liveSub.state === 'running') {
            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'ai-icon-btn ai-agv-stop';
            stopBtn.dataset.tip = '停止这个子代理（保留它的过程记录）';
            stopBtn.setAttribute('aria-label', '停止子代理');
            stopBtn.innerHTML = iconSvg('pause', 13);
            stopBtn.addEventListener('click', () => {
                stopSubAgent(liveSub, '用户在详情视图停止');
                renderAgentView(view);
            });
            head.appendChild(stopBtn);
        }
    }

    function renderAgentView(view) {
        if (!view || !view.root) return;
        const root = view.root;
        if (!view.head) {
            view.head = document.createElement('div');
            view.head.className = 'ai-agent-view-head';
        }
        if (!view.body) {
            view.body = document.createElement('div');
            view.body.className = 'ai-agent-view-body';
        }
        renderAgentHead(view, view.head);
        // 结构固定为「头部 → 正文 → 输入行」；正文节点常驻，内部按块增量更新
        if (root.firstElementChild !== view.head) root.insertBefore(view.head, root.firstElementChild);
        if (view.head.nextElementSibling !== view.body) root.insertBefore(view.body, view.head.nextElementSibling);
        // 输入行先就位（独立节点，重渲染不重建——重建会丢焦点与草稿）。必须排在正文同步之前：
        // 首帧吸附要按「已经扣掉输入行」的正文高度算，否则会差一截（实测 36~40px）停不到底。
        const composer = ensureAgentViewComposer(view);
        if (composer) {
            if (root.lastElementChild !== composer) root.appendChild(composer);
        } else {
            const stale = root.querySelector('.ai-agv-composer');
            if (stale) stale.remove();
        }
        syncAgentBlocks(view, view.body, agentBlocksOf(view));
    }

    // 子代理对话视图的输入行（F3）：Enter 排队 / Ctrl+Enter 插队；对已完成且可续的子代理
    // 输入即冷唤醒入口；失败/停止/上下文已回收的记录禁用并说明原因。
    // 节点挂在 view 上复用——运行中的详情视图每 300ms 重渲染，重建输入框会丢焦点与草稿。
    function ensureAgentViewComposer(view) {
        const key = view.subId || '';
        const live = key ? subAgents.get(key) : null;
        const record = !live && key ? subAgentRecords.get(key) : null;
        const target = live || record;
        if (!target) {
            view.composer = null;
            return null;
        }
        const gate = live ? {ok: true, reason: ''} : canReviveRecord(record);
        const canType = gate.ok;
        const stateText = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'}[live ? 'running' : record.state] || '';
        let wrap = view.composer && view.composer.subId === key ? view.composer.el : null;
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'ai-agv-composer';
            // 表单控件走工厂（docs/frontend-form-controls.md）：className 覆盖默认封装 class，
            // 外观由 .ai-agv-input 自己适配详情视图的紧凑行
            const input = createTextarea({className: 'ai-agv-input', rows: 1, spellcheck: false}).control;
            const send = document.createElement('button');
            send.type = 'button';
            send.className = 'ai-agv-send';
            send.textContent = '发送';
            const submit = (urgent) => {
                const text = String(input.value || '').trim();
                if (!text) return;
                const current = view.subId ? subAgents.get(view.subId) : null;
                const rec = !current && view.subId ? subAgentRecords.get(view.subId) : null;
                if (current) {
                    if (urgent) {
                        const r = steerSubAgent(current, text, {from: 'user'});
                        flash(r.degraded ? '它正在压缩上下文，消息已排队（压缩完成后消费）' : '已插队：打断当前生成，消息在下一步最前注入');
                    } else {
                        queueSubAgentMessage(current, text, {from: 'user'});
                        flash('已排队：子代理下一轮可见');
                    }
                } else if (rec) {
                    const revived = reviveSubAgent(rec, text, {from: 'user', urgent});
                    flash(revived ? '已唤醒子代理「' + revived.name + '」，消息已投递' : '唤醒失败：上下文不可用，请重新派单', !revived);
                }
                input.value = '';
                renderAgentView(view);
            };
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                e.preventDefault();
                submit(e.ctrlKey || e.metaKey);
            });
            send.addEventListener('click', () => submit(false));
            wrap.append(input, send);
            view.composer = {subId: key, el: wrap};
        }
        // 状态可能变（running → done / 被停止）：每次渲染同步可用性与文案
        const input = wrap.querySelector('.ai-agv-input');
        const send = wrap.querySelector('.ai-agv-send');
        if (input) {
            input.disabled = !canType;
            input.placeholder = !canType
                ? (gate.reason === 'recycled'
                    ? '上下文已回收（终态记录超出上限），无法继续'
                    : '该子代理已' + stateText + '，不能再接收消息')
                : (live ? '给子代理补充线索：Enter 排队 · Ctrl+Enter 插队' : '它已完成，发消息会唤醒它继续：Enter 发送');
        }
        if (send) send.disabled = !canType;
        wrap.classList.toggle('disabled', !canType);
        return wrap;
    }

    function scheduleAgentViewRender(view) {
        if (!view || view.timer) return;
        view.timer = setTimeout(() => {
            view.timer = 0;
            renderAgentView(view);
        }, 300);
    }

    // 子代理状态事件带的是它的注册表 key（见 listAgentsForHud 的 toolCallId: sub.key）
    function refreshAgentViewIfOpen(agentKey) {
        if (!agentKey) return;
        for (const view of agentViews) {
            if (view.toolCallId === agentKey) scheduleAgentViewRender(view);
        }
    }

    // 挂载视图到任意宿主节点（内容区标签页 / 悬浮窗覆盖层）。同一节点重复挂载先清旧的，
    // 同一子代理可以同时挂在多处，各自独立节流。
    function mountAgentView(root, spec) {
        if (!root) return null;
        unmountAgentView(root);
        root.textContent = '';
        const view = {
            root,
            overlay: !!(spec && spec.overlay),
            toolCallId: String((spec && spec.toolCallId) || ''),
            subId: String((spec && spec.subId) || ''),
            name: String((spec && spec.name) || '子代理'),
            // 详情所在的会话：头部状态兜底要靠它的正文（懒加载下别的会话可能只有 meta）
            sessionId: String((spec && spec.sessionId) || ''),
            timer: 0,
            head: null,
            body: null,
            composer: null,
            blockNodes: new Map(),
            // 首帧是否已落地（syncAgentBlocks 里决定「跟到底部」还是「尊重用户位置」）
            scrollReady: false,
        };
        agentViews.add(view);
        renderAgentView(view);
        return view;
    }

    function unmountAgentView(root) {
        let removed = false;
        for (const view of [...agentViews]) {
            if (view.root !== root) continue;
            if (view.timer) {
                clearTimeout(view.timer);
                view.timer = 0;
            }
            agentViews.delete(view);
            removed = true;
        }
        return removed;
    }

    // 详情视图入口：主窗口在内容区标签页打开（不遮挡面板，可与主对话并排看），
    // 悬浮窗没有内容区，退回面板内覆盖层（原来的做法）。
    function openAgentView(spec) {
        const target = {
            toolCallId: String((spec && spec.toolCallId) || ''),
            subId: String((spec && spec.subId) || ''),
            name: String((spec && spec.name) || '子代理'),
            sessionId: String((spec && spec.sessionId) || ''),
        };
        if (!target.toolCallId && !target.subId) return;
        if (!isFloatWindow() && typeof openAgentTab === 'function') {
            if (openAgentTab(target)) return;
        }
        if (!el.agentView) return;
        el.agentView.classList.remove('hidden');
        overlayView = mountAgentView(el.agentView, {...target, overlay: true});
    }

    function closeAgentView() {
        if (overlayView) unmountAgentView(overlayView.root);
        overlayView = null;
        if (el.agentView) {
            el.agentView.classList.add('hidden');
            el.agentView.textContent = '';
        }
    }

    // ---- 后台命令桥接（供 main.js 的内容区终端标签页读取/订阅/停止） ----

    function bgJobSnapshot(jobId) {
        const entry = bgJobIndex.get(String(jobId || ''));
        if (!entry) return null;
        const live = bgJobLive.get(String(jobId || ''));
        const bg = (entry.message && entry.message.bg) || {};
        return {
            jobId: String(jobId || ''),
            command: entry.command,
            cwd: entry.cwd,
            startedAt: entry.startedAt,
            state: bg.state || 'unknown',
            code: bg.code == null ? null : bg.code,
            log: (live && live.text) || String(entry.message.bgLog || ''),
        };
    }

    function notifyBgListeners(jobId) {
        for (const fn of bgUpdateListeners) {
            try { fn(jobId); } catch (e) {}
        }
    }

    async function bridgeStopBgJob(jobId) {
        if (!backend.AICommandStop) throw new Error('当前版本不支持停止后台命令');
        const st = await backend.AICommandStop(String(jobId || ''));
        bgJobCursors.set(String(jobId || ''), Number(st && st.cursor) || 0);
        syncBgCardState(String(jobId || ''), st);
        return st || null;
    }

    if (el.chipAgents) {
        const iconEl = el.chipAgents.querySelector('.ai-chip-icon');
        if (iconEl) iconEl.innerHTML = iconSvg('agents', 13);
        el.chipAgents.addEventListener('click', () => toggleChipsPop('agents', el.chipAgents));
    }
    if (el.chipTerms) {
        const iconEl = el.chipTerms.querySelector('.ai-chip-icon');
        if (iconEl) iconEl.innerHTML = iconSvg('terminal', 13);
        el.chipTerms.addEventListener('click', () => toggleChipsPop('terms', el.chipTerms));
    }
    // 点面板其他位置关闭 chips 弹层
    panel.addEventListener('mousedown', (e) => {
        if (!getChipsPopKind()) return;
        if (e.target.closest && (e.target.closest('#ai-chips-pop') || e.target.closest('.ai-chip'))) return;
        hideChipsPop();
    });
    // 标题行宽度自适应：不够宽时只显示 icon（保留角标）
    const headTitleRow = panel.querySelector('.ai-head-title-row');
    if (headTitleRow && typeof ResizeObserver === 'function') {
        const headRO = new ResizeObserver(() => {
            headTitleRow.classList.toggle('ai-head-compact', headTitleRow.clientWidth < 420);
        });
        headRO.observe(headTitleRow);
    }
    // 面板在原闭包体位次（init 之后）调用：置 HUD 就绪并刷一次头部
    function initHud() {
        hudReady = true;
        updateHeadHud();
    }

    // 子代理的父会话（嵌套时取中间那层；找不到就回落当前会话）
    function parentSessionOfSub(sub) {
        return sessionById(sub && sub.parentSessionId) || sessionById(sub && sub.rootSessionId) || currentSession();
    }

    // 会话信箱（面板后构造，惰性取）：结算与提问通知都经它投递，本模块不持有队列。
    function noticesLike() {
        if (typeof ctx.getNotices !== 'function') return null;
        const mod = ctx.getNotices();
        return mod && typeof mod.deliverAgentNotice === 'function' ? mod : null;
    }

    // 建记录 + 注册 + 启动首轮，**不等待终态**（阶段 B 把 spawn 拆成 start / await 两段）。
    // mode='background'：超限直接报错、立即返回 agentId，主代理继续自己的回合；
    // mode='blocking'（默认）：等待空位后阻塞——行为与旧实现逐字一致，工具结果仍是唯一出口。
    async function startSubAgent(ctx, input) {
        if (!backend.AISendChat) throw new Error('当前版本不支持子代理');
        const mode = String(aiTextOf(input && input.mode) || 'blocking').toLowerCase() === 'background'
            ? 'background' : 'blocking';
        const name = aiTextOf(input.name).trim() || '子代理';
        const task = aiTextOf(input.task).trim();
        if (!task) throw new Error('task 不能为空');
        const maxRounds = aiClampInt(input.maxRounds, 3, 200, AI_SUB_ROUNDS_DEFAULT);
        const parentDepth = aiClampInt(ctx && ctx.agentDepth, 0, AI_SUB_DEPTH_MAX, 0);
        const depth = parentDepth + 1;
        const maxDepth = subAgentMaxDepth();
        if (maxDepth && depth > maxDepth) {
            throw new Error('子代理递归层级已达上限（最多 ' + maxDepth + ' 层）');
        }
        // 总数上限覆盖全部层级：主代理派单时等待空位，子代理再派直接拒绝（否则会与祖先互相等待）。
        // 后台模式不等待：排到队尾再等空位等于把工具调用变回阻塞，直接让模型稍后重试或改阻塞模式。
        const limit = subAgentLimit();
        if (activeSubCount() >= limit) {
            if (depth > 1) throw new Error('子代理总数已达上限 ' + limit + '（含各层级），无法继续派出');
            if (mode === 'background') {
                throw new Error('子代理总数已达上限 ' + limit + '，暂时无法派出后台子代理（可等现有子代理完成后再派，或改用阻塞模式排队）');
            }
            while (activeSubCount() >= limit) await aiDelay(300);
        }
        const parentSession = ctx.session;
        // 子代理归属到「根会话」：头部智能体团队 / 后台终端按会话展示时，
        // 嵌套子代理派出的任务也算在最初那个会话名下。
        const rootSessionId = rootSessionIdOf(parentSession);
        // 计时器只读共享用：派单时把「最初发起任务的主会话 id」逐层透传。
        // 递归派单时 parentSessionId 会变成上一层子代理 id，支线会话里光靠 rootSessionId 会丢主会话。
        const originSessionId = parentSession.originSessionId || parentSession.id;
        // 子代理继承「发起它的会话」的模型，而不是窗口默认
        const profile = profileOf(parentSession);
        const entry = entryOf(parentSession);
        if (!profile) throw new Error('无可用 AI 配置');
        const toolMessage = ctx.toolMessage;
        const sub = {
            id: aiNowId('sub-'),
            key: aiNowId('agent-'),
            toolCallId: toolMessage.toolCallId || aiNowId('agent-'),
            depth,
            mode,
            parentSessionId: parentSession.id,
            rootSessionId,
            parentToolMessage: toolMessage,
            name: name.slice(0, 16),
            task,
            maxRounds,
            state: 'running',
            startedAt: Date.now(),
            renderTimer: 0,
            heartbeat: 0,
            resolve: null,
            // settled：终态 promise（阶段 E 的 wait_agent 与 blocking 模式共用）。
            settled: null,
            session: null,
            flow: null,
            inbox: newSubInbox(),
        };
        toolMessage.agent = {
            key: sub.key,
            depth,
            mode,
            name: sub.name,
            task,
            state: 'running',
            rounds: 0,
            ms: 0,
            tokens: 0,
            summary: '',
            note: '',
        };
        sub.session = {
            id: sub.id,
            title: '',
            parentSessionId: parentSession.id,
            rootSessionId,
            originSessionId,
            workspace: parentSession.workspace || '',
            profileId: parentSession.profileId,
            // 继承母会话的「本次会话上下文上限」：省占用的意图覆盖整个会话活动
            //（子代理 auto-compact 的窗口基数随 contextWindowOf 一并收窄）
            ctxLimit: Number(parentSession.ctxLimit) || 0,
            systemPrompt: parentSession.systemPrompt || '',
            promptTemplateId: parentSession.promptTemplateId || '',
            // 权限档继承父会话（子代理不再无条件 readonly）：完全权限下才能读到工作区外，
            // 否则 read_file 的绝对路径会被按「路径超出工作区范围」拒掉。
            scope: subAgentScopeOf(parentSession.scope),
            planMode: false,
            // from:'agent'：派单 task 是主代理模型写的，不是用户输入——「用户点名路径」判定
            // （ai-read-roots.js userNamedPath）据此排除，防止注入经派单文本伪造点名。
            messages: [{role: 'user', content: task, ts: Date.now(), turnStartedAt: Date.now(), from: 'agent'}],
            todos: [],
            changes: [],
            approvedPaths: [],
            // 已批准的工作区外读根：新建为空；判定时实时回查父会话（ai-panel.js 授权链），不快照复制
            readRoots: [],
            summary: null,
            archived: [],
            round: 0,
        };
        sub.profile = profile;
        sub.entry = entry;
        const assistant = newAssistantMessage(profile, entry);
        sub.session.messages.push(assistant);
        sub.flow = {
            sessionId: sub.id,
            baseRound: 1,
            roundNo: 0,
            roundId: sub.id + '#1-0',
            assistant,
            startedAt: Date.now(),
            thinkStartedAt: 0,
            roundStartedAt: 0,
            firstTokenAt: 0,
            renderTimer: 0,
            finished: false,
            stopped: false,
            wrapUp: false,
            toolCalls: new Map(),
            profileCfg: configForProfile(profile, entry),
            systemPrompt: subSystemPromptFor(depth, mode),
            usage: null,
        };
        subAgents.set(sub.id, sub);
        agentRegistry.set(sub.key, {
            subId: sub.id, key: sub.key, toolCallId: sub.toolCallId, depth,
            parentSessionId: sub.parentSessionId, rootSessionId,
            name: sub.name, task: sub.task, state: 'running', startedAt: sub.startedAt,
            mode, rounds: 0, ms: 0, tokens: 0, summary: '',
        });
        notifyBackgroundActivity();
        persistSessions();
        refreshToolWrap(parentSession, toolMessage);
        // 先挂 resolve 再启动子代理轮：runSubRound 的同步失败路径（请求抛错/轮次上限/
        // 消息越限/索引丢失）会立刻 finalizeSubAgent，若此时 resolve 尚未挂上，主代理的
        // await 会永远悬挂（实测：子代理失败后主代理卡死无反馈）。见 2026-11-14 修复。
        const outcomePromise = new Promise((resolve) => { sub.resolve = resolve; });
        sub.settled = outcomePromise;
        runSubRound(sub);
        return {sub, outcome: outcomePromise};
    }

    // 阻塞模式：派单即等待终态（调用方拿到结论文本作为工具结果）。
    // 后台模式不走这里——ai-panel 的 spawn_agent case 用 startSubAgent 直接返回回执。
    async function runSubAgent(ctx, input) {
        const started = await startSubAgent(ctx, input);
        const outcome = await started.outcome;
        return outcome.text;
    }

    function runSubRound(sub) {
        const s = sub.flow;
        if (sub.state !== 'running' || s.stopped) {
            finalizeSubAgent(sub, s.stopped ? 'stopped' : sub.state);
            return;
        }
        // 收件箱消费（唯一消费点，§4.3）：先消费再判定预算 / 压缩，避免刚到的指令被
        // 压进摘要；wrapUp 收尾轮不消费（残余随终态进 records，结算文案会标注）。
        if (!s.wrapUp) consumeSubInbox(sub);
        // 轮边界压缩（§4.10.2）：顺序固定为「先消费收件箱再判压缩」，否则刚到的指令会被
        // 压进摘要；预算已尽（wrapUp 在即）不再压缩，把剩余轮次留给收尾。
        if (!s.wrapUp && s.roundNo < sub.maxRounds && maybeStartSubCompact(sub)) return;
        if (!s.wrapUp && (s.roundNo >= sub.maxRounds || sub.session.messages.length > AI_SUB_MESSAGES_MAX)) {
            // 预算用尽不再直接收尾：先跑一轮「无工具强制总结」——探索成果不能扔，
            // 占位符只会让主代理拿不到任何可用结论（2026-11-14 实测）。
            // 收尾轮不带工具（模型只能输出文本），roundId 继续递增保唯一。
            s.wrapUp = true;
            sub.session.messages.push({
                role: 'user',
                content: '轮次预算已用尽。不要再探索、不要调用任何工具：立即基于上面已完成的探索输出最终结论——要点 + 证据（path:line）。这是你返回给主代理的唯一结果。',
                ts: Date.now(),
            });
            const wrapAssistant = newAssistantMessage(sub.profile || profileOf(parentSessionOfSub(sub)), sub.entry || entryOf(parentSessionOfSub(sub)));
            sub.session.messages.push(wrapAssistant);
            s.assistant = wrapAssistant;
            runSubRound(sub);
            return;
        }
        s.roundNo += 1;
        s.roundId = sub.id + '#' + s.baseRound + '-' + s.roundNo;
        s.toolCalls.clear();
        s.thinkStartedAt = 0;
        s.roundStartedAt = Date.now();
        s.firstTokenAt = 0;
        // 子代理固定用派出时的配置；标签跟随实际配置，避免与主对话的模型切换串味。
        if (s.assistant && s.profileCfg && s.profileCfg.model) s.assistant.model = s.profileCfg.model;
        const index = sub.session.messages.indexOf(s.assistant);
        if (index < 0) {
            finalizeSubAgent(sub, 'error', '内部错误：子代理消息索引丢失');
            return;
        }
        const apiMessages = buildApiMessages(sub.session, index, s.systemPrompt);
        try {
            const request = backend.AISendChat(s.roundId, s.profileCfg, apiMessages, subToolsForScope(sub.depth, sub.mode), getConfig().retryMax);
            if (request && typeof request.then === 'function') {
                request.catch((e) => finalizeSubAgent(sub, 'error', (e && e.message) || String(e || '请求失败')));
            }
        } catch (e) {
            finalizeSubAgent(sub, 'error', (e && e.message) || String(e || '请求失败'));
        }
    }

    async function runSubToolRound(sub, calls, argErrors) {
        const s = sub.flow;
        // 子代理工具执行期间喂自己的流看门狗（与主流工具心跳同理）
        if (!sub.heartbeat && backend.AITouchStream) {
            sub.heartbeat = setInterval(() => {
                if (sub.state !== 'running') {
                    clearInterval(sub.heartbeat);
                    sub.heartbeat = 0;
                    return;
                }
                try { backend.AITouchStream(sub.id); } catch (e) {}
            }, 45000);
        }
        for (const call of calls) {
            if (sub.state !== 'running' || s.stopped) break;
            const toolMessage = {
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                arguments: call.arguments,
                content: '',
                status: 'running',
                ts: Date.now(),
            };
            sub.session.messages.push(toolMessage);
            const invalidArgs = argErrors && argErrors.get(call.id);
            if (invalidArgs) {
                toolMessage.status = 'error';
                toolMessage.content = invalidArgs;
                subTranscriptPush(sub, {role: 'tool', name: call.name, text: invalidArgs.slice(0, 600)});
                continue;
            }
            // 权限边界（dsh 同款语义）：范围外工具确定性拒绝、不进审批链路；模型侧文案
            // 明确「不重试、上报父会话」，拒绝本身落操作留痕（不含工具输入）。
            const allowed = new Set(subToolsForScope(sub.depth, sub.mode).map((tool) => tool.name));
            if (!allowed.has(call.name)) {
                toolMessage.status = 'error';
                toolMessage.content = '工具 ' + call.name + ' 超出子代理只读范围（工具范围在派出时已固定，无法从会话内放宽）；不要重试，请在最终结论中说明该限制，由主代理决定如何处理。';
                subTranscriptPush(sub, {role: 'tool', name: call.name, text: toolMessage.content.slice(0, 600)});
                logActivity('ai.tool', call.name, {status: 'denied', ms: 0, depth: sub.depth});
                continue;
            }
            let result = null;
            try {
                const parsed = call.arguments ? JSON.parse(call.arguments) : {};
                result = await executeTool(call.name, parsed, {session: sub.session, toolMessage, stream: s, agentDepth: sub.depth});
            } catch (e) {
                toolMessage.status = 'error';
                toolMessage.content = '工具执行失败：' + ((e && e.message) || e);
            }
            if (sub.state !== 'running' || s.stopped) break;
            if (result != null) {
                toolMessage.status = 'done';
                toolMessage.content = String(result);
            }
            subTranscriptPush(sub, {role: 'tool', name: call.name, text: String(toolMessage.content || '').slice(0, 600)});
        }
        if (sub.state !== 'running' || s.stopped) {
            // 停止时排队的图片也挂上：它们属于已完成的工具结果，丢掉会让转录与请求对不上
            if (flushToolImages) flushToolImages(sub.session);
            finalizeSubAgent(sub, s.stopped ? 'stopped' : sub.state);
            return;
        }
        // 工具批次结束才挂 read_image 的图片消息（批次中途 push 会拆开 assistant(tool_calls)
        // 与 tool 结果，下一轮请求会被服务商拒收）。
        if (flushToolImages) flushToolImages(sub.session);
        // 队列里的投递必须先消费成 user 消息、再 push 空的 assistant 续写目标。
        // 顺序反了（assistant 在前）时，runSubRound 用 buildApiMessages(sub.session,
        // indexOf(assistant)) 组装请求，只取 assistant 之前的历史，这条投递被整体排除，
        // 模型要再等一轮才看到（2026-11-16 实测：投递后仍按原任务多跑一轮）。
        // wrapUp 收尾轮不消费（与 runSubRound 同口径，残余随终态进 records）。
        if (!s.wrapUp) consumeSubInbox(sub);
        const assistant = newAssistantMessage(sub.profile || profileOf(parentSessionOfSub(sub)), sub.entry || entryOf(parentSessionOfSub(sub)));
        sub.session.messages.push(assistant);
        s.assistant = assistant;
        s.thinkStartedAt = 0;
        runSubRound(sub);
    }

    function handleSubEvent(name, payload, sub) {
        const s = sub.flow;
        if (!payload || payload.id !== s.roundId) return;
        switch (name) {
            case 'ai-chunk':
                if (payload.delta) {
                    s.assistant.content += payload.delta;
                    // 转录里维护一条「进行中」的助手条目，流式更新最后一条
                    const list = subAgentTranscripts.get(sub.key);
                    const last = list && list.length ? list[list.length - 1] : null;
                    if (last && last.role === 'assistant' && last.live) last.text = s.assistant.content;
                    else subTranscriptPush(sub, {role: 'assistant', text: s.assistant.content, live: true});
                    subThrottleRender(sub);
                }
                break;
            case 'ai-think':
                if (payload.delta) s.assistant.reasoning += payload.delta;
                break;
            case 'ai-toolcall': {
                const index = Number(payload.index) || 0;
                let call = s.toolCalls.get(index);
                if (!call) {
                    call = {id: '', name: '', arguments: ''};
                    s.toolCalls.set(index, call);
                }
                if (payload.callId) call.id = payload.callId;
                if (payload.name) call.name = payload.name;
                if (payload.argsDelta) call.arguments += payload.argsDelta;
                break;
            }
            case 'ai-done': {
                if (payload.usage) s.usage = payload.usage;
                // 结束「进行中」转录条目
                const list = subAgentTranscripts.get(sub.key);
                const last = list && list.length ? list[list.length - 1] : null;
                if (last && last.role === 'assistant' && last.live) {
                    last.text = String(s.assistant.content || '').slice(0, 2000);
                    last.live = false;
                }
                // 插队打断（原语 4）：主动停止当前在飞调用只是为了把新消息提到下一步边界，
                // **不是终止**——丢弃本轮半截工具调用、清停止标记，直接续轮；收件箱在
                // runSubRound 开头被消费。s.steerKick 只由 steerSubAgent 置位，
                // 用户停止走 stopSubAgent（它先清标记，所以不会被误判成续轮）。
                if (sub.steerKick) {
                    sub.steerKick = false;
                    s.toolCalls.clear();
                    s.stopped = false;
                    if (s.assistant && s.assistant.status === 'streaming') s.assistant.status = 'done';
                    // 插队消息先消费成 user 消息，再 push 空的 assistant——顺序反了会被
                    // buildApiMessages 的 index 截断排除，插队指令要再等一轮才生效（同
                    // runSubToolRound 的 2026-11-16 实测）。
                    if (!s.wrapUp) consumeSubInbox(sub);
                    const nextAssistant = newAssistantMessage(
                        sub.profile || profileOf(parentSessionOfSub(sub)),
                        sub.entry || entryOf(parentSessionOfSub(sub)));
                    sub.session.messages.push(nextAssistant);
                    s.assistant = nextAssistant;
                    s.thinkStartedAt = 0;
                    runSubRound(sub);
                    return;
                }
                const argErrors = new Map();
                const calls = [...s.toolCalls.values()]
                    .filter((call) => call.name)
                    .map((call, index) => {
                        const check = inspectToolArguments(call.arguments);
                        const id = call.id || ('call_sub_' + s.roundNo + '_' + index);
                        if (!check.valid && !check.repaired) {
                            argErrors.set(id, toolArgsErrorText(call.name, call.arguments));
                        }
                        return {id, name: call.name, arguments: check.text};
                    });
                s.toolCalls.clear();
                if (payload.finishReason === 'tool' && calls.length) {
                    // 写回 assistant 消息（镜像主路径）：buildApiMessages 只带
                    // 「assistant 自带 toolCalls 且有配对 tool 响应」的轮次，不写回
                    // 会把 tool 结果整条丢出历史，下一轮请求还会落进
                    // 「assistant 末条续写」形态，触发网关 reasoning_content 校验
                    // 400（2026-11-14 实测）。
                    s.assistant.toolCalls = calls;
                    s.assistant.status = 'done';
                    runSubToolRound(sub, calls, argErrors);
                    return;
                }
                finalizeSubAgent(sub, 'done');
                break;
            }
            case 'ai-error':
                if (s.wrapUp) {
                    // 收尾总结请求自身失败（如 60 条消息的上下文超窗）：
                    // 回退为转录摘录，不让探索成果跟着一起丢。
                    finalizeSubAgent(sub, 'done', subDigestOf(sub)
                        + '\n（收尾总结请求失败：' + (payload.message || '请求失败') + '）');
                    break;
                }
                finalizeSubAgent(sub, 'error', payload.message || '请求失败');
                break;
        }
    }

    // 收尾兜底：从转录拼探索记录摘录（tool 条目已在推送时截到 600 字）
    function subDigestOf(sub) {
        const list = subAgentTranscripts.get(sub.key) || [];
        const lines = [];
        for (const entry of list) {
            if (entry.role === 'tool') lines.push('- ' + entry.name + ': ' + String(entry.text || '').trim());
        }
        if (!lines.length) return '达到轮次上限，无可用探索记录';
        return '（未完成收尾总结，以下为探索记录摘录）\n' + lines.slice(-12).join('\n');
    }

    // 终态记录入册（LRU）：先保证活引用可用（冷唤醒 / 压缩要 sub.session），
    // 超出上限时最早的记录先降级为「仅状态 + 结论摘要、不可续」，再超就整条丢弃。
    function pushSubAgentRecord(sub, state, summary) {
        const s = sub.flow;
        const record = {
            id: sub.id,
            key: sub.key,
            toolCallId: sub.toolCallId,
            name: sub.name,
            task: sub.task,
            maxRounds: sub.maxRounds,
            depth: sub.depth,
            mode: sub.mode || 'blocking',
            parentSessionId: sub.parentSessionId,
            rootSessionId: sub.rootSessionId,
            state,
            summary,
            note: sub.note || '',
            rounds: s ? s.roundNo : 0,
            ms: Math.max(0, Date.now() - sub.startedAt),
            tokens: s && s.usage ? (Number(s.usage.totalTokens) || 0) : 0,
            startedAt: sub.startedAt,
            finishedAt: Date.now(),
            // 冷唤醒所需的活引用（continuable=false 时清空）
            session: sub.session || null,
            profile: sub.profile || null,
            entry: sub.entry || null,
            baseRound: s ? (Number(s.baseRound) || 1) : 1,
            continuable: state === 'done',
        };
        subAgentRecords.delete(sub.id);
        subAgentRecords.set(sub.id, record);
        while (subAgentRecords.size > AI_SUB_RECORDS_MAX) {
            const oldestKey = subAgentRecords.keys().next().value;
            const oldest = subAgentRecords.get(oldestKey);
            if (oldest && oldest.continuable !== false) {
                // 降级：丢活引用，只留状态与结论摘要（HUD 仍可展示，冷唤醒拒绝）
                subAgentRecords.set(oldestKey, {
                    ...oldest,
                    session: null, profile: null, entry: null, continuable: false,
                });
                subAgentTranscripts.delete(oldest.key);
            } else {
                subAgentRecords.delete(oldestKey);
            }
        }
        return record;
    }

    function finalizeSubAgent(sub, state, note) {
        if (sub.state !== 'running') return;
        sub.state = state;
        sub.note = note || '';
        // 兜底：任何终态都不留挂起的提问（否则 ask_user 的 await 永远不返回）
        if (sub.inbox && sub.inbox.ask) settleSubAsk(sub, '', 'stopped');
        if (sub.renderTimer) {
            clearTimeout(sub.renderTimer);
            sub.renderTimer = 0;
        }
        if (sub.heartbeat) {
            clearInterval(sub.heartbeat);
            sub.heartbeat = 0;
        }
        const s = sub.flow;
        s.stopped = state !== 'done';
        if (s.assistant && s.assistant.status === 'streaming') {
            s.assistant.status = state === 'done' ? 'done' : state;
        }
        try {
            if (backend.AIStop) backend.AIStop(sub.id);
        } catch (e) {}
        let summary = note || '';
        if (!summary && s.assistant) {
            summary = String(s.assistant.content || '').trim();
        }
        if (state === 'error' && !summary) summary = '子代理执行失败';
        if (!summary && s.wrapUp) summary = subDigestOf(sub);
        if (state === 'stopped') summary = summary ? '（用户停止）' + summary : '（用户停止）';
        // 阶段 B 决策（§4.4）：投递层不再截断。原 AI_SUB_SUMMARY_MAX（8000 字符）会把
        // 调研/扫描类子代理的长报告拦腰砍断且无路可取回，等于白跑。长度控制全部前移：
        // 投递契约（结论自带 path:line 证据）+ 模型单响应上限 + wrapUp 收尾轮。
        summary = summary.trim();
        const meta = sub.parentToolMessage && sub.parentToolMessage.agent;
        if (meta) {
            meta.state = state;
            meta.rounds = s.roundNo;
            meta.ms = Math.max(0, Date.now() - sub.startedAt);
            meta.tokens = s.usage ? (Number(s.usage.totalTokens) || 0) : 0;
            meta.summary = summary;
            meta.note = note || '';
        }
        const reg = agentRegistry.get(sub.key);
        if (reg) {
            reg.state = state;
            reg.summary = summary;
            reg.rounds = s.roundNo;
            reg.ms = Math.max(0, Date.now() - sub.startedAt);
            reg.tokens = s.usage ? (Number(s.usage.totalTokens) || 0) : 0;
        }
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        subAgents.delete(sub.id);
        // 终态记录：done 可续（冷唤醒），error/stopped 不可续但仍可查（「停止并收集记录」）。
        // 转录一律保留至本运行期——原语 2 要拿它做「收集对话记录」；内存由 records LRU 兜底。
        pushSubAgentRecord(sub, state, summary);
        try {
            if (sub.resolve) sub.resolve({ok: state === 'done', text: summary, state});
        } catch (e) {}
        persistSessions();
        const session = sessionById(sub.parentSessionId);
        if (session && sub.parentToolMessage) refreshToolWrap(session, sub.parentToolMessage);
        // 结算通知（原语 5 / 7）：后台模式专属——阻塞模式的结论已经作为工具结果交给主代理，
        // 再注入一份就是重复上下文。stopped 由发起方（用户 / agent_stop）自己知道，不发通知。
        if (sub.mode === 'background' && (state === 'done' || state === 'error') && session) {
            const hub = noticesLike();
            if (hub) {
                hub.deliverAgentNotice(session, buildSettlementNotice({
                    name: sub.name, agentId: sub.id, state, summary, note,
                    unconsumed: unseenInboxCount(sub),
                }));
            }
        }
        if (state === 'error') flash('子代理「' + sub.name + '」失败：' + (note || '执行出错'), true);
        else if (state === 'stopped') flash('子代理「' + sub.name + '」已停止');
    }

    // 停止时未消费的收件箱条数（阶段 C 起会非零；结算文案与工具回执都要标出来）。
    function unseenInboxCount(sub) {
        const inbox = sub && sub.inbox;
        if (!inbox) return 0;
        const n = (inbox.step || []).length + (inbox.turn || []).length + (inbox.ask ? 1 : 0);
        return n;
    }

    // 会话删除：它名下的终态记录与转录一并丢弃（records 是 LRU，但死会话的活引用没理由留着）
    function dropSubAgentRecordsOf(sessionId) {
        if (!sessionId) return 0;
        let n = 0;
        for (const [agentId, rec] of [...subAgentRecords]) {
            if (rec.parentSessionId !== sessionId && rec.rootSessionId !== sessionId) continue;
            subAgentRecords.delete(agentId);
            subAgentTranscripts.delete(rec.key);
            n++;
        }
        return n;
    }

    // ---- 子代理收件箱（对齐 dsh 的双队列：step 插队 / turn 排队）----

    // 唯一消费点。step 在前、turn 在后（插队优先），消费后清空。
    // 每条都落一条 notice user 消息，并同步进转录供详情视图查看。
    function consumeSubInbox(sub) {
        const batch = takeInboxBatch(sub.inbox);
        if (!batch.length) return 0;
        const ts = Date.now();
        for (const item of batch) {
            const content = inboxMessageText(item);
            sub.session.messages.push({role: 'user', content, ts, turnStartedAt: ts, notice: true});
            subTranscriptPush(sub, {role: 'user', text: content});
        }
        refreshAgentViewIfOpen(sub.key);
        return batch.length;
    }

    // 排队：子代理下一轮边界可见（不打断在飞调用）。
    function queueSubAgentMessage(sub, text, opts) {
        const item = {text: String(text || ''), from: (opts && opts.from) || 'agent', ts: Date.now()};
        sub.inbox.turn.push(item);
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        return item;
    }

    // 插队：插到队首并打断当前在飞模型调用（对齐主对话「停止当前回复并立即发送」）。
    // 压缩中降级为排队——压缩流正拿摘要，AIStop 会连摘要一起丢（§4.10.4）。
    function steerSubAgent(sub, text, opts) {
        const item = {text: String(text || ''), from: (opts && opts.from) || 'agent', ts: Date.now()};
        sub.inbox.step.unshift(item);
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        if (sub.compacting) return {item, kicked: false, degraded: true};
        sub.steerKick = true;
        try {
            if (backend.AIStop) backend.AIStop(sub.id);
        } catch (e) {}
        return {item, kicked: true, degraded: false};
    }

    // 统一停止：用户停止主回合、主代理 agent_stop、HUD 停止按钮都走这里。
    // 保留收件箱内容（停止当前轮 ≠ 清空队列），并把未消费条数写进结算文案。
    function stopSubAgent(sub, reason) {
        if (!sub || sub.state !== 'running') return false;
        // 插队标记必须清掉：否则 AIStop 引发的事件会被误判成「插队续轮」
        sub.steerKick = false;
        // 挂起中的提问先落定：否则 ask_user 那个 await 会一直悬着（工具轮不算结束）
        settleSubAsk(sub, '', 'stopped');
        // 压缩中停止：AIStop(sub.id) 的「精确 id 或 id# 前缀」匹配会连压缩流一起取消，
        // 这里同步清注册表与标记，避免 compacting 永久卡住（§4.10.4）
        for (const [compactId, job] of [...subCompacts]) {
            if (job.subId !== sub.id) continue;
            subCompacts.delete(compactId);
        }
        sub.compacting = false;
        sub.compactRequested = false;
        sub.flow.stopped = true;
        try {
            if (backend.AIStop) backend.AIStop(sub.id);
        } catch (e) {}
        finalizeSubAgent(sub, 'stopped', reason || '');
        return true;
    }

    // 过程记录摘要（原语 2「停止并收集记录」）：最后一条输出 + 最近工具调用概览。
    function subRunDigest(key) {
        const list = subAgentTranscripts.get(key) || [];
        const tools = list.filter((entry) => entry.role === 'tool');
        const lastAssistant = [...list].reverse().find((entry) => entry.role === 'assistant' && !entry.live);
        const lines = [];
        if (lastAssistant && String(lastAssistant.text || '').trim()) {
            lines.push('最后一条输出：', String(lastAssistant.text).trim());
        }
        if (tools.length) {
            lines.push('已执行工具 ' + tools.length + ' 次，最近：');
            for (const entry of tools.slice(-8)) {
                lines.push('- ' + (entry.name || 'tool') + '：' + String(entry.text || '').trim().slice(0, 160));
            }
        }
        return lines.join('\n') || '（没有可用的过程记录）';
    }

    // 冷唤醒：对 done 且记录仍持有活引用的子代理继续派活（baseRound+1，事件路由照旧）。
    function reviveSubAgent(record, text, opts) {
        if (!record || record.continuable === false || !record.session || !record.profile) return null;
        // 唤醒时间戳：新一轮落账前，wait_agent 靠它识别「手上这份是唤醒前的旧结论」，
        // 不把上一轮结果当成本轮结果返回（2026-11-15 实测缺陷）。
        record.revivedAt = Date.now();
        const parent = sessionById(record.parentSessionId);
        const toolMessage = parent
            ? parent.messages.find((m) => m.role === 'tool' && m.toolCallId === record.toolCallId) || null
            : null;
        const sub = {
            id: record.id,
            key: record.key,
            toolCallId: record.toolCallId,
            depth: record.depth,
            mode: record.mode || 'background',
            parentSessionId: record.parentSessionId,
            rootSessionId: record.rootSessionId,
            parentToolMessage: toolMessage,
            name: record.name,
            task: record.task,
            maxRounds: Number(record.maxRounds) || AI_SUB_ROUNDS_DEFAULT,
            state: 'running',
            startedAt: Date.now(),
            renderTimer: 0,
            heartbeat: 0,
            resolve: null,
            settled: null,
            session: record.session,
            profile: record.profile,
            entry: record.entry,
            inbox: newSubInbox(),
        };
        const assistant = newAssistantMessage(record.profile, record.entry);
        sub.flow = {
            sessionId: sub.id,
            baseRound: (Number(record.baseRound) || 1) + 1,
            roundNo: 0,
            roundId: sub.id + '#' + ((Number(record.baseRound) || 1) + 1) + '-0',
            assistant,
            startedAt: Date.now(),
            thinkStartedAt: 0,
            roundStartedAt: 0,
            firstTokenAt: 0,
            renderTimer: 0,
            finished: false,
            stopped: false,
            wrapUp: false,
            toolCalls: new Map(),
            profileCfg: configForProfile(record.profile, record.entry),
            systemPrompt: subSystemPromptFor(record.depth, record.mode),
            usage: null,
        };
        // 终态记录移出（重新变 live）：事件路由、HUD、LRU 都以 subAgents 为准
        subAgentRecords.delete(sub.id);
        subAgents.set(sub.id, sub);
        if (toolMessage && toolMessage.agent) {
            toolMessage.agent.state = 'running';
            toolMessage.agent.note = '';
        }
        const reg = agentRegistry.get(sub.key);
        if (reg) {
            reg.state = 'running';
            reg.summary = '';
            reg.note = '';
        }
        notifyBackgroundActivity();
        persistSessions();
        if (toolMessage && parent) refreshToolWrap(parent, toolMessage);
        // 投递消息必须先消费成 user 消息、再 push 空的 assistant 续写目标。
        // 顺序反了（assistant 在前）时，runSubRound 用 buildApiMessages(sub.session,
        // indexOf(assistant)) 组装请求，只会取到 assistant 之前的消息，这条投递被整体排除，
        // 模型只能续写唤醒前的旧上下文，产出上一轮的答案（2026-11-16 实测：last=0、
        // len≈上一轮长度）。runSubRound 开头的 consumeSubInbox 此时收件箱已空，是 no-op。
        queueSubAgentMessage(sub, text, {from: (opts && opts.from) || 'agent'});
        if (opts && opts.urgent) sub.inbox.step.unshift(sub.inbox.turn.pop());
        consumeSubInbox(sub);
        sub.session.messages.push(assistant);
        const outcomePromise = new Promise((resolve) => { sub.resolve = resolve; });
        sub.settled = outcomePromise;
        runSubRound(sub);
        return sub;
    }

    // agent_send 执行体：运行中排队 / 插队，已完成冷唤醒，失败记录拒绝。
    function sendToSubAgent(input, ctx) {
        const agentId = aiTextOf(input && input.agentId).trim();
        const message = aiTextOf(input && input.message).trim();
        if (!agentId) throw new Error('agentId 不能为空');
        if (!message) throw new Error('message 不能为空');
        const urgent = input && input.urgent === true;
        const askId = aiTextOf(input && input.askId).trim();
        const live = subAgents.get(agentId);
        if (live) {
            // 提问回答（阶段 D）：命中挂起中的 askId 就地落定，不再走队列
            const answered = answerSubAsk(live, askId, message);
            if (answered) return answered;
            if (urgent) {
                const r = steerSubAgent(live, message, {from: 'agent'});
                return '已插队投递给子代理「' + live.name + '」：打断了它当前的模型调用，' +
                    '消息将在下一步最前注入。' + (r.degraded ? '（它正在压缩上下文，本次改为排队，压缩完成后消费）' : '');
            }
            queueSubAgentMessage(live, message, {from: 'agent'});
            return '已排队投递给子代理「' + live.name + '」：它当前轮结束后（下一轮边界）可见。';
        }
        const record = subAgentRecords.get(agentId);
        if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）：可用 wait_agent 或重新 spawn_agent');
        const gate = canReviveRecord(record);
        if (!gate.ok) {
            if (gate.reason === 'terminated') {
                throw new Error('子代理「' + record.name + '」已' + (record.state === 'error' ? '失败' : '停止') +
                    '，不能继续；需要的话重新 spawn_agent 派单');
            }
            if (gate.reason === 'recycled') {
                throw new Error('子代理「' + record.name + '」的上下文已回收（终态记录超出上限），无法继续；请重新派单');
            }
            throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
        }
        const revived = reviveSubAgent(record, message, {from: 'agent', urgent});
        if (!revived) throw new Error('子代理「' + record.name + '」无法唤醒（缺少父会话或模型配置）；请重新派单');
        return '已唤醒子代理「' + revived.name + '」（id=' + revived.id + '，第 ' + (revived.flow.baseRound) +
            ' 轮起继续），消息已投递。完成后会照常通知你。';
    }

    // agent_stop 执行体：停止运行中的子代理并收集过程记录；对终态记录返回历史摘要。
    function stopSubAgentByInput(input) {
        const agentId = aiTextOf(input && input.agentId).trim();
        if (!agentId) throw new Error('agentId 不能为空');
        const live = subAgents.get(agentId);
        if (live) {
            const unconsumed = unseenInboxCount(live);
            const name = live.name;
            const key = live.key;
            stopSubAgent(live, '主代理停止');
            const record = subAgentRecords.get(agentId);
            const summary = (record && record.summary) || '';
            return '已停止子代理「' + name + '」' +
                (unconsumed ? '（停止时仍有 ' + unconsumed + ' 条未消费消息）' : '') + '。\n' +
                (summary ? '进度与结论：\n' + summary + '\n' : '') +
                '过程记录：\n' + subRunDigest(key);
        }
        const record = subAgentRecords.get(agentId);
        if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
        const stateText = {done: '已完成', error: '已失败', stopped: '已停止'}[record.state] || record.state;
        return '子代理「' + record.name + '」' + stateText +
            '（轮次 ' + (record.rounds || 0) + ' · 用时 ' + Math.round((record.ms || 0) / 1000) + 's）。\n' +
            '结论：\n' + (record.summary || '（无结论）') + '\n' +
            '过程记录：\n' + subRunDigest(record.key);
    }

    // ---- 子代理压缩（§4.10）：auto-compact 在轮边界触发；手动由 agent_compact 与详情视图发起 ----

    function subContextTokens(sub) {
        const s = sub.flow;
        if (!s) return 0;
        try {
            return estimateApiMessagesTokens(buildApiMessages(sub.session, null, s.systemPrompt));
        } catch (e) {
            return 0;
        }
    }

    // 轮边界判定（runSubRound 调用）。返回 true = 已发起压缩，本轮先不继续（压缩完成后续轮）。
    function maybeStartSubCompact(sub) {
        if (sub.compacting) return false;
        const manual = sub.compactRequested === true;
        if (!manual && getConfig().autoCompact !== true) return false;
        if ((sub.session.messages || []).length <= COMPACT_KEEP_TAIL) {
            sub.compactRequested = false;
            return false;
        }
        if (manual) {
            sub.compactRequested = false;
            return startSubCompact(sub, {auto: false});
        }
        const windowSize = contextWindowOf(sub.session);
        if (windowSize <= 0) return false;
        const threshold = compactThresholdOf(getConfig());
        const over = subContextTokens(sub) >= windowSize * threshold;
        if (!over) {
            // 这一轮没超阈：上次压缩起效了，连续计数清零（与主会话 autoCompactCount 同语义）
            sub.compactStreak = 0;
            return false;
        }
        // 连续 2 次仍超阈：不再自动压缩，交给 AI_SUB_MESSAGES_MAX / wrapUp 收尾兜底
        if ((Number(sub.compactStreak) || 0) >= 2) return false;
        return startSubCompact(sub, {auto: true});
    }

    // 发起压缩。target 可以是运行中的 sub，也可以是 done 记录的 record（两者的 session /
    // profile / entry 形状一致）——后者用于「已完成子代理立即压缩，之后唤醒以精简上下文继续」。
    function startSubCompact(target, opts) {
        if (!target || !target.session) return false;
        const live = subAgents.get(target.id) || null;
        if (live && live.compacting) return false;
        const profile = target.profile || (live ? live.profile : null);
        if (!profile || !backend.AISendChat) return false;
        const entry = target.entry || null;
        const id = target.id + '#compact-' + Date.now() + '-' + (++subCompactSeq);
        if (live) live.compacting = true;
        subCompacts.set(id, {
            id, subId: target.id, buffer: '', startedAt: Date.now(),
            auto: !!(opts && opts.auto), live: !!live,
        });
        refreshHeadChips();
        if (live) refreshAgentViewIfOpen(live.key);
        const messages = buildCompactMessages(target.session, AI_COMPACT_SYSTEM_PROMPT, (opts && opts.instruction) || '');
        const flowCfg = (live && live.flow && live.flow.profileCfg) || configForProfile(profile, entry);
        try {
            const req = backend.AISendChat(id, flowCfg, messages, [], getConfig().retryMax);
            if (req && typeof req.then === 'function') {
                req.catch((e) => failSubCompact(id, (e && e.message) || '压缩请求失败'));
            }
        } catch (e) {
            failSubCompact(id, (e && e.message) || '压缩请求失败');
        }
        return true;
    }

    function failSubCompact(id, message) {
        const job = subCompacts.get(id);
        if (!job) return;
        subCompacts.delete(id);
        const sub = subAgents.get(job.subId) || null;
        if (sub) {
            sub.compacting = false;
            sub.compactFails = (Number(sub.compactFails) || 0) + 1;
            // 连续两次失败：别把预算耗在压缩上，置 wrapUp 让收尾轮产出结论
            if (sub.compactFails >= 2 && sub.flow && !sub.flow.wrapUp) {
                sub.flow.wrapUp = true;
                sub.session.messages.push({
                    role: 'user',
                    content: '（压缩连续失败，改为尽快收尾：不要再探索，立即基于已完成的工作输出最终结论与证据。）',
                    ts: Date.now(),
                    systemNote: true,
                });
            }
            refreshHeadChips();
            refreshAgentViewIfOpen(sub.key);
            if (sub.state === 'running') runSubRound(sub);
        }
        if (!job.auto && message) flash('子代理压缩失败：' + message, true);
    }

    // 压缩流事件（panel 的 handleEvent 在 subAgents 分支**之前**转到本函数，见 §4.10.1）：
    // 压缩 roundId 是 subId#compact-…，落到 handleSubEvent 会因 roundId 不匹配被静默丢弃。
    function handleSubCompactEvent(name, payload, job) {
        if (!job) return;
        if (name === 'ai-chunk' && payload && payload.delta) {
            job.buffer += payload.delta;
            return;
        }
        if (name === 'ai-error') {
            failSubCompact(job.id, (payload && payload.message) || '压缩失败');
            return;
        }
        if (name !== 'ai-done') return;
        const text = String(job.buffer || '').trim();
        if (!text) {
            failSubCompact(job.id, '模型没有返回摘要');
            return;
        }
        subCompacts.delete(job.id);
        const sub = subAgents.get(job.subId) || null;
        const record = subAgentRecords.get(job.subId) || null;
        const session = (sub && sub.session) || (record && record.session) || null;
        if (!session) return;
        const cutoff = computeCompactCutoff(session.messages, COMPACT_KEEP_TAIL);
        if (cutoff > 0) {
            const summary = buildCompactSummary(text, cutoff,
                {kind: job.auto ? 'auto' : 'manual', scope: 'subagent'}, session.messages.length);
            // 零改动生效：buildApiMessages 对 session.summary 是通用形状判断，
            // 下一条请求会自动带上第二条 system <conversation_summary>。
            applyCompactToSession(session, summary, cutoff);
        }
        if (sub) {
            sub.compacting = false;
            sub.compactFails = 0;
            sub.compactStreak = (Number(sub.compactStreak) || 0) + 1;
            refreshHeadChips();
            refreshAgentViewIfOpen(sub.key);
            if (sub.state === 'running') runSubRound(sub);
        } else if (record) {
            refreshHeadChips();
        }
    }

    // agent_compact 执行体：运行中 → 请求在下一轮边界执行；done 可续记录 → 立即压缩。
    function compactSubAgentByInput(input) {
        const agentId = aiTextOf(input && input.agentId).trim();
        if (!agentId) throw new Error('agentId 不能为空');
        const live = subAgents.get(agentId);
        if (live) {
            if (live.compacting) return '子代理「' + live.name + '」正在压缩上下文，本次请求已合并。';
            live.compactRequested = true;
            return '已请求压缩子代理「' + live.name + '」：将在当前工具轮结束后的轮边界执行（不打断在飞工作）。' +
                '完成后它会以精简上下文继续；摘要与规模可在它的详情视图查看。';
        }
        const record = subAgentRecords.get(agentId);
        if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
        const gate = canReviveRecord(record);
        if (!gate.ok) {
            throw new Error(gate.reason === 'terminated'
                ? '子代理「' + record.name + '」已终止，无需压缩'
                : '子代理「' + record.name + '」的上下文已回收（终态记录超出上限），无法压缩');
        }
        const count = (record.session && record.session.messages || []).length;
        if (count <= COMPACT_KEEP_TAIL) {
            return '子代理「' + record.name + '」当前只有 ' + count + ' 条消息（≤' + COMPACT_KEEP_TAIL + '），无需压缩。';
        }
        if (record.session.summary) {
            return '子代理「' + record.name + '」的上下文已经是压缩后的（已保留摘要），无需再压。';
        }
        startSubCompact(record, {auto: false});
        return '已发起压缩子代理「' + record.name + '」的上下文（压缩前 ' + count + ' 条消息）。' +
            '完成后 agent_send 唤醒将以精简上下文继续；结果可在它的详情视图查看。';
    }

    // wait_agent 执行体：阻塞等指定 / 任一子代理终态，直接返回它的结论（原语 1 的「汇总」
    // 最短路径）。轮询而非 await promise：等待期间必须能看见「用户停止了主回合」，
    // 否则停止后最长 600s 才有响应，形同悬挂（§7 风险表）。
    function subSettledText(record) {
        const stateText = {done: '已完成', error: '失败', stopped: '已停止'}[record.state] || record.state;
        return '子代理「' + record.name + '」' + stateText +
            '（轮次 ' + (record.rounds || 0) + ' · 用时 ' + Math.round((record.ms || 0) / 1000) + 's' +
            (record.tokens ? ' · ' + record.tokens + ' tokens' : '') + '）\n' +
            (record.summary || '（无结论）');
    }

    function subRunningSnapshot(sub) {
        return '子代理「' + sub.name + '」仍在运行（轮次 ' + ((sub.flow && sub.flow.roundNo) || 0) +
            '，已用 ' + Math.round((Date.now() - sub.startedAt) / 1000) + 's' +
            (unseenInboxCount(sub) ? '，收件箱待处理 ' + unseenInboxCount(sub) + ' 条' : '') + '）。';
    }

    async function waitForSubAgent(input, ctx) {
        const agentId = aiTextOf(input && input.agentId).trim();
        const timeoutSec = aiClampInt(input && input.timeoutSec, 0, 600, 120);
        const owner = ctx && ctx.session ? rootSessionIdOf(ctx.session) : '';
        const belongs = (sessionId) => !owner || !sessionId || sessionId === owner;
        const live = agentId ? subAgents.get(agentId) : null;
        const settledRecord = agentId ? subAgentRecords.get(agentId) : null;
        // 冷唤醒后立刻 wait：live 可能已消失（唤醒轮很短），而手上这份 record 还是唤醒
        // 前的旧结论。这种情况不能直接返回，转为「等新一轮落账」。
        const waitingRevive = !!(agentId && !live && settledRecord && isStaleRecord(settledRecord));
        if (agentId && !live && !waitingRevive) {
            if (!settledRecord) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
            return '（该子代理此前已结束，无需等待）\n' + subSettledText(settledRecord);
        }
        const watched = agentId
            ? [live].filter(Boolean)
            : [...subAgents.values()].filter((sub) => belongs(sub.rootSessionId || sub.parentSessionId));
        if (!watched.length && !waitingRevive) {
            return '当前没有运行中的子代理可等待。可用 spawn_agent(mode=\'background\') 派出，或 agent_send 唤醒已完成的。';
        }
        const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : 0;
        const stopSeen = () => !!(ctx && ctx.stream && ctx.stream.stopped);
        for (;;) {
            // 用户停止主回合：立即返回状态快照（不是等超时）
            if (stopSeen()) {
                if (waitingRevive) {
                    return '等待被用户停止。子代理「' + (settledRecord.name || '') + '」冷唤醒后的新一轮尚未落账；' +
                        '可稍后再 wait_agent，或等它的完成通知。';
                }
                const alive = watched.filter((sub) => subAgents.has(sub.id));
                return '等待被用户停止。' + (alive.length ? alive.map(subRunningSnapshot).join(' ') : '子代理均已结束。') +
                    '\n可稍后再 wait_agent，或让它们完成时通知你。';
            }
            // 冷唤醒等待：新一轮落账（finishedAt 超过 revivedAt）之后才允许返回结论，
            // 否则返回的就是唤醒前那份旧结果（2026-11-15 实测缺陷）。
            if (waitingRevive) {
                const revived = subAgentRecords.get(agentId);
                if (revived && !isStaleRecord(revived)) return subSettledText(revived);
            }
            for (const sub of watched) {
                if (subAgents.has(sub.id)) continue;
                const record = subAgentRecords.get(sub.id);
                if (record) return subSettledText(record);
                return '子代理「' + sub.name + '」已结束但记录不可用（可能被清理）。';
            }
            if (deadline && Date.now() >= deadline) {
                if (waitingRevive) {
                    return '等待超时（' + timeoutSec + 's）：子代理「' + (settledRecord.name || '') +
                        '」冷唤醒后的新一轮尚未落账，未返回上一轮的旧结论。可稍后再 wait_agent，或等它的完成通知。';
                }
                return '等待超时（' + timeoutSec + 's）：' + watched.map(subRunningSnapshot).join(' ') +
                    '\n可继续 wait_agent，或先做别的——它完成时会通知你。';
            }
            await aiDelay(250);
        }
    }

    // 工具分发薄壳（panel 的 agent_tool case 转调；各阶段在此追加）
    function handleAgentTool(name, input, ctx) {
        if (name === 'agent_send') return sendToSubAgent(input, ctx);
        if (name === 'agent_stop') return stopSubAgentByInput(input);
        if (name === 'wait_agent') return waitForSubAgent(input, ctx);
        if (name === 'agent_compact') return compactSubAgentByInput(input);
        throw new Error('工具「' + name + '」尚未启用');
    }

    // ---- 子代理提问（原语 6）：子发问 → 父作答 → 子续轮 ----

    // 提问超时：默认 120s 后按 ai_decide 语义放行（不悬挂，不让父代理的一次疏忽卡死子代理）。
    const SUB_ASK_TIMEOUT_SEC = 120;

    function subAskQuestions(input) {
        const list = Array.isArray(input && input.questions) ? input.questions : [];
        const out = [];
        for (const q of list.slice(0, 5)) {
            const text = aiTextOf(q && q.question).trim();
            if (!text) continue;
            const options = Array.isArray(q && q.options)
                ? q.options.map((opt) => aiTextOf(opt && opt.label).trim()).filter(Boolean)
                : [];
            out.push({text, options});
        }
        return out;
    }

    function askAnswerText(answer, how) {
        if (how === 'timeout') return '主代理未及时回答，请基于现有上下文自行决定并继续。';
        if (how === 'stopped') return '主代理已停止本次任务，无需再回答。';
        return '主代理的回答：' + String(answer || '').trim();
    }

    // 落定挂起的提问（回答 / 超时 / 子代理被停止）。
    function settleSubAsk(sub, answer, how) {
        const ask = sub && sub.inbox ? sub.inbox.ask : null;
        if (!ask) return false;
        sub.inbox.ask = null;
        if (ask.timer) {
            clearTimeout(ask.timer);
            ask.timer = 0;
        }
        // 记住 askId：超时后父代理迟到的回答要降级为普通排队消息并标注（不报错）
        sub.lastAskId = ask.askId;
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        try {
            if (ask.resolve) ask.resolve(askAnswerText(answer, how));
        } catch (e) {}
        return true;
    }

    // 子代理侧 ask_user 执行体（executeTool 的 ask_user case 转调）：
    // 不建 pendingAsks UI、不挂用户输入区——挂 sub.inbox.ask 并向父代理投递提问卡片。
    // **仅后台模式可用**：阻塞模式的父回合被 await 占住，没人能回答，必然超时。
    function runSubAskQuestion(input, ctx) {
        const sub = subAgents.get(ctx && ctx.session && ctx.session.id);
        if (!sub) throw new Error('子代理上下文已失效（可能已被停止）');
        if (sub.mode !== 'background') {
            throw new Error('阻塞模式的子代理不能向主代理提问（主代理正等你的结论）：请基于现有信息自行决定并完成');
        }
        if (sub.inbox.ask) throw new Error('已有一个等待主代理回答的提问（askId=' + sub.inbox.ask.askId + '），请等回答或先自行决定');
        const questions = subAskQuestions(input);
        if (!questions.length) throw new Error('ask_user 至少需要一个有效问题');
        const askId = (ctx.toolMessage && ctx.toolMessage.toolCallId) || aiNowId('ask-');
        const entry = {askId, questions, resolve: null, timer: 0, createdAt: Date.now()};
        sub.inbox.ask = entry;
        const parent = sessionById(sub.parentSessionId);
        if (parent) {
            const hub = noticesLike();
            if (hub) hub.deliverAgentNotice(parent, buildAskNotice({
                name: sub.name, agentId: sub.id, askId, questions,
            }));
        }
        refreshHeadChips();
        refreshAgentViewIfOpen(sub.key);
        const timeoutMs = SUB_ASK_TIMEOUT_SEC * 1000;
        entry.timer = setTimeout(() => {
            if (sub.inbox.ask !== entry) return;
            settleSubAsk(sub, '', 'timeout');
        }, timeoutMs);
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    // 回答路由：命中挂起提问就地落定；askId 是已超时的那次则降级为普通排队消息。
    function answerSubAsk(sub, askId, message) {
        const ask = sub && sub.inbox ? sub.inbox.ask : null;
        if (ask && (!askId || ask.askId === askId)) {
            settleSubAsk(sub, message, 'answered');
            return '已回答子代理「' + sub.name + '」的提问（askId=' + ask.askId + '）：它会把这条当作提问结果继续。';
        }
        if (askId && sub.lastAskId === askId) {
            queueSubAgentMessage(sub, '（迟到的回答）' + message, {from: 'agent'});
            return '该提问已超时放行（子代理已自行决定继续），回答已作为普通消息排队，并标注「迟到的回答」。';
        }
        return '';
    }

    function stopSubAgentsOf(sessionId) {
        for (const sub of [...subAgents.values()]) {
            const owner = sub.rootSessionId || sub.parentSessionId;
            if (owner !== sessionId || sub.state !== 'running') continue;
            stopSubAgent(sub, '会话停止');
        }
    }
    return {
        subAgentLimit, subAgentMaxDepth, subAgentCanSpawn, subSystemPromptFor, subToolsForScope,
        activeSubCount, subTranscriptPush, subThrottleRender,
        sessionTitleOf, sessionTitleById, updateHeadIdentity,
        bgJobStateOf, rootSessionIdOf, hudSessionId, bgEntryOwnerId, isBgEntryOfHud, hudBgEntries,
        sessionHasLiveBgJob, runningBgCount, listAgentsForHud, setChipCount,
        notifyBackgroundActivity, refreshHeadChips, updateHeadHud,
        hideChipsPop, positionChipsPop, agentStateBadge, agentStatusIcon, bgJobFirstLine, taskSnippet,
        openBgTermInContent, renderChipsPop, toggleChipsPop,
        // 详情视图：openAgentView 由面板内部（chips 弹层）调用；mount/unmount 给内容区标签页用
        openAgentView, mountAgentView, unmountAgentView, renderAgentView,
        parentSessionOfSub, runSubAgent, startSubAgent, runSubRound, handleSubEvent, finalizeSubAgent, stopSubAgentsOf, initHud,
        pushSubAgentRecord, unseenInboxCount, dropSubAgentRecordsOf,
        consumeSubInbox, queueSubAgentMessage, steerSubAgent, stopSubAgent, subRunDigest,
        reviveSubAgent, sendToSubAgent, stopSubAgentByInput, handleAgentTool, answerSubAsk,
        runSubAskQuestion, settleSubAsk, waitForSubAgent,
        compactSubAgentByInput, maybeStartSubCompact, startSubCompact, handleSubCompactEvent,
        subCompacts,
        subAgents, subAgentTranscripts, subAgentRecords,
        bgJobSnapshot, notifyBgListeners, bridgeStopBgJob,
    };
}
