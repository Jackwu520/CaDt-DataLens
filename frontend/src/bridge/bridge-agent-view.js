// bridge-agent-view.js：子代理详情在内容区的标签页（对齐后台终端标签页的先例）。
// 本模块只负责「建标签页 + 提供容器 + 关标签时卸载」；正文渲染归 AI 面板
// （ai-subagents.js 的 mountAgentView）——子代理的运行态、收件箱与插话输入行都在面板闭包里。
export function createBridgeAgentView(deps) {

const AGENT_VIEW_MAX = 8;

function agentTabName(name) {
    const line = String(name || '子代理').replace(/\s+/g, ' ').trim() || '子代理';
    return line.length > 20 ? line.slice(0, 20) + '…' : line;
}

// 视图键：优先 subId（运行态/终态记录都以它为主键），退回派单时的注册表 key。
function agentViewKey(spec) {
    return String((spec && (spec.subId || spec.toolCallId)) || '');
}

function openAgentTab(spec) {
    const key = agentViewKey(spec);
    if (!key) return null;
    const existing = deps.docs.find((d) => d.agentView === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    // 标签页不会自己回收：同一批派单连点会堆一排，只保留最近 8 个子代理视图
    const opened = deps.docs.filter((d) => d.agentView);
    while (opened.length >= AGENT_VIEW_MAX) {
        const oldest = opened.shift();
        if (oldest) deps.closeDocNow(oldest, false);
    }
    const doc = {
        id: 'agentview-' + key,
        path: null,
        name: agentTabName(spec && spec.name),
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'agentview', name: '子代理', extensions: [], aceMode: 'text', rawOnly: true},
        agentView: key,
        agentViewSpec: {
            toolCallId: String((spec && spec.toolCallId) || ''),
            subId: String((spec && spec.subId) || ''),
            name: String((spec && spec.name) || '子代理'),
            // 详情所在的会话（头部状态兜底用它精确补正文，不扫全部会话）
            sessionId: String((spec && spec.sessionId) || ''),
        },
        mode: 'agentview',
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

function createAgentView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active agentview-pane';
    deps.els.editor.appendChild(pane);
    const root = document.createElement('div');
    root.className = 'agentview-root';
    pane.appendChild(root);
    doc.pane = pane;
    doc.agentViewRoot = root;

    const mounted = deps.aiPanel && deps.aiPanel.bridgeMountAgentView
        ? deps.aiPanel.bridgeMountAgentView(root, doc.agentViewSpec)
        : null;
    if (!mounted) {
        root.textContent = doc.agentViewSpec && doc.agentViewSpec.subId
            ? '这个子代理的记录已不在本运行期（应用重启后只保留状态与结论），无法再展开视图。'
            : '子代理视图不可用：AI 面板尚未就绪。';
        root.classList.add('empty');
        return;
    }
    doc.agentViewUnmount = () => {
        if (deps.aiPanel && deps.aiPanel.bridgeUnmountAgentView) deps.aiPanel.bridgeUnmountAgentView(root);
    };
}

return {createAgentView, openAgentTab};
}
