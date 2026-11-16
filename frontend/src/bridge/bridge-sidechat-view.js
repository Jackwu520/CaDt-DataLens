// bridge-sidechat-view.js：支线对话在内容区的标签页（对齐子代理详情 / 后台终端的先例）。
// 本模块负责「建标签页 + 外壳 + 输入行 + 胶囊 + 三态」；正文渲染归 AI 面板
// （ai-panel 的 bridgeRenderSideChat，复用面板渲染函数，面板单例 UI 在外渲染时跳过）。
//
// 与子代理详情的差别：这里承载的是一条**完整会话**（持久化、可收发、有全部工具），
// 所以标签页上限取得更小；形态仍是虚拟文档（doc.sideChat = sessionId）。
//
// 不变量（见 docs/unfinished-plans/side-chat-tab.md §3）：支线只与它的母会话同时在场。
// 面板切走母会话时标签页进入「失联」——不销毁、消息只读、给一个回位按钮；正在跑的
// 流式允许跑完。
import {createTextarea} from '../core/form-controls.js';
import {iconSvg} from '../core/icons.js';

export function createBridgeSideChat(deps) {
    // 支线比子代理视图重（完整会话、可能正在跑流式），上限取 3 而不是 8
    const MAX_TABS = 3;
    const POLL_MS = 400;

    function api() {
        return deps.aiPanel || null;
    }

    function tabName(title) {
        const line = String(title || '支线对话').replace(/\s+/g, ' ').trim() || '支线对话';
        return line.length > 20 ? line.slice(0, 20) + '…' : line;
    }

    function snapLabel(at) {
        const ms = Number(at) || 0;
        if (!ms) return '';
        const d = new Date(ms);
        if (!Number.isFinite(d.getTime())) return '';
        const pad = (n) => (n < 10 ? '0' : '') + n;
        return '自 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' 的快照';
    }

    function openSideChatTab(spec) {
        const sessionId = String((spec && spec.sessionId) || '');
        if (!sessionId) return null;
        const existing = deps.docs.find((d) => d.sideChat === sessionId);
        if (existing) {
            deps.activateDoc(existing);
            return existing;
        }
        const opened = deps.docs.filter((d) => d.sideChat);
        while (opened.length >= MAX_TABS) {
            const oldest = opened.shift();
            if (oldest) deps.closeDocNow(oldest, false);
        }
        const doc = {
            id: 'sidechat-' + sessionId,
            path: null,
            name: tabName(spec && spec.title),
            content: '',
            size: 0,
            eol: 'lf',
            hasBom: false,
            large: false,
            enc: 'utf-8',
            format: {id: 'sidechat', name: '支线对话', extensions: [], aceMode: 'text', rawOnly: true},
            sideChat: sessionId,
            sideChatMeta: {
                ownerTitle: String((spec && spec.ownerTitle) || ''),
                snapAt: Number((spec && spec.snapAt) || 0),
            },
            mode: 'sidechat',
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

    function createSideChatView(doc) {
        const pane = document.createElement('div');
        pane.className = 'jsoneditor-pane active sidechat-pane';
        deps.els.editor.appendChild(pane);
        const root = document.createElement('div');
        root.className = 'sidechat-root';
        pane.appendChild(root);

        // ---- 标题条 ----
        const head = document.createElement('div');
        head.className = 'sidechat-head';
        const title = document.createElement('span');
        title.className = 'sidechat-title';
        title.textContent = doc.name || '支线对话';
        const meta = doc.sideChatMeta || {};
        const note = document.createElement('span');
        note.className = 'sidechat-note';
        const snap = snapLabel(meta.snapAt);
        note.textContent = (meta.ownerTitle ? '主对话「' + meta.ownerTitle + '」' : '') +
            (meta.ownerTitle && snap ? ' · ' : '') + snap;
        head.append(title, note);

        // ---- 胶囊条（三枚：智能体团队 / 后台终端 / 计时器；点开回到面板的对应弹层） ----
        const capsules = document.createElement('div');
        capsules.className = 'sidechat-capsules';
        const chipDefs = [
            {kind: 'agents', icon: 'agents', label: '智能体团队'},
            {kind: 'terms', icon: 'terminal', label: '后台终端'},
            {kind: 'timers', icon: 'clock', label: '计时器'},
        ];
        const chips = new Map();
        for (const def of chipDefs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sidechat-chip';
            btn.innerHTML = iconSvg(def.icon, 12);
            const badge = document.createElement('span');
            badge.className = 'sidechat-chip-badge';
            btn.appendChild(badge);
            btn.addEventListener('click', () => {
                const panel = api();
                if (panel && typeof panel.bridgeSideChatChip === 'function') panel.bridgeSideChatChip(def.kind);
            });
            capsules.appendChild(btn);
            chips.set(def.kind, {btn, badge});
        }

        // ---- 三态横幅（在位时不显示） ----
        const banner = document.createElement('div');
        banner.className = 'sidechat-banner hidden';
        const bannerText = document.createElement('span');
        bannerText.className = 'sidechat-banner-text';
        const bannerBtn = document.createElement('button');
        bannerBtn.type = 'button';
        bannerBtn.className = 'sidechat-banner-btn';
        banner.append(bannerText, bannerBtn);

        // ---- 消息区（渲染目标） ----
        const body = document.createElement('div');
        body.className = 'sidechat-body ai-messages';
        // 标签页里的审批 / 提问接管区：支线要「工具完整」，写文件审批必须能在这里点
        const takeover = document.createElement('div');
        takeover.className = 'sidechat-takeover hidden';

        // 消息区的点击走面板的代理（只放行审批 / 环境变量 / 用量徽标，避免误改母会话）
        body.addEventListener('click', (e) => {
            const panel = api();
            if (panel && typeof panel.bridgeSideChatClick === 'function') {
                panel.bridgeSideChatClick(e, doc.sideChat);
            }
        });

        // ---- 输入行 ----
        const composer = document.createElement('div');
        composer.className = 'sidechat-composer';
        const input = createTextarea({className: 'sidechat-input', rows: 1, spellcheck: false}).control;
        input.placeholder = '在支线里继续问…（Enter 发送，Shift+Enter 换行）';
        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'sidechat-send';
        sendBtn.textContent = '发送';
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'sidechat-stop hidden';
        stopBtn.textContent = '停止';
        const hint = document.createElement('span');
        hint.className = 'sidechat-hint';
        composer.append(input, sendBtn, stopBtn, hint);

        root.append(head, capsules, banner, body, takeover, composer);
        doc.pane = pane;
        doc.sideChatRoot = root;
        doc.sideChatBody = body;
        doc.sideChatView = {banner, bannerText, bannerBtn, chips, input, sendBtn, stopBtn, hint};

        // ---- 渲染与状态 ----
        let pollTimer = 0;
        let disposed = false;

        function state() {
            const panel = api();
            if (!panel || typeof panel.bridgeSideChatState !== 'function') return {ok: false, reason: 'no_panel'};
            return panel.bridgeSideChatState(doc.sideChat) || {ok: false, reason: 'unknown'};
        }

        function paintChips(st) {
            const panel = api();
            const counts = panel && typeof panel.bridgeSideChatChips === 'function'
                ? panel.bridgeSideChatChips(doc.sideChat)
                : null;
            if (!counts) return;
            for (const [kind, node] of chips) {
                const n = Number(counts[kind]) || 0;
                node.badge.textContent = n > 0 ? String(n) : '';
                node.btn.classList.toggle('active', n > 0);
                node.btn.disabled = false;
            }
        }

        function paintState(st) {
            const lost = st.ok && !st.inPlace;
            banner.classList.toggle('hidden', !lost);
            input.disabled = !st.ok || lost;
            sendBtn.disabled = !st.ok || lost || st.streaming;
            stopBtn.classList.toggle('hidden', !st.streaming);
            hint.textContent = !st.ok ? '对话不可用'
                : st.streaming ? '生成中…'
                    : lost ? '' : '';
            if (lost) {
                if (st.ownerGone) {
                    bannerText.textContent = '主对话已删除，这条支线失去了归属';
                    bannerBtn.textContent = '转为独立会话';
                    bannerBtn.onclick = () => {
                        // 与「提升为独立会话」同一个动作：清 sideOf，之后就是普通会话
                        const panel = api();
                        if (panel && typeof panel.bridgeSideChatPromote === 'function') {
                            panel.bridgeSideChatPromote(doc.sideChat);
                        }
                        refresh();
                    };
                    bannerBtn.classList.remove('hidden');
                } else {
                    bannerText.textContent = '主对话已不在前台（当前查看「' + (st.title || '') + '」之外）';
                    bannerBtn.textContent = '回到「' + (st.ownerTitle || '主对话') + '」';
                    bannerBtn.onclick = () => {
                        const panel = api();
                        if (panel && typeof panel.bridgeSideChatReturnToOwner === 'function') {
                            panel.bridgeSideChatReturnToOwner(doc.sideChat);
                        }
                    };
                    bannerBtn.classList.remove('hidden');
                }
            }
        }

        function render() {
            const panel = api();
            if (disposed || !panel || typeof panel.bridgeRenderSideChat !== 'function') {
                body.textContent = '支线对话视图不可用：AI 面板尚未就绪。';
                body.classList.add('empty');
                return;
            }
            const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
            const prevTop = body.scrollTop;
            const ok = panel.bridgeRenderSideChat(body, doc.sideChat);
            if (!ok) {
                body.textContent = '这个对话已不存在（可能已被删除）';
                body.classList.add('empty');
                return;
            }
            body.classList.remove('empty');
            body.scrollTop = nearBottom ? body.scrollHeight : prevTop;
        }

        function refresh() {
            if (disposed) return;
            const st = state();
            paintState(st);
            paintChips(st);
            render();
            const panelMod = api();
            if (panelMod && typeof panelMod.bridgeSideChatTakeover === 'function') {
                panelMod.bridgeSideChatTakeover(takeover, doc.sideChat);
            }
            // 流式中靠轮询推进：增量渲染路径都指向面板，标签页这边整段重绘最省事
            if (st.ok && st.streaming) startPolling();
            else stopPolling();
        }

        function startPolling() {
            if (pollTimer || disposed) return;
            pollTimer = setInterval(() => {
                if (disposed) return stopPolling();
                const st = state();
                if (!st.ok || !st.streaming) {
                    stopPolling();
                    refresh();
                    return;
                }
                render();
            }, POLL_MS);
        }

        function stopPolling() {
            if (!pollTimer) return;
            clearInterval(pollTimer);
            pollTimer = 0;
        }

        async function submit() {
            const st = state();
            if (!st.ok || !st.inPlace) return;
            const text = String(input.value || '').trim();
            if (!text) return;
            const panel = api();
            if (!panel || typeof panel.bridgeSideChatSend !== 'function') return;
            input.value = '';
            sendBtn.disabled = true;
            const result = await panel.bridgeSideChatSend(doc.sideChat, text);
            if (!result || !result.ok) {
                input.value = text;
                sendBtn.disabled = false;
                hint.textContent = result && result.reason === 'busy' ? '上一轮还没结束' : '发送失败';
                return;
            }
            hint.textContent = '';
            refresh();
        }

        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            submit();
        });
        sendBtn.addEventListener('click', () => submit());
        stopBtn.addEventListener('click', () => {
            const panel = api();
            if (panel && typeof panel.bridgeSideChatStop === 'function') panel.bridgeSideChatStop(doc.sideChat);
            refresh();
        });

        // 面板切换会话：立即重新判定在位 / 失联
        let offSwitch = null;
        const panel = api();
        if (panel && typeof panel.bridgeOnSessionSwitch === 'function') {
            offSwitch = panel.bridgeOnSessionSwitch(() => refresh());
        }

        refresh();

        doc.sideChatUnmount = () => {
            disposed = true;
            stopPolling();
            if (offSwitch) offSwitch();
            offSwitch = null;
            doc.sideChatUnmount = null;
            doc.sideChatView = null;
        };
    }

    return {openSideChatTab, createSideChatView};
}
