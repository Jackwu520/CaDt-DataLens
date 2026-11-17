// bridge-team-view.js：智能体团队详情在内容区的标签页（对齐子代理详情标签页的先例）。
// 本模块只负责「建标签页 + 提供容器 + 关标签时卸载」；正文渲染归 AI 面板
// （ai-team-view.js）——运行态注册表与主代理状态都在面板闭包里。
export function createBridgeTeamView(deps) {

const TEAM_VIEW_MAX = 3;

function teamTabName(title) {
    const line = String(title || '').replace(/\s+/g, ' ').trim();
    if (!line) return '智能体团队';
    return '团队 · ' + (line.length > 16 ? line.slice(0, 16) + '…' : line);
}

// 视图键 = 会话 id：同一个会话只开一个团队标签页，切走会话后它仍显示原会话的团队。
function teamViewKey(spec) {
    return String((spec && spec.sessionId) || '');
}

function openAgentTeamTab(spec) {
    const key = teamViewKey(spec);
    if (!key) return null;
    const existing = deps.docs.find((d) => d.agentTeam === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const opened = deps.docs.filter((d) => d.agentTeam);
    while (opened.length >= TEAM_VIEW_MAX) {
        const oldest = opened.shift();
        if (oldest) deps.closeDocNow(oldest, false);
    }
    const doc = {
        id: 'agentteam-' + key,
        path: null,
        name: teamTabName(spec && spec.title),
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'agentteam', name: '智能体团队', extensions: [], aceMode: 'text', rawOnly: true},
        agentTeam: key,
        agentTeamSpec: {
            sessionId: key,
            title: String((spec && spec.title) || ''),
        },
        mode: 'agentteam',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

function createAgentTeamView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active agentteam-pane';
    deps.els.editor.appendChild(pane);
    const root = document.createElement('div');
    root.className = 'agentteam-root';
    pane.appendChild(root);
    doc.pane = pane;
    doc.agentTeamRoot = root;

    const mounted = deps.aiPanel && deps.aiPanel.bridgeMountAgentTeamView
        ? deps.aiPanel.bridgeMountAgentTeamView(root, doc.agentTeamSpec)
        : null;
    if (!mounted) {
        root.textContent = '团队视图不可用：AI 面板尚未就绪。';
        root.classList.add('empty');
        return;
    }
    doc.agentTeamUnmount = () => {
        if (deps.aiPanel && deps.aiPanel.bridgeUnmountAgentTeamView) deps.aiPanel.bridgeUnmountAgentTeamView(root);
    };
}

return {createAgentTeamView, openAgentTeamTab};
}
