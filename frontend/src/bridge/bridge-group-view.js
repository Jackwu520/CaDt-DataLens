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

    // G1 空壳：头部（群名/模式/成员色点）+ 消息区空态；G2 接消息与流式，G3 接看板抽屉。
    function createGroupChatView(doc) {
        if (doc.pane) return;
        const runtime = typeof deps.aiGroupRuntime === 'function' ? deps.aiGroupRuntime() : null;
        const pane = document.createElement('div');
        pane.className = 'jsoneditor-pane active groupchat-pane';
        deps.els.editor.appendChild(pane);
        doc.pane = pane;

        const head = document.createElement('div');
        head.className = 'gc-head';
        const body = document.createElement('div');
        body.className = 'gc-body';
        pane.append(head, body);

        const state = runtime ? runtime.groupById(doc.groupChat) : null;
        const meta = state ? state.meta : null;
        const config = typeof deps.getAIConfig === 'function' ? deps.getAIConfig() : null;
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];

        const title = document.createElement('div');
        title.className = 'gc-head-title';
        title.textContent = meta ? (meta.title || '未命名群聊') : doc.name;
        head.appendChild(title);
        if (meta) {
            const chips = document.createElement('div');
            chips.className = 'gc-head-chips';
            const modeChip = document.createElement('span');
            modeChip.className = 'gc-badge';
            modeChip.textContent = meta.mode === 'task' ? '任务' : meta.mode === 'free' ? '自由' : '圆桌';
            chips.appendChild(modeChip);
            const goalChip = document.createElement('span');
            goalChip.className = 'gc-badge';
            goalChip.textContent = `第 ${meta.maxRounds} 轮上限`;
            chips.appendChild(goalChip);
            const dots = document.createElement('div');
            dots.className = 'gc-head-dots';
            for (const id of meta.memberIds) {
                const agent = agents.find((item) => item && item.id === id);
                const dot = document.createElement('span');
                dot.className = 'gc-dot';
                dot.dataset.tip = agent ? agent.name : '已删除成员';
                dot.style.backgroundColor = dotColor(agent);
                dots.appendChild(dot);
            }
            chips.appendChild(dots);
            head.appendChild(chips);
        }
        if (meta && meta.topic) {
            const topic = document.createElement('div');
            topic.className = 'gc-head-topic';
            topic.textContent = meta.topic;
            head.appendChild(topic);
        }

        const empty = document.createElement('div');
        empty.className = 'gc-empty';
        empty.textContent = state
            ? '群聊已创建。讨论引擎接入后：主持人开场 → 成员按轮发言 → 纪要。'
            : '群聊数据加载中或不存在。';
        body.appendChild(empty);

        doc.groupChatRoot = pane;
        doc.groupChatBody = body;
        doc.groupChatHead = head;
        const unsub = runtime ? runtime.subscribe(() => refreshHead(doc)) : null;
        doc.groupChatUnmount = () => {
            if (unsub) unsub();
            doc.groupChatUnmount = null;
            doc.groupChatRoot = null;
            doc.groupChatBody = null;
            doc.groupChatHead = null;
            doc.pane = null;
        };
    }

    function dotColor(agent) {
        const colors = {
            blue: '#4d8bf5', violet: '#8b5cf6', green: '#34a853', amber: '#f59e0b',
            red: '#ef4444', cyan: '#06b6d4', pink: '#ec4899', lime: '#84cc16',
        };
        return colors[agent && agent.color] || '#989898';
    }

    // meta 变化（改名 / 看板更新）时刷新头部；G1 只同步标题。
    function refreshHead(doc) {
        if (!doc || !doc.groupChatHead || !doc.groupChatRoot) return;
        const runtime = typeof deps.aiGroupRuntime === 'function' ? deps.aiGroupRuntime() : null;
        const state = runtime ? runtime.groupById(doc.groupChat) : null;
        if (!state) return;
        const titleEl = doc.groupChatHead.querySelector('.gc-head-title');
        if (titleEl) titleEl.textContent = state.meta.title || '未命名群聊';
    }

    return {openGroupChatTab, createGroupChatView};
}
