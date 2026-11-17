// ai-group-view.js：群聊标签页视图——头部（群名/徽标/点将/讨论控制）、消息区（增量渲染，
// 立场卡 / 纪要卡）、流式行（80ms 节流纯文本流、完成转 Markdown）、看板抽屉、输入区。
// 状态来自 runtime（subscribe 快照 + activeStreamOf + discussionSnapshot）；DOM 只做渲染。
import {createInput, createSelect, createTextarea} from '../core/form-controls.js';
import {AGENT_COLOR_HEX} from './ai-agent-model.js';
import {STANCE_LABELS} from './ai-group-model.js';

const FLUSH_THROTTLE_MS = 80;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function createAIGroupView(deps) {
    const runtime = deps.runtime;
    const getAIConfig = deps.getAIConfig || (() => null);
    const renderMarkdown = typeof deps.renderMarkdown === 'function' ? deps.renderMarkdown : null;
    const enhanceAnswerBody = typeof deps.enhanceAnswerBody === 'function' ? deps.enhanceAnswerBody : null;
    const views = new Map(); // docId → 视图状态（doc 关闭时清理）

    function createGroupChatView(doc, host) {
        if (doc.pane) return;
        const groupId = doc.groupChat;
        const pane = el('div', 'jsoneditor-pane active groupchat-pane');
        host.appendChild(pane);
        doc.pane = pane;

        const head = el('div', 'gc-head');
        const main = el('div', 'gc-main');
        const body = el('div', 'gc-body');
        const drawer = el('div', 'gc-drawer hidden');
        const drawerInner = el('div', 'gc-drawer-inner');
        drawer.appendChild(drawerInner);
        main.append(body, drawer);
        const foot = el('div', 'gc-foot');
        pane.append(head, main, foot);

        const state = {
            doc,
            groupId,
            pane,
            head,
            body,
            drawer,
            drawerInner,
            list: el('div', 'gc-messages'),
            streamingRow: null,
            streamingKey: '',
            streamingContentEl: null,
            streamingNoteEl: null,
            elapsedTimer: null,
            renderedCount: 0,
            lastMetaStamp: 0,
            lastDiscPhase: '',
            flushTimer: null,
            memberSelect: null,
            focusInput: null,
            composerCtl: null,
            unsub: null,
        };
        body.appendChild(state.list);

        // ---- 头部 ----
        const titleRow = el('div', 'gc-head-row');
        const title = el('div', 'gc-head-title', doc.name);
        titleRow.appendChild(title);
        state.titleEl = title;
        state.chipsEl = el('div', 'gc-head-chips');
        titleRow.appendChild(state.chipsEl);
        head.appendChild(titleRow);
        state.topicEl = el('div', 'gc-head-topic');
        head.appendChild(state.topicEl);

        // 点将行（手动调度 / 用户主持）
        const controlRow = el('div', 'gc-controls');
        state.memberSelect = createSelect({options: [{value: '', label: '选择发言成员'}]});
        state.memberSelect.element.classList.add('gc-member-select');
        controlRow.appendChild(state.memberSelect.element);
        state.focusInput = createInput({placeholder: '焦点（可选）：要求回应谁 / 解决什么'});
        controlRow.appendChild(state.focusInput.element);
        const speakBtn = el('button', 'dlg-btn', '请发言');
        speakBtn.type = 'button';
        speakBtn.addEventListener('click', () => {
            const agentId = state.memberSelect.control.value;
            if (!agentId) return;
            const focus = String(state.focusInput.control.value || '').trim();
            runtime.speak(groupId, agentId, {focus}).then((result) => {
                if (!result.ok) flashOf(state)(result.error, true);
            }).catch((e) => flashOf(state)((e && e.message) || String(e), true));
        });
        controlRow.appendChild(speakBtn);
        head.appendChild(controlRow);

        // 讨论控制行（G3）
        const discRow = el('div', 'gc-disc-row');
        const startBtn = el('button', 'dlg-btn primary', '开始讨论');
        startBtn.addEventListener('click', () => runtime.startDiscussion(groupId));
        const pauseBtn = el('button', 'dlg-btn hidden', '暂停');
        pauseBtn.addEventListener('click', () => runtime.pauseDiscussion(groupId));
        const resumeBtn = el('button', 'dlg-btn hidden', '继续');
        resumeBtn.addEventListener('click', () => runtime.resumeDiscussion(groupId));
        const endBtn = el('button', 'dlg-btn', '结束并总结');
        endBtn.dataset.tip = '停止在飞请求，按看板生成本场纪要';
        endBtn.addEventListener('click', () => runtime.endDiscussion(groupId));
        const compressBtn = el('button', 'dlg-btn', '压缩群聊数据');
        compressBtn.dataset.tip = '生成共享摘要 + 截止点；最近 1 轮全文保留，原始日志不删';
        compressBtn.addEventListener('click', () => {
            compressBtn.disabled = true;
            compressBtn.textContent = '压缩中…';
            runtime.compressShared(groupId, {keepRounds: 1}).then((result) => {
                if (!result.ok) flashOf(state)(result.error, true);
            }).catch((e) => flashOf(state)((e && e.message) || String(e), true)).finally(() => {
                compressBtn.disabled = false;
                compressBtn.textContent = '压缩群聊数据';
            });
        });
        const polishBtn = el('button', 'dlg-btn hidden', '润色纪要');
        polishBtn.dataset.tip = '主持人按看板与关键发言重写一份自然语言纪要（1 次调用）';
        polishBtn.addEventListener('click', () => {
            polishBtn.disabled = true;
            runtime.polishMinutes(groupId).then((result) => {
                if (!result.ok) flashOf(state)(result.error, true);
            }).catch((e) => flashOf(state)((e && e.message) || String(e), true)).finally(() => {
                polishBtn.disabled = false;
            });
        });
        const boardBtn = el('button', 'dlg-btn', '讨论看板');
        boardBtn.addEventListener('click', () => {
            state.drawer.classList.toggle('hidden');
        });
        state.discButtons = {startBtn, pauseBtn, resumeBtn, endBtn, polishBtn, boardBtn};
        discRow.append(startBtn, pauseBtn, resumeBtn, endBtn, compressBtn, polishBtn, boardBtn);
        state.discStatusEl = el('span', 'gc-disc-status');
        discRow.appendChild(state.discStatusEl);
        head.appendChild(discRow);

        // ---- 底部输入区 ----
        const composerRow = el('div', 'gc-composer');
        state.composerCtl = createTextarea({rows: 2, placeholder: '插话 / 点名 @成员 / @全体成员（当前成员说完后由主持人吸收）'});
        composerRow.appendChild(state.composerCtl.element);
        const sendBtn = el('button', 'dlg-btn primary', '发送');
        sendBtn.type = 'button';
        sendBtn.addEventListener('click', () => {
            const text = String(state.composerCtl.control.value || '').trim();
            if (!text) return;
            runtime.sendUserMessage(groupId, text).then((result) => {
                if (result.ok) state.composerCtl.control.value = '';
                else flashOf(state)(result.error, true);
            }).catch((e) => flashOf(state)((e && e.message) || String(e), true));
        });
        composerRow.appendChild(sendBtn);
        foot.appendChild(composerRow);

        state.unsub = runtime.subscribe(() => scheduleFlush(state));
        views.set(doc.id, state);
        flushNow(state);

        doc.groupChatUnmount = () => {
            if (state.unsub) state.unsub();
            state.unsub = null;
            if (state.flushTimer) {
                clearTimeout(state.flushTimer);
                state.flushTimer = null;
            }
            if (state.elapsedTimer) {
                clearInterval(state.elapsedTimer);
                state.elapsedTimer = null;
            }
            views.delete(doc.id);
            doc.groupChatRoot = null;
            doc.groupChatBody = null;
            doc.groupChatHead = null;
            doc.pane = null;
        };
        doc.groupChatRoot = pane;
        doc.groupChatBody = body;
        doc.groupChatHead = head;
    }

    function flashOf(state) {
        return (message) => {
            console.warn('[group]', message);
            if (state && state.discStatusEl) {
                state.discStatusEl.textContent = message;
            }
        };
    }

    function scheduleFlush(state) {
        if (state.flushTimer) return;
        state.flushTimer = setTimeout(() => {
            state.flushTimer = null;
            flushNow(state);
        }, FLUSH_THROTTLE_MS);
    }

    function flushNow(state) {
        if (!state.pane) return;
        const g = runtime.groupById(state.groupId);
        if (!g) return;
        renderHead(state, g);
        renderMessages(state, g);
        renderStreaming(state, g);
        renderDiscussionControls(state, g);
        renderDrawer(state, g);
    }

    function renderHead(state, g) {
        const meta = g.meta;
        if (state.lastMetaStamp !== meta.updatedAt) {
            state.lastMetaStamp = meta.updatedAt;
            state.titleEl.textContent = meta.title || '未命名群聊';
            state.chipsEl.innerHTML = '';
            state.chipsEl.appendChild(el('span', 'gc-badge', meta.mode === 'task' ? '任务' : (meta.mode === 'free' ? '自由' : '圆桌')));
            if (meta.mode !== 'free') {
                state.chipsEl.appendChild(el('span', 'gc-badge', `第 ${Math.max(1, (meta.discussion && meta.discussion.round) || 1)}/${meta.maxRounds} 轮`));
            }
            state.topicEl.textContent = meta.topic || '';
        }
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const eligible = meta.memberIds
            .map((id) => agents.find((item) => item && item.id === id))
            .filter((agent) => agent && agent.enabled && !(meta.mutedAgentIds || []).includes(agent.id));
        const current = state.memberSelect.control.value;
        const stillValid = eligible.some((agent) => agent.id === current);
        if (!stillValid) {
            state.memberSelect.control.innerHTML = '';
            for (const agent of eligible) {
                const option = document.createElement('option');
                option.value = agent.id;
                option.textContent = agent.name;
                state.memberSelect.control.appendChild(option);
            }
        }
    }

    function renderMessages(state, g) {
        const messages = g.messages || [];
        while (state.renderedCount < messages.length) {
            const msg = messages[state.renderedCount];
            const node = messageNode(msg, getAIConfig, g.meta, state);
            state.list.appendChild(node);
            state.renderedCount++;
            if (msg.kind === 'minutes') {
                node.scrollIntoView({block: 'start'});
            }
        }
    }

    function messageNode(msg, getAIConfig, meta, state) {
        if (msg.role === 'system') {
            // 系统通知（成员模型失效 / 无可用成员等）：不进成员上下文，微信式居中灰条
            return el('div', 'gc-msg-system', String(msg.content || ''));
        }
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const isMinutes = msg.kind === 'minutes';
        const wrap = el('div', 'gc-msg' +
            (msg.role === 'user' ? ' gc-msg-user' : '') +
            (isMinutes ? ' gc-msg-minutes' : '') +
            (msg.status && msg.status !== 'done' ? ' gc-msg-' + msg.status : ''));
        const headRow = el('div', 'gc-msg-head');
        if (msg.role === 'user') {
            headRow.appendChild(el('span', 'gc-msg-name gc-msg-name-user', '用户'));
        } else {
            const agent = agents.find((item) => item && item.id === msg.agentId);
            const dot = el('span', 'gc-dot');
            dot.style.backgroundColor = msg.agentColor ? (AGENT_COLOR_HEX[msg.agentColor] || '#989898') : (AGENT_COLOR_HEX[agent && agent.color] || '#989898');
            headRow.appendChild(dot);
            headRow.appendChild(el('span', 'gc-msg-name', isMinutes ? '纪要' : (msg.chair ? '主持人' : agentNameOf(agents, msg.agentId))));
            if (!isMinutes && msg.model && !msg.chair) headRow.appendChild(el('span', 'gc-badge', msg.model));
            if (!isMinutes && meta && meta.roles && meta.roles[msg.agentId]) {
                headRow.appendChild(el('span', 'gc-badge gc-badge-role', '角色：' + meta.roles[msg.agentId]));
            }
            if (msg.chair && !isMinutes) headRow.appendChild(el('span', 'gc-badge gc-badge-chair', '主持人'));
            if (msg.timeout) headRow.appendChild(el('span', 'gc-badge gc-level-red', '超时未发言'));
            else if (msg.status === 'error') headRow.appendChild(el('span', 'gc-badge gc-level-red', '失败'));
            else if (msg.status === 'stopped') headRow.appendChild(el('span', 'gc-badge', '已停止'));
            else if (msg.status === 'interrupted') headRow.appendChild(el('span', 'gc-badge', '中断'));
        }
        if (msg.round) headRow.appendChild(el('span', 'gc-badge', `第 ${msg.round} 轮`));
        if (msg.timing && msg.timing.ttftMs) headRow.appendChild(el('span', 'gc-badge', `首字 ${(msg.timing.ttftMs / 1000).toFixed(1)}s`));
        headRow.appendChild(el('span', 'gc-msg-time', new Date(msg.ts || 0).toLocaleTimeString()));
        wrap.appendChild(headRow);

        const contentEl = el('div', 'gc-msg-content');
        if (renderMarkdown) {
            contentEl.innerHTML = renderMarkdown(String(msg.content || ''));
            if (enhanceAnswerBody) enhanceAnswerBody(contentEl);
        } else {
            contentEl.textContent = String(msg.content || '');
        }
        wrap.appendChild(contentEl);
        // 立场卡（§3.5）：结构化 stance，不显示 JSON 原文
        if (msg.groupBlock && (msg.groupBlock.stance || msg.groupBlock.keyPoints.length || msg.groupBlock.concerns.length || msg.groupBlock.questions.length)) {
            wrap.appendChild(stanceCard(msg.groupBlock));
        }
        if (msg.error) {
            wrap.appendChild(el('div', 'gc-msg-error', '错误：' + msg.error));
        }
        // 纪要卡操作（§3.8 / G4）：复制 / 导出 Markdown / 带回当前会话
        if (isMinutes && meta && meta.minutes) {
            const actions = el('div', 'gc-minutes-actions');
            const copyBtn = el('button', 'dlg-btn', '复制');
            copyBtn.type = 'button';
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(meta.minutes.text || '').then(() => flashOf(state)('纪要已复制')).catch(() => flashOf(state)('复制失败'));
            });
            const exportBtn = el('button', 'dlg-btn', '导出 Markdown');
            exportBtn.type = 'button';
            exportBtn.addEventListener('click', () => {
                runtime.exportMinutes(state.groupId).then((result) => {
                    if (!result.ok && !result.canceled) flashOf(state)(result.error);
                }).catch((e) => flashOf(state)((e && e.message) || String(e)));
            });
            const backBtn = el('button', 'dlg-btn', '带回当前会话');
            backBtn.type = 'button';
            backBtn.dataset.tip = '把纪要投递到当前打开的 AI 会话（出现投递卡）';
            backBtn.addEventListener('click', () => {
                runtime.bringMinutesBack(state.groupId).then((result) => {
                    if (!result.ok) flashOf(state)(result.error);
                }).catch((e) => flashOf(state)((e && e.message) || String(e)));
            });
            actions.append(copyBtn, exportBtn, backBtn);
            wrap.appendChild(actions);
        }
        return wrap;
    }

    function stanceCard(block) {
        const card = el('div', 'gc-stance');
        if (block.stance) card.appendChild(el('span', 'gc-badge gc-badge-stance-' + block.stance, '立场：' + (STANCE_LABELS[block.stance] || block.stance)));
        for (const point of block.keyPoints) card.appendChild(el('span', 'gc-badge', '要点：' + point));
        for (const concern of block.concerns) card.appendChild(el('span', 'gc-badge gc-badge-concern', '担忧：' + concern));
        for (const question of block.questions) card.appendChild(el('span', 'gc-badge gc-badge-question', '疑问：' + question));
        return card;
    }

    function renderStreaming(state, g) {
        const stream = runtime.activeStreamOf(state.groupId);
        if (!stream) {
            if (state.streamingRow) {
                state.streamingRow.remove();
                state.streamingRow = null;
                state.streamingKey = '';
                if (state.elapsedTimer) {
                    clearInterval(state.elapsedTimer);
                    state.elapsedTimer = null;
                }
            }
            return;
        }
        if (!state.streamingRow || state.streamingKey !== stream.roundId) {
            if (state.streamingRow) state.streamingRow.remove();
            state.streamingKey = stream.roundId;
            const row = el('div', 'gc-msg gc-msg-streaming');
            const headRow = el('div', 'gc-msg-head');
            const dot = el('span', 'gc-dot');
            dot.style.backgroundColor = AGENT_COLOR_HEX[stream.agentColor] || '#989898';
            headRow.appendChild(dot);
            headRow.appendChild(el('span', 'gc-msg-name', stream.agentName));
            state.streamNoteEl = el('span', 'gc-badge', stream.statusNote || '正在思考…');
            headRow.appendChild(state.streamNoteEl);
            state.elapsedEl = el('span', 'gc-msg-time', '0s');
            headRow.appendChild(state.elapsedEl);
            row.appendChild(headRow);
            state.streamingContentEl = el('div', 'gc-msg-content gc-streaming-text');
            row.appendChild(state.streamingContentEl);
            state.list.appendChild(row);
            state.streamingRow = row;
            if (state.elapsedTimer) clearInterval(state.elapsedTimer);
            state.elapsedTimer = setInterval(() => {
                if (!state.elapsedEl || !stream) return;
                state.elapsedEl.textContent = Math.round((Date.now() - stream.startedAt) / 1000) + 's';
            }, 1000);
        }
        state.streamingContentEl.textContent = stream.content || (stream.thinking ? '…' : '');
        state.streamNoteEl.textContent = stream.statusNote || (stream.thinking && !stream.content ? '思考中…' : '正在输入…');
    }

    // 讨论控制按钮的可见性随状态切换（§3.9 暂停/继续/结束）；自由模式没有讨论循环，
    // 只留压缩（共享对话仍会膨胀），发消息即唤醒成员
    function renderDiscussionControls(state, g) {
        const free = g.meta.mode === 'free';
        const disc = runtime.discussionSnapshot(state.groupId);
        const phase = free ? 'free' : disc ? disc.phase + (disc.running ? ':run' : '') + (disc.paused ? ':paused' : '') : 'none';
        if (state.lastDiscPhase === phase) return;
        state.lastDiscPhase = phase;
        const {startBtn, pauseBtn, resumeBtn, endBtn, polishBtn, boardBtn} = state.discButtons;
        const running = !!(disc && disc.running);
        const paused = !!(disc && disc.paused);
        startBtn.classList.toggle('hidden', free || running || paused);
        if (!free) startBtn.textContent = (g.meta.discussion && g.meta.discussion.round > 0) && !g.meta.minutes ? '继续讨论' : '开始讨论';
        pauseBtn.classList.toggle('hidden', free || !running);
        resumeBtn.classList.toggle('hidden', free || !paused);
        endBtn.classList.toggle('hidden', free || (!running && !paused));
        polishBtn.classList.toggle('hidden', free || !g.meta.minutes);
        boardBtn.classList.toggle('hidden', free);
        if (state.discStatusEl) {
            if (free) {
                state.discStatusEl.textContent = '自由聊天 · 发消息即回，@点名谁谁回，@全体成员人人回';
            } else {
                const spoken = disc ? `${disc.speeches} 次发言` : '';
                state.discStatusEl.textContent = running
                    ? `讨论中 · ${spoken}`
                    : paused
                        ? '已暂停 · ' + (disc.error || '点「继续」接着讨论')
                        : (g.meta.minutes ? '本场已产出纪要' : '');
            }
        }
    }

    // 讨论看板抽屉（§3.2）：议程 / 立场 / 共识 / 分歧 / 未决 / 决定 / 行动项 / 点名请求
    function renderDrawer(state, g) {
        if (state.drawer.classList.contains('hidden')) return;
        const d = g.meta.discussion;
        if (!d) return;
        state.drawerInner.innerHTML = '';
        state.drawerInner.appendChild(el('div', 'gc-drawer-title', '讨论看板'));
        const section = (title, items, renderer) => {
            if (!items || !items.length) return;
            state.drawerInner.appendChild(el('div', 'gc-drawer-sec-title', title));
            const box = el('div', 'gc-drawer-sec');
            for (const item of items) box.appendChild(renderer(item));
            state.drawerInner.appendChild(box);
        };
        if (d.agenda.length) section('议程', d.agenda, (item) => el('div', 'gc-drawer-item', item));
        section('成员立场', d.positions.filter((p) => p && p.stance), (pos) => {
            const row = el('div', 'gc-drawer-item');
            row.appendChild(el('span', 'gc-badge gc-badge-stance-' + pos.stance, `${pos.name || pos.agentId}：${STANCE_LABELS[pos.stance] || pos.stance}`));
            for (const point of pos.keyPoints || []) row.appendChild(el('div', 'gc-drawer-sub', '· ' + point));
            for (const concern of pos.concerns || []) row.appendChild(el('div', 'gc-drawer-sub', '· 担忧：' + concern));
            return row;
        });
        section('共识', d.agreements, (item) => el('div', 'gc-drawer-item', item));
        section('分歧', d.disagreements, (item) => {
            const row = el('div', 'gc-drawer-item');
            row.textContent = `${item.point}（${(item.sides || []).join(' vs ')}）${item.resolution ? ' → ' + item.resolution : ''}`;
            return row;
        });
        section('未决问题', d.openQuestions, (item) => el('div', 'gc-drawer-item', item));
        section('决定', d.decisions, (item) => el('div', 'gc-drawer-item', item));
        // 任务板（§1.2 任务模式可增改；圆桌模式只读展示）
        if (d.actionItems.length || g.meta.mode === 'task') {
            state.drawerInner.appendChild(el('div', 'gc-drawer-sec-title', '任务板'));
            const taskBox = el('div', 'gc-drawer-sec');
            const statusOrder = ['todo', 'doing', 'done', 'blocked'];
            const statusLabel = {todo: '待办', doing: '进行中', done: '完成', blocked: '阻塞'};
            for (const item of d.actionItems) {
                const row = el('div', 'gc-drawer-item');
                row.appendChild(el('span', 'gc-drawer-task-title', `${item.title}（${item.ownerId || '待定'}）`));
                const cycleBtn = el('button', 'dlg-btn gc-task-cycle', statusLabel[item.status] || item.status);
                cycleBtn.type = 'button';
                cycleBtn.dataset.tip = '切换状态：待办 → 进行中 → 完成 → 阻塞';
                cycleBtn.addEventListener('click', () => {
                    const next = statusOrder[(statusOrder.indexOf(item.status) + 1) % statusOrder.length];
                    runtime.updateActionItem(state.groupId, item.id, {status: next}).catch((e) => flashOf(state)((e && e.message) || String(e)));
                });
                row.appendChild(cycleBtn);
                taskBox.appendChild(row);
            }
            if (g.meta.mode === 'task') {
                const addRow = el('div', 'gc-drawer-item gc-task-add');
                const titleInput = createInput({placeholder: '新任务（回车添加）'});
                titleInput.control.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && titleInput.control.value.trim()) {
                        runtime.addActionItem(state.groupId, titleInput.control.value.trim()).then((result) => {
                            if (result.ok) titleInput.control.value = '';
                            else flashOf(state)(result.error);
                        }).catch((err) => flashOf(state)((err && err.message) || String(err)));
                    }
                });
                addRow.appendChild(titleInput.element);
                taskBox.appendChild(addRow);
            }
            state.drawerInner.appendChild(taskBox);
        }
        section('请求发言', (d.floorRequests || []).slice(-6), (req) => {
            const row = el('div', 'gc-drawer-item');
            row.textContent = `${req.fromName || req.from} → ${req.to}${req.reason ? '：' + req.reason : ''}`;
            return row;
        });
        if (d.lastRoundSummary) section('上一轮小结', [d.lastRoundSummary], (item) => el('div', 'gc-drawer-item', item));
        if (!state.drawerInner.children.length) {
            state.drawerInner.appendChild(el('div', 'gc-drawer-item', '看板还是空的：开始讨论后由主持人开场与成员立场自动填充。'));
        }
    }

    function agentNameOf(agents, agentId) {
        const agent = (agents || []).find((item) => item && item.id === agentId);
        return agent ? agent.name : '已删除成员';
    }

    return {createGroupChatView};
}
