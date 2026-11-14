// ai-subagents.js：子代理域（spawn_agent 运行时 / HUD 头部角标与 chips 弹层 / 后台作业归类 / 卡片渲染）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// 顺手删除了 sessionHasLiveBgJob 的重复定义（原 10923/10933 两份逐字相同，后者覆盖前者，保留一份）。
// agentViewState/agentViewTimer/hudReady/AGENT_STATE_LABEL 与 AI_SUB_* 常量随域迁入；chipsPopKind 经访问器读写。
import {iconSvg} from '../icons.js';
import {aiClampInt, aiNowId, aiTextOf} from './ai-constants.js';
import {AI_TOOL_DEFS} from './ai-tool-defs.js';
import {inspectToolArguments} from './ai-tool-args.js';

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
    const AI_SUB_SUMMARY_MAX = 8000;
    const AI_SUB_SYSTEM_PROMPT = [
        '你是主代理派出的只读子代理：独立完成任务后输出最终结论，不与用户直接交互。',
        '约束：只做只读探索（列目录 / 读文件 / 搜索 / 联网检索 / 记忆读取 / 技能加载）；不要尝试修改文件或执行命令；不要反问用户（你没有提问渠道）。',
        '完成后输出一段结构化最终结论（要点 + 证据 path:line），它是你返回给主代理的唯一结果。',
    ].join('\n');
    let hudReady = false;             // HUD 块执行完才置真，之前的 renderSessionList 调用跳过
    let agentViewState = null;        // 详情视图当前打开的子代理 {toolCallId, subId, name}
    let agentViewTimer = 0;
    const AGENT_STATE_LABEL = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'};

    const subAgents = new Map();      // subId -> 子代理运行态
    const subAgentTranscripts = new Map(); // spawn key -> [{role, name?, text}]
    const subAgentQueue = [];

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

    function subSystemPromptFor(depth) {
        if (!subAgentCanSpawn(depth)) return AI_SUB_SYSTEM_PROMPT;
        return AI_SUB_SYSTEM_PROMPT +
            '\n需要并行 / 隔离调查时可以再用 spawn_agent 派下一层只读子代理（总数与层级受设置限制）；简单问题直接自己做。';
    }

    function subToolsForScope(depth) {
        const list = [
            AI_TOOL_DEFS.list_dir, AI_TOOL_DEFS.read_file, AI_TOOL_DEFS.search_text,
            AI_TOOL_DEFS.web_search, AI_TOOL_DEFS.web_fetch,
            AI_TOOL_DEFS.memory_list, AI_TOOL_DEFS.memory_read,
            AI_TOOL_DEFS.skill_use, AI_TOOL_DEFS.env_list,
        ];
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
            if (session) refreshToolWrap(session, sub.parentToolMessage);
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
                sessionTitle: sessionTitleOf(sub.parentSessionId)});
        }
        for (const [key, meta] of agentRegistry) {
            if (seen.has(key)) continue;
            seen.add(key);
            if (!belongs(meta.rootSessionId || meta.parentSessionId)) continue;
            out.push({...meta, toolCallId: key, key, sessionTitle: sessionTitleOf(meta.parentSessionId)});
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
                ? '暂无共享任务，可以通过对话创建'
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
        const sub = agentViewState && agentViewState.subId ? subAgents.get(agentViewState.subId) : null;
        if (sub) {
            return {
                state: 'running',
                rounds: sub.flow ? sub.flow.roundNo : 0,
                ms: Math.max(0, Date.now() - sub.startedAt),
                tokens: sub.flow && sub.flow.usage ? (Number(sub.flow.usage.totalTokens) || 0) : 0,
                summary: '',
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
        el.agentView.textContent = '';
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
        metaLine.textContent = bits.join(' · ');
        head.appendChild(metaLine);
        el.agentView.appendChild(head);

        const body = document.createElement('div');
        body.className = 'ai-agent-view-body';
        const sub = view.subId ? subAgents.get(view.subId) : null;
        if (sub) renderAgentLiveMessages(sub, body);
        else renderAgentFinished(view.toolCallId, meta, body);
        el.agentView.appendChild(body);
        body.scrollTop = body.scrollHeight;
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

    async function runSubAgent(ctx, input) {
        if (!backend.AISendChat) throw new Error('当前版本不支持子代理');
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
        // 总数上限覆盖全部层级：主代理派单时等待空位，子代理再派直接拒绝（否则会与祖先互相等待）
        const limit = subAgentLimit();
        if (activeSubCount() >= limit) {
            if (depth > 1) throw new Error('子代理总数已达上限 ' + limit + '（含各层级），无法继续派出');
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
            session: null,
            flow: null,
        };
        toolMessage.agent = {
            key: sub.key,
            depth,
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
            systemPrompt: subSystemPromptFor(depth),
            usage: null,
        };
        subAgents.set(sub.id, sub);
        agentRegistry.set(sub.key, {
            subId: sub.id, key: sub.key, toolCallId: sub.toolCallId, depth,
            parentSessionId: sub.parentSessionId, rootSessionId,
            name: sub.name, task: sub.task, state: 'running', startedAt: sub.startedAt,
            rounds: 0, ms: 0, tokens: 0, summary: '',
        });
        notifyBackgroundActivity();
        persistSessions();
        refreshToolWrap(parentSession, toolMessage);
        // 先挂 resolve 再启动子代理轮：runSubRound 的同步失败路径（请求抛错/轮次上限/
        // 消息越限/索引丢失）会立刻 finalizeSubAgent，若此时 resolve 尚未挂上，主代理的
        // await 会永远悬挂（实测：子代理失败后主代理卡死无反馈）。见 2026-11-14 修复。
        const outcomePromise = new Promise((resolve) => { sub.resolve = resolve; });
        runSubRound(sub);
        const outcome = await outcomePromise;
        return outcome.text;
    }

    function runSubRound(sub) {
        const s = sub.flow;
        if (sub.state !== 'running' || s.stopped) {
            finalizeSubAgent(sub, s.stopped ? 'stopped' : sub.state);
            return;
        }
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
            const request = backend.AISendChat(s.roundId, s.profileCfg, apiMessages, subToolsForScope(sub.depth), getConfig().retryMax);
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
                const allowed = new Set(subToolsForScope(sub.depth).map((tool) => tool.name));
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

    function finalizeSubAgent(sub, state, note) {
        if (sub.state !== 'running') return;
        sub.state = state;
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
        summary = summary.trim();
        if (summary.length > AI_SUB_SUMMARY_MAX) summary = summary.slice(0, AI_SUB_SUMMARY_MAX) + '\n…（子代理结果已截断）';
        const meta = sub.parentToolMessage.agent;
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
        if (state !== 'done') subAgentTranscripts.delete(sub.key);
        try {
            if (sub.resolve) sub.resolve({ok: state === 'done', text: summary, state});
        } catch (e) {}
        persistSessions();
        const session = sessionById(sub.parentSessionId);
        if (session) refreshToolWrap(session, sub.parentToolMessage);
        if (state === 'error') flash('子代理「' + sub.name + '」失败：' + (note || '执行出错'), true);
        else if (state === 'stopped') flash('子代理「' + sub.name + '」已停止');
    }

    function stopSubAgentsOf(sessionId) {
        for (const sub of [...subAgents.values()]) {
            const owner = sub.rootSessionId || sub.parentSessionId;
            if (owner !== sessionId || sub.state !== 'running') continue;
            sub.flow.stopped = true;
            try {
                if (backend.AIStop) backend.AIStop(sub.id);
            } catch (e) {}
            finalizeSubAgent(sub, 'stopped');
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
        parentSessionOfSub, runSubAgent, runSubRound, handleSubEvent, finalizeSubAgent, stopSubAgentsOf, initHud,
        subAgents, subAgentTranscripts, subAgentQueue,
        bgJobSnapshot, notifyBgListeners, bridgeStopBgJob,
    };
}
