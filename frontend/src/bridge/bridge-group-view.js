// bridge-group-view.js：群聊虚拟文档标签页（内容区承载看板 + 多成员消息，照 sidechat 先例）。
// doc.groupChat = groupId；关闭标签页不删除群、不停止讨论，重开恢复。
// 接线四处同步（test/editor/virtual-doc-wiring.test.mjs 卡）：createDocEditor 分支 /
// viewOptionsFor / closeDocNow 卸载 / 本文件的 doc.groupChat 创建点。
const MAX_TABS = 3;

export function createBridgeGroupView(deps) {
    function openGroupChatTab(spec) {
        const groupId = String((spec && spec.groupId) || '');
        if (!groupId) return null;
        const existing = deps.docs.find((doc) => doc.groupChat === groupId);
        if (existing) {
            deps.activateDoc(existing);
            return existing;
        }
        // 上限淘汰最旧（群标签页与 sidechat 各自计数，互不挤占）
        const opened = deps.docs.filter((doc) => doc.groupChat);
        while (opened.length >= MAX_TABS) {
            const oldest = opened.shift();
            if (oldest) deps.closeDocNow(oldest, false);
        }
        const doc = {
            id: 'groupchat-' + groupId,
            path: null,
            name: tabName(spec && spec.title),
            content: '',
            size: 0,
            eol: 'lf',
            hasBom: false,
            large: false,
            enc: 'utf-8',
            format: {id: 'groupchat', name: '群聊', extensions: [], aceMode: 'text', rawOnly: true},
            groupChat: groupId,
            mode: 'groupchat',
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

    function tabName(title) {
        const text = String(title || '群聊').trim() || '群聊';
        return text.length > 20 ? text.slice(0, 20) + '…' : text;
    }

    // 视图主体在 ai/ai-group-view.js（消息 / 流式 / 输入区）；本壳只管标签页与挂载。
    // 视图模块不可用时退回极简占位，不让标签页白屏。
    function createGroupChatView(doc) {
        if (doc.pane) return;
        const view = typeof deps.aiGroupView === 'function' ? deps.aiGroupView() : null;
        if (view && typeof view.createGroupChatView === 'function') {
            view.createGroupChatView(doc, deps.els.editor);
            return;
        }
        const pane = document.createElement('div');
        pane.className = 'jsoneditor-pane active groupchat-pane';
        deps.els.editor.appendChild(pane);
        doc.pane = pane;
        const empty = document.createElement('div');
        empty.className = 'gc-empty';
        empty.textContent = '群聊视图不可用（面板未就绪），重开标签页可恢复。';
        pane.appendChild(empty);
        doc.groupChatUnmount = () => {
            doc.groupChatUnmount = null;
            doc.pane = null;
        };
    }

    return {openGroupChatTab, createGroupChatView};
}
