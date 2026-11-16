// ai-group-view.js：群聊标签页视图——头部（群名/徽标/点将）、消息区（增量渲染）、
// 流式行（80ms 节流 + 纯文本流、完成转 Markdown）、输入区（插话 / 停止）。
// 手动「请发言」是用户主持的雏形，G3 主持人循环正式接管调度。
// 状态来自 runtime（subscribe 快照 + activeStreamOf）；DOM 只做渲染，不做业务判定。
import {createInput, createSelect, createTextarea} from '../core/form-controls.js';
import {AGENT_COLOR_HEX} from './ai-agent-model.js';

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
    // docId → 视图状态（doc 关闭时清理）
    const views = new Map();

    function colorOf(agent) {
        return AGENT_COLOR_HEX[agent && agent.color] || '#989898';
    }

    function agentNameOf(agents, agentId) {
        const agent = (agents || []).find((item) => item && item.id === agentId);
        return agent ? agent.name : '已删除成员';
    }

    function createGroupChatView(doc, host) {
        if (doc.pane) return;
        const groupId = doc.groupChat;
        const pane = el('div', 'jsoneditor-pane active groupchat-pane');
        host.appendChild(pane);
        doc.pane = pane;

        const head = el('div', 'gc-head');
        const body = el('div', 'gc-body');
        const foot = el('div', 'gc-foot');
        pane.append(head, body, foot);

        const state = {
            doc,
            groupId,
            pane,
            head,
            body,
            list: el('div', 'gc-messages'),
            streamingRow: null,
            streamingKey: '',
            streamingContentEl: null,
            streamingNoteEl: null,
            elapsedTimer: null,
            renderedCount: 0,
            lastMetaStamp: 0,
            flushTimer: null,
            memberSelect: null,
            focusInput: null,
            composerCtl: null,
            unsub: null,
        };
        body.appendChild(state.list);

        // ---- 头部：标题行（G1 壳延续） + 点将行 ----
        const titleRow = el('div', 'gc-head-row');
        const title = el('div', 'gc-head-title', doc.name);
        titleRow.appendChild(title);
        state.titleEl = title;
        state.chipsEl = el('div', 'gc-head-chips');
        titleRow.appendChild(state.chipsEl);
        head.appendChild(titleRow);
        state.topicEl = el('div', 'gc-head-topic');
        head.appendChild(state.topicEl);

        const controlRow = el('div', 'gc-controls');
        state.memberSelect = createSelect({options: [{value: '', label: '选择发言成员'}]});
        state.memberSelect.element.classList.add('gc-member-select');
        controlRow.appendChild(state.memberSelect.element);
        state.focusInput = createInput({placeholder: '焦点（可选）：要求回应谁 / 解决什么'});
        controlRow.appendChild(state.focusInput.element);
        const speakBtn = el('button', 'dlg-btn primary', '请发言');
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
        const stopBtn = el('button', 'dlg-btn', '停止本场');
        stopBtn.type = 'button';
        stopBtn.dataset.tip = '停止当前发言（讨论继续，可再请）';
        stopBtn.addEventListener('click', () => runtime.stopAll(groupId));
        controlRow.appendChild(stopBtn);
        head.appendChild(controlRow);

        // ---- 底部输入区 ----
        const composerRow = el('div', 'gc-composer');
        state.composerCtl = createTextarea({rows: 2, placeholder: '插话 / 补充议题（当前成员说完后由主持人吸收）'});
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
        return (message, isError) => {
            // 视图内轻提示：复用面板 flash 的语义但落到群聊状态条；这里直接 console + 标题闪示
            console.warn('[group]', message);
            if (state && state.streamNoteEl) {
                state.streamNoteEl.textContent = message;
            }
            void isError;
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
    }

    function renderHead(state, g) {
        const meta = g.meta;
        if (state.lastMetaStamp !== meta.updatedAt) {
            state.lastMetaStamp = meta.updatedAt;
            state.titleEl.textContent = meta.title || '未命名群聊';
            state.chipsEl.innerHTML = '';
            const modeChip = el('span', 'gc-badge', meta.mode === 'task' ? '任务' : '圆桌');
            state.chipsEl.appendChild(modeChip);
            state.chipsEl.appendChild(el('span', 'gc-badge', `第 ${Math.max(1, (meta.discussion && meta.discussion.round) || 1)} 轮`));
            state.topicEl.textContent = meta.topic || '';
        }
        // 成员下拉：启用且未静音的成员；选中项失效时回第一个
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
            state.list.appendChild(messageNode(msg, getAIConfig));
            state.renderedCount++;
        }
    }

    function messageNode(msg, getAIConfig) {
        const config = getAIConfig();
        const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
        const wrap = el('div', 'gc-msg' + (msg.role === 'user' ? ' gc-msg-user' : '') +
            (msg.status && msg.status !== 'done' ? ' gc-msg-' + msg.status : ''));
        const headRow = el('div', 'gc-msg-head');
        if (msg.role === 'user') {
            headRow.appendChild(el('span', 'gc-msg-name gc-msg-name-user', '用户'));
        } else {
            const agent = agents.find((item) => item && item.id === msg.agentId);
            const dot = el('span', 'gc-dot');
            dot.style.backgroundColor = msg.agentColor ? (AGENT_COLOR_HEX[msg.agentColor] || '#989898') : colorOf(agent);
            headRow.appendChild(dot);
            headRow.appendChild(el('span', 'gc-msg-name', agentNameOf(agents, msg.agentId)));
            if (msg.model) headRow.appendChild(el('span', 'gc-badge', msg.model));
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
        if (msg.error) {
            wrap.appendChild(el('div', 'gc-msg-error', '错误：' + msg.error));
        }
        return wrap;
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
        // 流式期间用纯文本（不整屏重建 Markdown），完成后落盘消息按 Markdown 渲染
        state.streamingContentEl.textContent = stream.content || (stream.thinking ? '…' : '');
        state.streamNoteEl.textContent = stream.statusNote || (stream.thinking && !stream.content ? '思考中…' : '正在输入…');
    }

    return {createGroupChatView};
}
