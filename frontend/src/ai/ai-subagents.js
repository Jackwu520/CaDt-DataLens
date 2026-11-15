// ai-subagents.js：子代理域（spawn_agent 运行时 / HUD 头部角标与 chips 弹层 / 后台作业归类 / 卡片渲染）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// 顺手删除了 sessionHasLiveBgJob 的重复定义（原 10923/10933 两份逐字相同，后者覆盖前者，保留一份）。
// agentViewState/agentViewTimer/hudReady/AGENT_STATE_LABEL 与 AI_SUB_* 常量随域迁入；chipsPopKind 经访问器读写。
import {iconSvg} from '../core/icons.js';
import {createTextarea} from '../core/form-controls.js';
import {aiClampInt, aiNowId, aiTextOf} from './ai-constants.js';
import {AI_TOOL_DEFS} from './ai-tool-defs.js';
import {inspectToolArguments} from './ai-tool-args.js';
import {buildSettlementNotice, buildAskNotice} from './ai-agent-notices.js';

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

export function createAISubagents(ctx) {
    const el = ctx.el;
    const panel = ctx.panel;
    const backend = ctx.backend;
    const flash = ctx.flash;
    const renderMarkdown = ctx.renderMarkdown;
    const openTermTab = ctx.openTermTab;
    const currentSession = ctx.currentSession;
    const persistSessions = ctx.persistSessions;
    const sessionById = ctx.sessionById;
    const entryOf = ctx.entryOf;
    const profileOf = ctx.profileOf;
    const configForProfile = ctx.configForProfile;
    const executeTool = ctx.executeTool;
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
        '约束：只做只读探索（列目录 / 读文件 / 搜索 / 联网检索 / 记忆读取 / 技能加载）；不要尝试修改文件或执行命令；不要直接向最终用户发问（后台模式可用 ask_user 问主代理，由主代理决定）。',
        // 投递契约（§4.8）：投递层不截断（阶段 B 移除了 8000 字符上限），结论的紧凑性靠这里自律。
        '结果投递契约：主代理只会收到你的最终结论文本，看不到你的完整转录、工具输出或推理过程——最终结论必须自带结果与关键证据（path:line），不要指望父代理从过程记录里找信息。',
        '完成后输出一段结构化最终结论（要点 + 证据 path:line），它是你返回给主代理的唯一结果。',
    ].join('\n');
    let hudReady = false;             // HUD 块执行完才置真，之前的 renderSessionList 调用跳过
    let agentViewState = null;        // 详情视图当前打开的子代理 {toolCallId, subId, name}
    let agentViewTimer = 0;
    const AGENT_STATE_LABEL = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'};

    const subAgents = new Map();      // subId -> 子代理运行态
    const subAgentTranscripts = new Map(); // spawn key -> [{role, name?, text}]
    // agentId -> 终态记录（含 sub.session / profile / entry 活引用）：冷唤醒、子代理压缩、
    // HUD 兜底都靠它。subAgents 仍只含运行中——事件路由先查 subAgents，records 只作兜底。
    const subAgentRecords = new Map();
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
            AI_TOOL_DEFS.list_dir, AI_TOOL_DEFS.read_file, AI_TOOL_DEFS.search_text,
            AI_TOOL_DEFS.web_search, AI_TOOL_DEFS.web_fetch,
            AI_TOOL_DEFS.memory_list, AI_TOOL_DEFS.memory_read,
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
    }

    function subThrottleRender(sub) {
        if (sub.renderTimer) return;
        sub.renderTimer = setTimeout(() => {
            sub.renderTimer = 0;
            const session = sessionById(sub.parentSessionId);
            if (session && sub.parentToolMessage) refreshToolWrap(session, sub.parentToolMessage);
            // 子代理详情视图开着时同步实时刷新（docs/unfinished-plans/ai-head-agents-terminal.md）
            if (agentViewState && agentViewState.subId === sub.id) scheduleAgentViewRender();
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
        el.headTitle.title = title || 'AI 助手';
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
                    wait.title = '收件箱里有 ' + agent.inboxCount + ' 条消息还没被消费（子代理下一轮边界会读）';
                    row.appendChild(wait);
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
                main.title = (agent.task || '') + (agent.sessionTitle ? '（会话：' + agent.sessionTitle + '）' : '');
                row.appendChild(main);
                const go = document.createElement('span');
                go.className = 'ai-chips-go';
                go.innerHTML = iconSvg('chevron-right', 12);
                row.appendChild(go);
                row.addEventListener('click', () => {
                    hideChipsPop();
                    openAgentView({toolCallId: agent.toolCallId, subId: agent.subId || '', name: agent.name || '子代理'});
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
                main.title = entry.command || '';
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

    // ---- 子代理详情视图（替代面板消息区，返回按钮回到主代理） ----

    function agentBlock(className, contentText, markdown) {
        const div = document.createElement('div');
        div.className = className;
        if (markdown) div.innerHTML = renderMarkdown(contentText || '');
        else div.textContent = contentText || '';
        return div;
    }

    function agentToolRow(name, text, error) {
        const row = document.createElement('div');
        row.className = 'ai-agv-tool' + (error ? ' error' : '');
        const label = document.createElement('span');
        label.className = 'ai-agv-tool-name';
        label.textContent = (name || 'tool') + (error ? ' · 失败' : '');
        const pre = document.createElement('pre');
        pre.textContent = String(text || '').slice(0, 600);
        row.append(label, pre);
        return row;
    }

    function renderAgentLiveMessages(sub, body) {
        for (const m of sub.session.messages || []) {
            if (m.role === 'user') {
                body.appendChild(agentBlock('ai-agv-user', m.content, false));
            } else if (m.role === 'assistant') {
                const text = String(m.content || '').trim();
                if (!text) continue; // 思考/流式中间态不渲染，只看已落定的正文与工具
                body.appendChild(agentBlock('ai-agv-msg', text, true));
            } else if (m.role === 'tool') {
                body.appendChild(agentToolRow(m.name, m.content, m.status === 'error'));
            }
        }
        const tip = document.createElement('div');
        tip.className = 'ai-agv-live-tip';
        tip.textContent = '子代理运行中，视图实时更新';
        body.appendChild(tip);
    }

    function renderAgentFinished(toolCallId, meta, body) {
        const summary = meta && meta.summary ? String(meta.summary) : '';
        if (summary) {
            const wrap = document.createElement('div');
            wrap.className = 'ai-agv-summary';
            const title = document.createElement('div');
            title.className = 'ai-agv-summary-title';
            title.textContent = '最终结论';
            wrap.appendChild(title);
            wrap.appendChild(agentBlock('ai-agv-msg', summary, true));
            body.appendChild(wrap);
        }
        const transcript = subAgentTranscripts.get(toolCallId);
        if (transcript && transcript.length) {
            if (summary) {
                const sub2 = document.createElement('div');
                sub2.className = 'ai-agv-summary-title';
                sub2.textContent = '过程转录';
                body.appendChild(sub2);
            }
            for (const entry of transcript) {
                if (entry.role === 'assistant') body.appendChild(agentBlock('ai-agv-msg', entry.text, true));
                else if (entry.role === 'tool') body.appendChild(agentToolRow(entry.name, entry.text, false));
            }
        }
        if (!summary && !(transcript && transcript.length)) {
            const empty = document.createElement('div');
            empty.className = 'ai-agv-live-tip';
            empty.textContent = '应用重启后子代理只保留状态与结论摘要；本次没有可显示的转录。';
            body.appendChild(empty);
        }
    }

    function agentStatusMeta(toolCallId) {
        const view = agentViewState;
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
        const meta = agentRegistry.get(toolCallId);
        if (meta) return meta;
        for (const session of getSessions()) {
            for (const m of session.messages) {
                const key = (m.agent && m.agent.key) || m.toolCallId;
                if (m.role === 'tool' && m.name === 'spawn_agent' && key === toolCallId && m.agent) return m.agent;
            }
        }
        return null;
    }

    function renderAgentView() {
        if (!agentViewState || !el.agentView) return;
        const view = agentViewState;
        // 只清头部与正文，**保留输入行**（子代理运行中详情视图每 300ms 重渲染，重建会让
        // 用户正在打的字与焦点一起丢）。
        for (const node of [...el.agentView.children]) {
            if (node.classList && node.classList.contains('ai-agv-composer')) continue;
            node.remove();
        }
        const meta = agentStatusMeta(view.toolCallId);
        const head = document.createElement('div');
        head.className = 'ai-agent-view-head';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'ai-icon-btn';
        back.title = '返回主代理';
        back.setAttribute('aria-label', '返回主代理');
        back.innerHTML = iconSvg('back', 14);
        back.addEventListener('click', closeAgentView);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ai-agent-view-name';
        nameSpan.textContent = view.name;
        nameSpan.title = view.name;
        head.append(back, nameSpan);
        if (meta) head.appendChild(agentStateBadge(meta.state));
        const metaLine = document.createElement('span');
        metaLine.className = 'ai-agent-view-meta';
        const bits = [];
        if (meta && meta.rounds) bits.push('轮次 ' + meta.rounds);
        if (meta && meta.ms) bits.push(Math.max(1, Math.round(meta.ms / 1000)) + 's');
        if (meta && meta.tokens) bits.push((meta.tokens / 1000).toFixed(1) + 'k tok');
        if (meta && meta.mode === 'background') bits.push('后台');
        if (meta && meta.continuable === false) bits.push('上下文已回收');
        metaLine.textContent = bits.join(' · ');
        head.appendChild(metaLine);
        // 后台子代理的结束时机独立于主回合：详情视图必须有手动停止入口（§4.6）
        const liveSub = view.subId ? subAgents.get(view.subId) : null;
        if (liveSub && liveSub.state === 'running') {
            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'ai-icon-btn ai-agv-stop';
            stopBtn.title = '停止这个子代理（保留它的过程记录）';
            stopBtn.setAttribute('aria-label', '停止子代理');
            stopBtn.innerHTML = iconSvg('pause', 13);
            stopBtn.addEventListener('click', () => {
                stopSubAgent(liveSub, '用户在详情视图停止');
                renderAgentView();
            });
            head.appendChild(stopBtn);
        }
        el.agentView.appendChild(head);

        const body = document.createElement('div');
        body.className = 'ai-agent-view-body';
        const sub = view.subId ? subAgents.get(view.subId) : null;
        if (sub) renderAgentLiveMessages(sub, body);
        else renderAgentFinished(view.toolCallId, meta, body);
        if (sub) appendInboxPreview(sub, body);
        el.agentView.appendChild(body);
        body.scrollTop = body.scrollHeight;
        // 输入行固定在底部（独立节点，重渲染不重建）
        const composer = ensureAgentViewComposer(view);
        if (composer && (composer.parentNode !== el.agentView || el.agentView.lastElementChild !== composer)) {
            el.agentView.appendChild(composer);
        }
    }

    // 子代理对话视图的输入行（F3）：Enter 排队 / Ctrl+Enter 插队；对已完成且可续的子代理
    // 输入即冷唤醒入口；失败/停止/上下文已回收的记录禁用并说明原因。
    // 节点按 subId 缓存复用——运行中的详情视图每 300ms 重渲染，重建输入框会丢焦点与草稿。
    let agentViewComposer = null;

    function ensureAgentViewComposer(view) {
        const key = view.subId || '';
        const live = key ? subAgents.get(key) : null;
        const record = !live && key ? subAgentRecords.get(key) : null;
        const target = live || record;
        if (!target) {
            if (agentViewComposer && agentViewComposer.subId === key) agentViewComposer = null;
            return null;
        }
        const gate = live ? {ok: true, reason: ''} : canReviveRecord(record);
        const canType = gate.ok;
        const stateText = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'}[live ? 'running' : record.state] || '';
        let wrap = agentViewComposer && agentViewComposer.subId === key ? agentViewComposer.el : null;
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
                const current = agentViewState && agentViewState.subId ? subAgents.get(agentViewState.subId) : null;
                const rec = !current && agentViewState && agentViewState.subId
                    ? subAgentRecords.get(agentViewState.subId) : null;
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
                renderAgentView();
            };
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                e.preventDefault();
                submit(e.ctrlKey || e.metaKey);
            });
            send.addEventListener('click', () => submit(false));
            wrap.append(input, send);
            agentViewComposer = {subId: key, el: wrap};
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

    // 收件箱预览：让用户看见「已投递但还没被消费」的消息，而不是只有主代理自己知道。
    function appendInboxPreview(sub, body) {
        const inbox = sub.inbox || {step: [], turn: [], ask: null};
        const stepN = (inbox.step || []).length;
        const turnN = (inbox.turn || []).length;
        if (!stepN && !turnN && !inbox.ask) return;
        const box = document.createElement('div');
        box.className = 'ai-agv-inbox';
        const title = document.createElement('div');
        title.className = 'ai-agv-inbox-title';
        title.textContent = '收件箱 · 排队 ' + turnN + ' 条 · 插队 ' + stepN + ' 条';
        box.appendChild(title);
        for (const item of [...(inbox.step || []), ...(inbox.turn || [])].slice(0, 3)) {
            const line = document.createElement('div');
            line.className = 'ai-agv-inbox-line';
            line.textContent = (item.from === 'user' ? '用户：' : '主代理：') + String(item.text || '').slice(0, 90);
            box.appendChild(line);
        }
        if (inbox.ask) {
            const wait = document.createElement('div');
            wait.className = 'ai-agv-inbox-ask';
            wait.textContent = '等待主代理回答提问（askId=' + (inbox.ask.askId || '') + '）';
            box.appendChild(wait);
        }
        body.appendChild(box);
    }

    function scheduleAgentViewRender() {
        if (agentViewTimer) return;
        agentViewTimer = setTimeout(() => {
            agentViewTimer = 0;
            renderAgentView();
        }, 300);
    }

    function refreshAgentViewIfOpen(toolCallId) {
        if (agentViewState && agentViewState.toolCallId === toolCallId) scheduleAgentViewRender();
    }

    function openAgentView(spec) {
        if (!el.agentView) return;
        agentViewState = {toolCallId: spec.toolCallId, subId: spec.subId || '', name: spec.name || '子代理'};
        el.agentView.classList.remove('hidden');
        renderAgentView();
    }

    function closeAgentView() {
        agentViewState = null;
        agentViewComposer = null;
        if (agentViewTimer) {
            clearTimeout(agentViewTimer);
            agentViewTimer = 0;
        }
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
            workspace: parentSession.workspace || '',
            profileId: parentSession.profileId,
            systemPrompt: parentSession.systemPrompt || '',
            promptTemplateId: parentSession.promptTemplateId || '',
            scope: 'read',
            planMode: false,
            messages: [{role: 'user', content: task, ts: Date.now(), turnStartedAt: Date.now()}],
            todos: [],
            changes: [],
            approvedPaths: [],
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
            let result = null;
            try {
                const allowed = new Set(subToolsForScope(sub.depth, sub.mode).map((tool) => tool.name));
                if (!allowed.has(call.name)) throw new Error('子代理不允许工具：' + call.name);
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
            finalizeSubAgent(sub, s.stopped ? 'stopped' : sub.state);
            return;
        }
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
        sub.session.messages.push(assistant);
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
        // 消息入队再起轮：runSubRound 开头统一消费（与运行中排队走同一条路径）
        queueSubAgentMessage(sub, text, {from: (opts && opts.from) || 'agent'});
        if (opts && opts.urgent) sub.inbox.step.unshift(sub.inbox.turn.pop());
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
        if (agentId && !live) {
            const record = subAgentRecords.get(agentId);
            if (!record) throw new Error('找不到子代理 ' + agentId + '（可能已被清理）');
            return '（该子代理此前已结束，无需等待）\n' + subSettledText(record);
        }
        const watched = agentId
            ? [live]
            : [...subAgents.values()].filter((sub) => belongs(sub.rootSessionId || sub.parentSessionId));
        if (!watched.length) {
            return '当前没有运行中的子代理可等待。可用 spawn_agent(mode=\'background\') 派出，或 agent_send 唤醒已完成的。';
        }
        const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : 0;
        const stopSeen = () => !!(ctx && ctx.stream && ctx.stream.stopped);
        for (;;) {
            // 用户停止主回合：立即返回状态快照（不是等超时）
            if (stopSeen()) {
                const alive = watched.filter((sub) => subAgents.has(sub.id));
                return '等待被用户停止。' + (alive.length ? alive.map(subRunningSnapshot).join(' ') : '子代理均已结束。') +
                    '\n可稍后再 wait_agent，或让它们完成时通知你。';
            }
            for (const sub of watched) {
                if (subAgents.has(sub.id)) continue;
                const record = subAgentRecords.get(sub.id);
                if (record) return subSettledText(record);
                return '子代理「' + sub.name + '」已结束但记录不可用（可能被清理）。';
            }
            if (deadline && Date.now() >= deadline) {
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
        agentBlock, agentToolRow, renderAgentLiveMessages, renderAgentFinished, renderAgentView,
        parentSessionOfSub, runSubAgent, startSubAgent, runSubRound, handleSubEvent, finalizeSubAgent, stopSubAgentsOf, initHud,
        pushSubAgentRecord, unseenInboxCount, dropSubAgentRecordsOf,
        consumeSubInbox, queueSubAgentMessage, steerSubAgent, stopSubAgent, subRunDigest,
        reviveSubAgent, sendToSubAgent, stopSubAgentByInput, handleAgentTool, answerSubAsk,
        runSubAskQuestion, settleSubAsk, waitForSubAgent,
        subAgents, subAgentTranscripts, subAgentRecords,
        bgJobSnapshot, notifyBgListeners, bridgeStopBgJob,
    };
}
