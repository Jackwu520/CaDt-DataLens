// ai-message-queue.js：AI 面板消息排队 / 插话 / 抢占（流式生成中 Enter 排队、Ctrl+Enter 插话、
// Ctrl+Shift+Enter 抢占，结束后冲刷）。队列状态机是纯模型（createQueueModel），DOM 壳只做渲染与接线；
// 方案见 docs/finished-plans/ai-turn-steering.md。
import {iconSvg} from '../core/icons.js';
import {AI_QUOTE_KIND} from './ai-quote.js';

// 插话（steer）请求模板：只作用于发给模型的请求，落盘与气泡仍是用户原文（见 ai-panel.js buildApiMessages）。
// 文案与 ZCode 的 user_steer 对齐——改文案要同步 test/ai/ai-turn-steer-wiring.test.mjs。
export function formatSteerMessage(text) {
    return 'The user sent a new message while you were working:\n' + String(text == null ? '' : text) + '\n\n' +
        'This is a mid-turn message. Address it as you continue your current task, ' +
        'rather than treating it as a separate conversation turn.';
}

// 队列 item id 用字符串：跨端合并按 id 去重（自增数字在两端会撞号）。
let queueItemSeq = 0;
function nextQueueItemId() {
    queueItemSeq += 1;
    return 'q_' + Date.now() + '_' + queueItemSeq;
}

function copyQueueItem(item) {
    // 快照是跨端同步的同步单元：优先整体深拷贝，附件里可能有嵌套对象（选区行号等）。
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(item);
        } catch (e) {
            // 含不可克隆值（理论上不该有）时退回浅拷贝，至少不把队列本体交出去
        }
    }
    return {...item, attachments: (item.attachments || []).map((att) => ({...att}))};
}

