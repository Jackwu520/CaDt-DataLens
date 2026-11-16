// ai-head-hud.js：AI 面板头部 HUD（会话标题自适应 + 智能体团队 / 后台终端 chips 角标与弹层）。
// 从 ai-subagents.js 拆出（frontend-split-phase3 A4b，同域兄弟模块）；ctx 与宿主同源，
// 运行态注册表（const Map 活引用）与运行时动作 / 详情视图入口经 extras 注入。函数体逐字搬移。
// 构造期即绑定 chip 点击 / 面板点击关弹层 / 标题行 ResizeObserver（时机与拆分前一致）。
import {iconSvg} from '../core/icons.js';

export function createAIHeadHud(ctx, extras) {
    const el = ctx.el;
    const panel = ctx.panel;
    const flash = ctx.flash;
    const currentSession = ctx.currentSession;
    const sessionById = ctx.sessionById;
    const getSessions = ctx.getSessions;
    const bgJobIndex = ctx.bgJobIndex;
    const agentRegistry = ctx.agentRegistry;
    const openTermTab = ctx.openTermTab;
    const renderSessionList = ctx.renderSessionList;
    const reconcileBgJobs = ctx.reconcileBgJobs;
    const getChipsPopKind = ctx.getChipsPopKind;
    const setChipsPopKind = ctx.setChipsPopKind;
    // 运行态注册表（宿主构造块里的 const Map，稳定活引用）
    const subAgents = extras.subAgents;
    const subAgentRecords = extras.subAgentRecords;
    // 运行时动作与详情视图入口（宿主后定义，惰性箭头延迟解析）
    const unseenInboxCount = extras.unseenInboxCount;
    const openAgentView = extras.openAgentView;

    let hudReady = false;             // HUD 块执行完才置真，之前的 renderSessionList 调用跳过
    const AGENT_STATE_LABEL = {running: '运行中', done: '已完成', error: '失败', stopped: '已停止'};

    // ---- 头部 HUD：会话标题 + 智能体团队 / 后台终端入口 ----
    // 标题显示当前会话标题（自动标题/改名/切换经 renderSessionList 统一走 updateHeadHud）；
    // 两个 chip 是常驻入口：智能体团队（子代理状态）与后台终端（background_command 作业）。

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

    return {
        sessionTitleOf, sessionTitleById, updateHeadIdentity,
        bgJobStateOf, rootSessionIdOf, hudSessionId, bgEntryOwnerId, isBgEntryOfHud, hudBgEntries,
        sessionHasLiveBgJob, runningBgCount, listAgentsForHud, setChipCount,
        notifyBackgroundActivity, refreshHeadChips, updateHeadHud,
        hideChipsPop, positionChipsPop, agentStateBadge, agentStatusIcon, bgJobFirstLine, taskSnippet,
        openBgTermInContent, renderChipsPop, toggleChipsPop,
        initHud,
    };
}
