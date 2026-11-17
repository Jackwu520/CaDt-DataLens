// ai-team-view.js：智能体团队详情视图（内容区标签页）——主代理 + 子代理树的纵向卡片图。
// 纯数据在 ai-team-model.js；本模块只负责 DOM、节流刷新与卡片点击（无持久化状态）。
import {iconSvg} from '../core/icons.js';
import {flattenAgentTree} from './ai-agent-tree.js';
import {
    TEAM_MAIN_KEY, makeMainAgentNode, buildTeamTree, teamAgentStats,
    agentNodeMeta, taskSnippet,
} from './ai-team-model.js';

const TEAM_RENDER_INTERVAL = 300;   // 同一视图的重绘节流
const TEAM_MAX_INDENT = 8;          // 卡片缩进封顶，深层靠「第 N 层」文案补足

const MAIN_STATE = {
    streaming: {label: '生成中', cls: 'ai-agent-running'},
    compacting: {label: '压缩中', cls: 'ai-agent-waiting'},
    idle: {label: '空闲', cls: 'ai-agent-stopped'},
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function createAITeamView(ctx, extras) {
    const openAgentView = extras.openAgentView;
    const listAgentsForHud = extras.listAgentsForHud;
    // root 元素 -> {root, sessionId, title, getMainAgent, timer}
    const teamViews = new Set();

    function mainInfoOf(view) {
        if (typeof view.getMainAgent !== 'function') return null;
        try {
            return view.getMainAgent(view.sessionId);
        } catch (e) {
            return null;   // 宿主信息取不到时只用标签页自带的标题，主代理卡照常画
        }
    }

    function buildMainCard(main, info) {
        const card = el('div', 'agentteam-card agentteam-card-main');
        const head = el('div', 'agentteam-card-head');
        const state = MAIN_STATE[(info && info.state) || 'idle'] || MAIN_STATE.idle;
        head.appendChild(el('span', 'ai-agent-badge ' + state.cls, state.label));
        head.appendChild(el('span', 'agentteam-name', '主代理'));
        head.appendChild(el('span', 'agentteam-main-title', main.name || '当前会话'));
        card.appendChild(head);
        const bits = [];
        if (info && info.modelLabel) bits.push(info.modelLabel);
        if (info && info.scopeLabel) bits.push(info.scopeLabel);
        if (bits.length) card.appendChild(el('div', 'agentteam-card-meta', bits.join(' · ')));
        return card;
    }

    function buildAgentCard(view, agent) {
        const clickable = typeof openAgentView === 'function';
        const card = document.createElement(clickable ? 'button' : 'div');
        if (clickable) {
            card.type = 'button';
            card.className = 'agentteam-card agentteam-card-link';
        } else {
            card.className = 'agentteam-card';
        }
        const head = el('div', 'agentteam-card-head');
        head.appendChild(el('span', 'ai-agent-badge ai-agent-' + (agent.state || 'done'), stateLabel(agent.state)));
        head.appendChild(el('span', 'agentteam-name', agent.name || '子代理'));
        const metaBits = agentNodeMeta(agent);
        if (metaBits.length) head.appendChild(el('span', 'agentteam-card-meta-inline', metaBits.join(' · ')));
        if (clickable) {
            const go = el('span', 'agentteam-go');
            go.innerHTML = iconSvg('chevron-right', 12);
            head.appendChild(go);
        }
        card.appendChild(head);
        const task = taskSnippet(agent.task, 180);
        if (task) card.appendChild(el('div', 'agentteam-card-task', task));
        if (agent.state !== 'running' && agent.summary) {
            card.appendChild(el('div', 'agentteam-card-summary', '结论：' + taskSnippet(agent.summary, 180)));
        }
        if (clickable) {
            card.addEventListener('click', () => {
                openAgentView({
                    toolCallId: agent.toolCallId,
                    subId: agent.subId || '',
                    name: agent.name || '子代理',
                    sessionId: view.sessionId,
                });
            });
        }
        return card;
    }

    function stateLabel(state) {
        if (state === 'running') return '运行中';
        if (state === 'error') return '失败';
        if (state === 'stopped') return '已停止';
        return '已完成';
    }

    function renderTeamView(view) {
        if (!view.root || !view.root.isConnected) return;
        const scrollTop = view.root.scrollTop;
        const agents = (typeof listAgentsForHud === 'function' ? listAgentsForHud(view.sessionId) : []) || [];
        const info = mainInfoOf(view);
        const main = makeMainAgentNode({
            sessionId: view.sessionId,
            title: (info && info.title) || view.title,
            state: (info && info.state) || 'idle',
        });
        const stats = teamAgentStats(agents);
        const roots = buildTeamTree(main, agents);
        const rows = flattenAgentTree(roots, () => false);

        view.root.textContent = '';
        const head = el('div', 'agentteam-head');
        const headMain = el('div', 'agentteam-head-main');
        headMain.appendChild(el('span', 'agentteam-head-title', '智能体团队'));
        headMain.appendChild(el('span', 'agentteam-head-session', (info && info.title) || view.title || ''));
        head.appendChild(headMain);
        head.appendChild(el('span', 'agentteam-stats',
            stats.total ? '运行中 ' + stats.running + ' · 共 ' + stats.total : '暂无子代理'));
        view.root.appendChild(head);

        const tree = el('div', 'agentteam-tree');
        for (const row of rows) {
            const agent = row.agent;
            const isMain = agent.key === TEAM_MAIN_KEY || agent.main;
            const line = el('div', 'agentteam-row');
            const level = Math.min(row.level, TEAM_MAX_INDENT);
            line.style.setProperty('--atl', String(level));
            if (row.level > 0) line.dataset.nested = '1';
            line.appendChild(isMain ? buildMainCard(agent, info) : buildAgentCard(view, agent));
            tree.appendChild(line);
        }
        if (!stats.total) tree.appendChild(el('div', 'agentteam-empty', '这个会话还没有派出子代理。'));
        view.root.appendChild(tree);
        // 刷新时保持阅读位置（首次挂载 scrollTop 为 0，不受影响）
        view.root.scrollTop = scrollTop;
    }

    function scheduleTeamRender(view) {
        if (view.timer) return;
        view.timer = setTimeout(() => {
            view.timer = 0;
            renderTeamView(view);
        }, TEAM_RENDER_INTERVAL);
    }

    // 状态变化时由 HUD 的 refreshHeadChips 触发；sessionId 省略时刷新全部打开的团队视图
    function refreshTeamViewsIfOpen(sessionId) {
        const id = String(sessionId || '');
        for (const view of teamViews) {
            if (id && view.sessionId !== id) continue;
            scheduleTeamRender(view);
        }
    }

    // hostDeps.getMainAgent 由面板桥注入（模型名 / 权限档 / 流状态都在面板闭包里）
    function mountTeamView(root, spec, hostDeps) {
        if (!root) return null;
        unmountTeamView(root);
        const view = {
            root,
            sessionId: String((spec && spec.sessionId) || ''),
            title: String((spec && spec.title) || ''),
            getMainAgent: hostDeps && typeof hostDeps.getMainAgent === 'function' ? hostDeps.getMainAgent : null,
            timer: 0,
        };
        teamViews.add(view);
        renderTeamView(view);
        return view;
    }

    function unmountTeamView(root) {
        for (const view of teamViews) {
            if (view.root !== root) continue;
            if (view.timer) clearTimeout(view.timer);
            view.timer = 0;
            teamViews.delete(view);
            return true;
        }
        return false;
    }

    return {teamViews, mountTeamView, unmountTeamView, refreshTeamViewsIfOpen, renderTeamView};
}