// 纯队列模型（无 DOM / 无 flash 依赖）：单一队列 + delivery 车道（'queue' | 'steer'）。
// 单一队列是为了将来跨端整体同步：item 自带 delivery，合并按 id 去重即可。
export function createQueueModel(options) {
    // onChange：条目入队后的通知钩子（ai-message-queue 用它唤醒 wait_agent 的调用方）。
    // 纯模型本身不认识会话与等待者，钩子由装配方传入，测试不传即空跑。
    const onChange = options && typeof options.onChange === 'function' ? options.onChange : null;
    let items = [];

    function makeItem(payload) {
        return {
            id: nextQueueItemId(),
            sessionId: payload.sessionId,
            text: payload.text == null ? '' : String(payload.text),
            attachments: (payload.attachments || []).slice(),
            delivery: payload.delivery === 'steer' ? 'steer' : 'queue',
            ts: Date.now(),
            roundId: payload.roundId || '',
        };
    }

    function enqueue(payload) {
        const item = makeItem(payload || {});
        items.push(item);
        if (onChange) onChange(item);
        return item;
    }

    function enqueueFront(payload) {
        const item = makeItem(payload || {});
        items.unshift(item);
        if (onChange) onChange(item);
        return item;
    }

    function findIndex(itemOrId) {
        const id = itemOrId && typeof itemOrId === 'object' ? itemOrId.id : itemOrId;
        return items.findIndex((item) => item.id === id);
    }

    return {
        enqueue,
        enqueueFront,
        all: () => items.slice(),
        forSession: (sessionId) => items.filter((item) => item.sessionId === sessionId),
        hasItems: () => items.length > 0,
        indexOf: (item) => findIndex(item),
        remove(item) {
            const index = findIndex(item);
            if (index < 0) return false;
            items.splice(index, 1);
            return true;
        },
        insert(index, item) {
            items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
        },
        hasSteer: (sessionId) => items.some((item) => item.sessionId === sessionId && item.delivery === 'steer'),
        // 改投车道：队列行「插话 / 排队」按钮与窗口关闭时的静默降级都走这里（一次同步操作内完成）。
        setDelivery(itemOrId, delivery) {
            const index = findIndex(itemOrId);
            if (index < 0) return false;
            const target = items[index];
            const next = delivery === 'steer' ? 'steer' : 'queue';
            if (target.delivery === next) return false;
            target.delivery = next;
            return true;
        },
        // 队列行拖动排序：只重排目标会话的条目，其它会话的槽位保持不动（flush 按会话取队首）。
        reorderSession(sessionId, orderedIds) {
            const ids = Array.isArray(orderedIds) ? orderedIds : [];
            const slots = [];
            const byId = new Map();
            for (let i = 0; i < items.length; i++) {
                if (items[i].sessionId !== sessionId) continue;
                slots.push(i);
                byId.set(items[i].id, items[i]);
            }
            const ordered = [];
            const seen = new Set();
            for (const id of ids) {
                const item = byId.get(id);
                if (!item || seen.has(id)) continue;
                seen.add(id);
                ordered.push(item);
            }
            // 防御：orderedIds 漏掉的条目按原顺序补在末尾（不丢消息）。
            for (const item of byId.values()) if (!seen.has(item.id)) ordered.push(item);
            if (ordered.length !== slots.length) return false;
            slots.forEach((slot, index) => { items[slot] = ordered[index]; });
            return true;
        },
        // FIFO 取出该会话全部 steer（roundId 只用于诊断，不参与过滤）；取后从队列移除。
        drainSteer(sessionId) {
            const taken = items.filter((item) => item.sessionId === sessionId && item.delivery === 'steer');
            if (!taken.length) return [];
            items = items.filter((item) => !taken.includes(item));
            return taken;
        },
        // drain 后预算超限的回滚：按时间顺序放回同会话队列项之间（保持 FIFO），并改投 queue。
        restoreItems(list, delivery = 'queue') {
            const next = delivery === 'steer' ? 'steer' : 'queue';
            const restored = (list || []).slice();
            if (!restored.length) return;
            for (const item of restored) item.delivery = next;
            const sessionId = restored[0].sessionId;
            const lastTs = restored.reduce((max, item) => Math.max(max, Number(item.ts) || 0), 0);
            // 放到「同会话第一条更晚入队的消息」之前；没有更晚的就落到队尾。
            // 不同会话之间的相对位置不影响消费（flush 按会话取队首）。
            let insertAt = items.length;
            for (let i = 0; i < items.length; i++) {
                if (items[i].sessionId === sessionId && (Number(items[i].ts) || 0) > lastTs) {
                    insertAt = i;
                    break;
                }
            }
            items.splice(insertAt, 0, ...restored);
        },
        fallbackSteerToQueue(sessionId) {
            let changed = false;
            for (const item of items) {
                if (item.sessionId === sessionId && item.delivery === 'steer') {
                    item.delivery = 'queue';
                    changed = true;
                }
            }
            return changed;
        },
        clearSteer(sessionId) {
            const dropped = items.filter((item) => item.sessionId === sessionId && item.delivery === 'steer');
            if (!dropped.length) return [];
            items = items.filter((item) => !dropped.includes(item));
            return dropped;
        },
        clearForSession(sessionId) {
            items = items.filter((item) => item.sessionId !== sessionId);
        },
        clearAll() {
            items = [];
        },
        // 跨端同步快照（深拷贝：改快照不影响队列本体）。
        snapshot: (sessionId) => ({
            sessionId,
            items: items.filter((item) => item.sessionId === sessionId).map(copyQueueItem),
        }),
    };
}

