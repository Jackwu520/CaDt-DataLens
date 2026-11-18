// bridge-group-member-view.js：群聊成员详情在内容区的标签页（对齐子代理详情先例）。
// doc.groupMember = `${groupId}:${agentId}`；本模块只负责「建标签页 + 提供容器 + 关标签卸载」，
// 正文渲染归 AI 侧的 ai-group-member-view.js（runtime 订阅、私有过程与动作都在那里）。
export function createBridgeGroupMemberView(deps) {

const MEMBER_VIEW_MAX = 8;

function memberTabName(name) {
    const line = String(name || '成员').replace(/\s+/g, ' ').trim() || '成员';
    return line.length > 20 ? line.slice(0, 20) + '…' : line;
}

function memberViewKey(spec) {
    const groupId = String((spec && spec.groupId) || '');
    const agentId = String((spec && spec.agentId) || '');
    return groupId && agentId ? groupId + ':' + agentId : '';
}

function openGroupMemberTab(spec) {
    const key = memberViewKey(spec);
    if (!key) return null;
    const existing = deps.docs.find((doc) => doc.groupMember === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    // 标签页不会自己回收：连点多个成员会堆一排，只保留最近 8 个成员视图（独立分桶，不挤群内其它标签）
    const opened = deps.docs.filter((doc) => doc.groupMember);
    while (opened.length >= MEMBER_VIEW_MAX) {
        const oldest = opened.shift();
        if (oldest) deps.closeDocNow(oldest, false);
    }
    const doc = {
        id: 'groupmember-' + key.replace(/[^A-Za-z0-9_-]+/g, '-'),
        path: null,
        name: memberTabName(spec && spec.name),
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'groupmember', name: '成员', extensions: [], aceMode: 'text', rawOnly: true},
        groupMember: key,
        groupMemberSpec: {
            groupId: String((spec && spec.groupId) || ''),
            agentId: String((spec && spec.agentId) || ''),
            name: String((spec && spec.name) || '成员'),
            groupTitle: String((spec && spec.groupTitle) || ''),
        },
        mode: 'groupmember',
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

function createGroupMemberView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active groupmember-pane';
    deps.els.editor.appendChild(pane);
    const root = document.createElement('div');
    root.className = 'gm-root';
    pane.appendChild(root);
    doc.pane = pane;
    doc.groupMemberRoot = root;

    const viewMod = typeof deps.aiGroupMemberView === 'function' ? deps.aiGroupMemberView() : null;
    if (viewMod && typeof viewMod.mountMemberView === 'function') {
        viewMod.mountMemberView(root, doc.groupMemberSpec);
    } else {
        root.textContent = '成员详情视图不可用：群聊运行时尚未就绪，重开标签页可恢复。';
        root.classList.add('empty');
    }
    doc.groupMemberUnmount = () => {
        if (viewMod && typeof viewMod.unmountMemberView === 'function') viewMod.unmountMemberView(root);
        doc.groupMemberRoot = null;
    };
}

return {createGroupMemberView, openGroupMemberTab};
}
