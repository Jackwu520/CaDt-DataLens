// ai-message-queue.js：AI 面板消息排队 / 插话（流式生成中 Enter 排队、Ctrl+Enter 插话、结束后冲刷）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// 仅 attachments / dismissedPlanApproval 两个重赋值 let 改经 ctx 访问器读写。
import {iconSvg} from '../core/icons.js';

export function createAIMessageQueue(ctx) {
    const el = ctx.el;
    // 队列所有权在本模块（阶段 A 迁移）：panel / composer / 设置页一律经下面这组 API 访问，
    // 不再各自持有数组引用——历史上所有权在 panel、flush 调用点散布在三处，容易漏刷。
    const messageQueue = [];
    const interjectPending = new Set();  // sessionId：该会话有一条「插话」待优先发送
    const streams = ctx.streams;
    const flash = ctx.flash;
    const positionOverlays = ctx.positionOverlays;
    const compactOf = ctx.compactOf;
    const currentSession = ctx.currentSession;
    const syncStreamView = ctx.syncStreamView;
    const currentQueueItems = ctx.currentQueueItems;
    const planApprovalMessage = ctx.planApprovalMessage;
    const planApprovalKey = ctx.planApprovalKey;
    const updateComposerTakeover = ctx.updateComposerTakeover;
    const editQueuedMessage = ctx.editQueuedMessage;
    const captureComposerMessage = ctx.captureComposerMessage;
    const handleSlashText = ctx.handleSlashText;
    const stopGeneration = ctx.stopGeneration;
    const renderAttachments = ctx.renderAttachments;
    const resizeInput = ctx.resizeInput;
    const submitText = ctx.submitText;
    const updateSendState = ctx.updateSendState;
    const currentPendingAskEntry = ctx.currentPendingAskEntry;
    const getAttachments = ctx.getAttachments;
    const setAttachments = ctx.setAttachments;
    const getDismissedPlanApproval = ctx.getDismissedPlanApproval;
    const setDismissedPlanApproval = ctx.setDismissedPlanApproval;
    const getStream = ctx.getStream;

    function renderMessageQueue() {
        if (!el.queue) return;
        syncStreamView();
        const items = currentQueueItems();
        const session = currentSession();
        const plan = session ? planApprovalMessage(session) : null;
        const planKey = plan ? planApprovalKey(session, plan) : '';
        const showPlanReminder = !!(plan && getDismissedPlanApproval() === planKey);
        el.queue.innerHTML = '';
        el.queue.classList.toggle('hidden', !items.length && !showPlanReminder);
        if (showPlanReminder) {
            const row = document.createElement('div');
            row.className = 'ai-queue-row ai-plan-reminder';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            badge.textContent = '计划';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            text.textContent = '计划等待批准';
            const view = document.createElement('button');
            view.type = 'button';
            view.className = 'ai-queue-action';
            view.textContent = '查看';
            view.addEventListener('click', () => {
                setDismissedPlanApproval('');
                updateComposerTakeover(true);
                renderMessageQueue();
            });
            row.append(badge, text, view);
            el.queue.appendChild(row);
        }
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'ai-queue-row';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            badge.textContent = '排队';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            const imageCount = (item.attachments || []).filter((att) => att.kind === 'image').length;
            const attachCount = (item.attachments || []).filter((att) => att.kind !== 'image').length;
            const meta = [];
            if (imageCount) meta.push(imageCount + ' 张图片');
            if (attachCount) meta.push(attachCount + ' 个附件');
            text.textContent = (item.text || '（无文字）') + (meta.length ? ' · ' + meta.join(' · ') : '');
            text.title = item.text || '';
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'ai-queue-action ai-queue-icon';
            edit.innerHTML = iconSvg('rename', 11);
            edit.title = '编辑：取回输入区重新编辑，附件一并带回';
            edit.setAttribute('aria-label', '编辑排队消息');
            edit.addEventListener('click', () => editQueuedMessage(item));
            const interject = document.createElement('button');
            interject.type = 'button';
            interject.className = 'ai-queue-action';
            interject.textContent = '插话';
            interject.title = '停止当前回复并立即发送这条消息';
            interject.addEventListener('click', () => {
                const index = messageQueue.indexOf(item);
                if (index < 0) return;
                if (!streams.has(item.sessionId)) {
                    flushMessageQueue(item.sessionId);
                    return;
                }
                messageQueue.splice(index, 1);
                messageQueue.unshift(item);
                renderMessageQueue();
                flash('插话已排队，正在停止当前回复…');
                interjectPending.add(item.sessionId);
                stopGeneration();
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-queue-action';
            remove.textContent = '×';
            remove.title = '移除这条排队消息';
            remove.addEventListener('click', () => {
                const index = messageQueue.indexOf(item);
                if (index >= 0) messageQueue.splice(index, 1);
                renderMessageQueue();
            });
            row.append(badge, text, edit, interject, remove);
            el.queue.appendChild(row);
        }
        if (el.hint && (getStream() || compactOf((currentSession() || {}).id))) {
            el.hint.textContent = items.length
                ? '已排队 ' + items.length + ' 条 · Enter 继续排队 · Ctrl+Enter 插话'
                : '生成中 · Enter 排队 · Ctrl+Enter 插话';
        }
        positionOverlays();
    }

    function enqueueComposerMessage() {
        if (!syncStreamView() && !compactOf((currentSession() || {}).id)) return false;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (text.startsWith('/')) {
            handleSlashText(text);
            return true;
        }
        const item = captureComposerMessage();
        if (!item) return false;
        messageQueue.push(item);
        renderMessageQueue();
        flash('已加入排队：' + (item.text ? item.text.slice(0, 24) : '图片'));
        return true;
    }

    function interjectComposerMessage() {
        const session = currentSession();
        if (!session) return;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (text.startsWith('/')) {
            handleSlashText(text);
            return;
        }
        const item = captureComposerMessage();
        if (!item) return;
        if (compactOf(session.id)) {
            messageQueue.push(item);
            renderMessageQueue();
            flash('正在压缩上下文，消息已排队');
            return;
        }
        if (!streams.has(session.id)) {
            messageQueue.push(item);
            renderMessageQueue();
            flushMessageQueue(session.id);
            return;
        }
        messageQueue.unshift(item);
        renderMessageQueue();
        flash('插话已排队，正在停止当前回复…');
        interjectPending.add(session.id);
        stopGeneration();
    }

    async function flushMessageQueue(sessionId) {
        if (!sessionId || streams.has(sessionId) || compactOf(sessionId)) return;
        const session = currentSession();
        if (!session || session.id !== sessionId || session.archivedAt) return;
        if (currentPendingAskEntry() || planApprovalMessage(session)) return;
        const index = messageQueue.findIndex((item) => item.sessionId === sessionId);
        if (index < 0) return;
        // 输入区还有没发出去的内容（草稿 / 附件）时先不动排队：等这一条发完再冲刷，
        // 否则会把用户正在写的东西顶掉（历史上就是直接覆盖的）。
        if ((el.input && el.input.value.trim()) || getAttachments().length) return;
        const item = messageQueue[index];
        messageQueue.splice(index, 1);
        renderMessageQueue();
        setAttachments((item.attachments || []).map((att) => ({...att})));
        renderAttachments();
        if (el.input) el.input.value = item.text || '';
        resizeInput();
        const ok = await submitText(item.text || '');
        if (!ok) {
            messageQueue.splice(Math.min(index, messageQueue.length), 0, item);
            if (el.input) el.input.value = '';
            setAttachments([]);
            renderAttachments();
            resizeInput();
            renderMessageQueue();
            updateSendState();
        }
    }

    function clearQueueForSession(sessionId) {
        for (let i = messageQueue.length - 1; i >= 0; i--) {
            if (messageQueue[i].sessionId === sessionId) messageQueue.splice(i, 1);
        }
        interjectPending.delete(sessionId);
        renderMessageQueue();
    }
    // ---- 队列所有权 API（供 panel / composer / 设置页消费；不暴露可变数组本体）----
    function items() {
        return messageQueue.slice();
    }

    function itemsForSession(sessionId) {
        return messageQueue.filter((item) => item.sessionId === sessionId);
    }

    function hasItems() {
        return messageQueue.length > 0;
    }

    function pushItem(item) {
        messageQueue.push(item);
    }

    function unshiftItem(item) {
        messageQueue.unshift(item);
    }

    function indexOfItem(item) {
        return messageQueue.indexOf(item);
    }

    function removeItem(item) {
        const index = messageQueue.indexOf(item);
        if (index >= 0) messageQueue.splice(index, 1);
        return index >= 0;
    }

    function insertItem(index, item) {
        messageQueue.splice(Math.max(0, Math.min(index, messageQueue.length)), 0, item);
    }

    function clearAll() {
        messageQueue.length = 0;
        interjectPending.clear();
    }

    function hasInterject(sessionId) {
        return interjectPending.has(sessionId);
    }

    function addInterject(sessionId) {
        interjectPending.add(sessionId);
    }

    function clearInterject(sessionId) {
        interjectPending.delete(sessionId);
    }

    return {
        renderMessageQueue,
        enqueueComposerMessage,
        interjectComposerMessage,
        flushMessageQueue,
        clearQueueForSession,
        items,
        itemsForSession,
        hasItems,
        pushItem,
        unshiftItem,
        indexOfItem,
        removeItem,
        insertItem,
        clearAll,
        hasInterject,
        addInterject,
        clearInterject,
    };
}