export function createAIMessageQueue(ctx) {
    const el = ctx.el;
    // 队列所有权在本模块（阶段 A 迁移）：panel / composer / 设置页一律经下面这组 API 访问，
    // 不再各自持有数组引用——历史上所有权在 panel、flush 调用点散布在三处，容易漏刷。
    // 入队即唤醒 wait_agent 的调用方：主代理可能在等「用户插话 / 排队消息」。
    // 只唤醒不注入——真正注入仍在轮边界（flushMessageQueue / steer 边界），
    // 在工具调用中间插消息会破坏轮次模型。
    const model = createQueueModel({
        onChange: (item) => {
            const waiter = ctx.inboxWaiters;
            if (waiter && typeof waiter.notify === 'function' && item && item.sessionId) {
                waiter.notify(item.sessionId);
            }
        },
    });
    const interjectPending = new Set();  // sessionId：该会话有一条「抢占」消息待优先发送
    let draggingQueueId = '';            // 队列行拖动排序中的 item id（仅本模块内使用）
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
    const videoSteerAllowed = ctx.videoSteerAllowed;

    // 当前查看会话的流是否还能接受 steer：已停止 / 已收尾的流不再收——stopGeneration 后
    // 最多 1.2s 内 streams 仍登记着它，此时入队 steer 会被 finishStream 的 clearSteer 丢掉。
    function liveSteerableStream(sessionId) {
        const live = getStream();
        if (!live || live.sessionId !== sessionId) return null;
        if (live.stopped || live.finished) return null;
        return live;
    }

    // 拖动排序的落点提示：清掉所有行的插入标记（重绘 / dragend / drop 都要清）。
    function clearQueueDropMarks() {
        if (!el.queue) return;
        for (const row of el.queue.querySelectorAll('.drop-before, .drop-after, .dragging')) {
            row.classList.remove('drop-before', 'drop-after', 'dragging');
        }
    }

    // 把拖动项放到目标项之前 / 之后（只重排当前会话，其它会话槽位不动）。
    function reorderQueueItem(draggedId, targetId, after) {
        if (!draggedId || !targetId || draggedId === targetId) return;
        const session = currentSession();
        if (!session) return;
        const ids = model.forSession(session.id).map((item) => item.id);
        const from = ids.indexOf(draggedId);
        if (from < 0) return;
        ids.splice(from, 1);
        let to = ids.indexOf(targetId);
        if (to < 0) return;
        if (after) to += 1;
        ids.splice(to, 0, draggedId);
        if (model.reorderSession(session.id, ids)) renderMessageQueue();
    }

    function renderMessageQueue() {
        if (!el.queue) return;
        // 重绘会换掉行 DOM：进行中的拖动直接作废，避免 dragend 丢失后留下过期的拖动 id。
        draggingQueueId = '';
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
            // 拖动排序手柄（3×3 点阵）：只让手柄可拖，行内按钮仍可正常点击。
            const handle = document.createElement('span');
            handle.className = 'ai-queue-drag';
            handle.draggable = true;
            handle.dataset.tip = '拖动排序：调整排队消息的发送顺序';
            handle.setAttribute('aria-label', '拖动排序');
            handle.innerHTML = iconSvg('grip', 12);
            handle.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer) return;
                draggingQueueId = item.id;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.id);
                try { e.dataTransfer.setDragImage(row, 12, 12); } catch (err) { /* 拖动预览失败不影响排序 */ }
                row.classList.add('dragging');
            });
            handle.addEventListener('dragend', () => {
                draggingQueueId = '';
                clearQueueDropMarks();
            });
            row.addEventListener('dragover', (e) => {
                if (!draggingQueueId) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                const rect = row.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                row.classList.toggle('drop-after', after);
                row.classList.toggle('drop-before', !after);
            });
            row.addEventListener('dragleave', (e) => {
                if (row.contains(e.relatedTarget)) return;
                row.classList.remove('drop-before', 'drop-after');
            });
            row.addEventListener('drop', (e) => {
                if (!draggingQueueId) return;
                e.preventDefault();
                const rect = row.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                const draggedId = draggingQueueId;
                draggingQueueId = '';
                clearQueueDropMarks();
                reorderQueueItem(draggedId, item.id, after);
            });
            const steering = item.delivery === 'steer';
            const badge = document.createElement('span');
            badge.className = 'ai-queue-badge';
            badge.textContent = steering ? '插话' : '排队';
            const text = document.createElement('span');
            text.className = 'ai-queue-text';
            const imageCount = (item.attachments || []).filter((att) => att.kind === 'image').length;
            const attachCount = (item.attachments || []).filter((att) => att.kind !== 'image').length;
            const meta = [];
            if (imageCount) meta.push(imageCount + ' 张图片');
            if (attachCount) meta.push(attachCount + ' 个附件');
            text.textContent = (item.text || '（无文字）') + (meta.length ? ' · ' + meta.join(' · ') : '');
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'ai-queue-action ai-queue-icon';
            edit.innerHTML = iconSvg('rename', 11);
            edit.dataset.tip = '编辑：取回输入区重新编辑，附件一并带回';
            edit.setAttribute('aria-label', '编辑排队消息');
            edit.addEventListener('click', () => editQueuedMessage(item));
            const interject = document.createElement('button');
            interject.type = 'button';
            interject.className = 'ai-queue-action';
            interject.textContent = steering ? '排队' : '插话';
            interject.dataset.tip = steering
                ? '撤回插话，改回当前轮结束后发送'
                : '在当前轮的下一个工具边界注入，不打断当前工作';
            interject.addEventListener('click', () => {
                if (steering) {
                    if (model.setDelivery(item, 'queue')) {
                        renderMessageQueue();
                        flash('已改回排队：本轮结束后发送');
                    }
                    return;
                }
                // 不可 steer 的状态（压缩中）静默保持排队；轮已结束则按普通发送冲刷。
                if (compactOf(item.sessionId)) {
                    flash('正在压缩上下文，消息保持排队');
                    return;
                }
                if (!streams.has(item.sessionId)) {
                    flushMessageQueue(item.sessionId);
                    return;
                }
                if (!liveSteerableStream(item.sessionId)) {
                    // 停止 / 收尾窗口：改投 steer 必被清掉，保持排队并登记待冲刷。
                    interjectPending.add(item.sessionId);
                    flash('当前轮正在停止，消息将随后发送');
                    return;
                }
                if (model.setDelivery(item, 'steer')) {
                    renderMessageQueue();
                    flash('已改为插话：将在下一个工具边界生效');
                }
            });
            const preempt = document.createElement('button');
            preempt.type = 'button';
            preempt.className = 'ai-queue-action ai-queue-icon';
            preempt.innerHTML = iconSvg('zap', 11);
            preempt.dataset.tip = '抢占：停止当前回复并立即发送这条消息';
            preempt.setAttribute('aria-label', '抢占发送');
            // 只有当前轮还活着（含停止收尾窗口）时才有抢占语义；空闲时队列会自行冲刷。
            if (streams.has(item.sessionId)) preempt.addEventListener('click', () => preemptQueuedItem(item));
            else preempt.classList.add('hidden');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ai-queue-action';
            remove.textContent = '×';
            remove.dataset.tip = '移除这条排队消息';
            remove.addEventListener('click', () => {
                model.remove(item);
                renderMessageQueue();
            });
            row.append(handle, badge, text, edit, interject, preempt, remove);
            el.queue.appendChild(row);
        }
        if (el.hint) {
            if (getStream()) {
                const steerCount = items.filter((item) => item.delivery === 'steer').length;
                const queueCount = items.length - steerCount;
                if (!items.length) {
                    el.hint.textContent = '生成中';
                } else {
                    const parts = [];
                    if (queueCount) parts.push('排队 ' + queueCount + ' 条');
                    if (steerCount) parts.push('插话 ' + steerCount + ' 条');
                    el.hint.textContent = '已' + parts.join(' · ');
                }
            } else if (items.length && compactOf((currentSession() || {}).id)) {
                // 压缩中不覆盖「正在压缩上下文…」，只补排队条数
                el.hint.textContent = '正在压缩上下文 · 已排队 ' + items.length + ' 条';
            }
        }
        positionOverlays();
    }

    // opts.plain：跳过「/ 开头转斜杠命令」检查——斜杠技能调用（sendComposerMessage）的
    // 文本本身以 / 开头但已是待发消息，再转 handleSlashText 会死循环。
    function enqueueComposerMessage(opts) {
        if (!syncStreamView() && !compactOf((currentSession() || {}).id)) return false;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (!(opts && opts.plain) && text.startsWith('/')) {
            handleSlashText(text);
            return true;
        }
        const payload = captureComposerMessage();
        if (!payload) return false;
        const item = model.enqueue(payload);
        renderMessageQueue();
        flash('已加入排队：' + (item.text ? item.text.slice(0, 24) : '图片'));
        return true;
    }

    // 插话（steer）：不打断当前轮，条目以 delivery:'steer' 留在队列，下一个工具边界注入。
    // 压缩中 / 空闲 / 带文件类附件时静默降级为排队（不报错，见方案 §4.5）。
    function interjectComposerMessage(opts) {
        const session = currentSession();
        if (!session) return;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (!(opts && opts.plain) && text.startsWith('/')) {
            handleSlashText(text);
            return;
        }
        const payload = captureComposerMessage();
        if (!payload) return;
        if (compactOf(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('正在压缩上下文，消息已排队');
            return;
        }
        if (!streams.has(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flushMessageQueue(session.id);
            return;
        }
        const live = liveSteerableStream(session.id);
        if (!live) {
            // 停止 / 收尾窗口（stopGeneration 已置 stopped、finishStream 还没跑）：此时入队
            // steer 会被收尾的 clearSteer 丢弃，降级为排队并登记待冲刷，消息不丢。
            model.enqueue(payload);
            interjectPending.add(session.id);
            renderMessageQueue();
            flash('当前轮已停止，消息将在收尾后发送');
            return;
        }
        // 第一版 steer 只支持文字 + 引用 markup + 图片/视频：文件 / 技能 / 选区附件
        // 需要在轮中重组 <attachments> 环境块，直接按排队处理。
        const unsupported = (payload.attachments || []).some((att) =>
            att.kind !== 'image' && att.kind !== 'video' && att.kind !== AI_QUOTE_KIND);
        if (unsupported) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('文件附件将随下一轮发送：已排队');
            return;
        }
        // 视频 steer 与正常发送走同一条协议门禁：否则历史里会留下一条每轮请求都被拒收的视频消息。
        const hasVideo = (payload.attachments || []).some((att) => att.kind === 'video');
        if (hasVideo && !videoSteerAllowed(session)) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('当前模型或协议不支持视频输入：已改为排队，请换模型或移除视频', true);
            return;
        }
        model.enqueue({...payload, delivery: 'steer', roundId: live.roundId || ''});
        renderMessageQueue();
        flash('已插话：将在下一个工具边界生效');
    }

    // 抢占（preempt）：停掉当前轮，消息作为普通用户消息开新一轮（原「插话」语义）。
    function preemptComposerMessage(opts) {
        const session = currentSession();
        if (!session) return;
        const text = el.input ? String(el.input.value || '').trim() : '';
        if (!(opts && opts.plain) && text.startsWith('/')) {
            handleSlashText(text);
            return;
        }
        const payload = captureComposerMessage();
        if (!payload) return;
        if (compactOf(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flash('正在压缩上下文，消息已排队');
            return;
        }
        if (!streams.has(session.id)) {
            model.enqueue(payload);
            renderMessageQueue();
            flushMessageQueue(session.id);
            return;
        }
        if (!liveSteerableStream(session.id)) {
            // 已在停止 / 收尾：不再重复 stopGeneration，消息插到队首由收尾冲刷。
            model.enqueueFront(payload);
            interjectPending.add(session.id);
            renderMessageQueue();
            flash('当前轮正在停止，消息将随后发送');
            return;
        }
        model.enqueueFront(payload);
        renderMessageQueue();
        flash('已抢占：正在停止当前回复…');
        interjectPending.add(session.id);
        stopGeneration();
    }

    // 队列行「抢占」：停掉当前轮，把这条消息作为普通用户消息立即发送（原「插话」语义）。
    // 行内已有编辑 / 改投 / 删除三个文字动作，这里用 ⚡ 图标 + tooltip，避免把行挤爆。
    function preemptQueuedItem(item) {
        const sessionId = item.sessionId;
        if (compactOf(sessionId)) {
            flash('正在压缩上下文，消息保持排队');
            return;
        }
        const index = model.indexOf(item);
        if (index < 0) return;
        model.setDelivery(item, 'queue');
        model.remove(item);
        model.insert(0, item);
        interjectPending.add(sessionId);
        renderMessageQueue();
        if (liveSteerableStream(sessionId)) {
            flash('已抢占：正在停止当前回复…');
            stopGeneration();
            return;
        }
        if (streams.has(sessionId)) {
            // 已在停止 / 收尾窗口：交给 finishStream 的 shouldFlush 冲刷。
            flash('当前轮正在停止，消息将随后发送');
            return;
        }
        flushMessageQueue(sessionId);
    }

    async function flushMessageQueue(sessionId) {
        if (!sessionId || streams.has(sessionId) || compactOf(sessionId)) return;
        const session = currentSession();
        if (!session || session.id !== sessionId || session.archivedAt) return;
        if (currentPendingAskEntry() || planApprovalMessage(session)) return;
        const item = model.forSession(sessionId)[0];
        if (!item) return;
        // 输入区还有没发出去的内容（草稿 / 附件）时先不动排队：等这一条发完再冲刷，
        // 否则会把用户正在写的东西顶掉（历史上就是直接覆盖的）。
        if ((el.input && el.input.value.trim()) || getAttachments().length) return;
        const index = model.indexOf(item);
        model.remove(item);
        renderMessageQueue();
        setAttachments((item.attachments || []).map((att) => ({...att})));
        renderAttachments();
        if (el.input) el.input.value = item.text || '';
        resizeInput();
        // preserveScroll：冲刷可能发生在用户上翻阅读时（本轮结束的瞬间），不抢滚动位置；
        // 用户本来贴底的话 stickBottom 仍为 true，keepScroll 渲染照常贴底跟随。
        const ok = await submitText(item.text || '', null, {preserveScroll: true});
        if (!ok) {
            model.insert(Math.min(index, model.all().length), item);
            if (el.input) el.input.value = '';
            setAttachments([]);
            renderAttachments();
            resizeInput();
            renderMessageQueue();
            updateSendState();
        }
    }

    function clearQueueForSession(sessionId) {
        model.clearForSession(sessionId);
        interjectPending.delete(sessionId);
        renderMessageQueue();
    }
    // ---- 队列所有权 API（供 panel / composer / 设置页消费；不暴露可变数组本体）----
    function items() {
        return model.all();
    }

    function itemsForSession(sessionId) {
        return model.forSession(sessionId);
    }

    function hasItems() {
        return model.hasItems();
    }

    function indexOfItem(item) {
        return model.indexOf(item);
    }

    function removeItem(item) {
        return model.remove(item);
    }

    function insertItem(index, item) {
        model.insert(index, item);
    }

    function clearAll() {
        model.clearAll();
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
        preemptComposerMessage,
        preemptQueuedItem,
        flushMessageQueue,
        clearQueueForSession,
        items,
        itemsForSession,
        hasItems,
        enqueueItem: (payload) => model.enqueue(payload),
        indexOfItem,
        removeItem,
        insertItem,
        clearAll,
        hasInterject,
        addInterject,
        clearInterject,
        // steer 车道（ai-panel.js 轮边界 drain / 收尾兜底；第二期跨端同步从这里接）
        hasSteer: (sessionId) => model.hasSteer(sessionId),
        drainSteer: (sessionId) => model.drainSteer(sessionId),
        restoreItems: (list, delivery) => model.restoreItems(list, delivery),
        setDelivery: (item, delivery) => model.setDelivery(item, delivery),
        reorderSession: (sessionId, ids) => model.reorderSession(sessionId, ids),
        fallbackSteerToQueue: (sessionId) => model.fallbackSteerToQueue(sessionId),
        clearSteer: (sessionId) => model.clearSteer(sessionId),
        snapshot: (sessionId) => model.snapshot(sessionId),
    };
}
