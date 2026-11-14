// message-center.js：状态栏消息中心（【消息】入口 + 浮层面板 + 持久化消息队列）。
// 消息来源：AI 的 notify_send 工具、任务完成通知（原 in-app toast 集成为消息形态）、
// 版本更新等系统事件。右下角 toast 只是消息的「可选弹出形态」——弹完消失后消息仍在列表里
// （localStorage 持久化，上限 100 条，超出淘汰最旧）。
// ctx: {
//   focusSession(sessionId)  toast 点击跳转到对应 AI 会话（main.js 传懒箭头）
// }
export function createMessageCenter(ctx) {
    const KEY = 'datalens-message-center';
    const MAX_MESSAGES = 100;
    const KIND_ICONS = {
        success: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        error: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 6l4 4M10 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
        update: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M13.3 1.7v3h-3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
        ai: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4a3.7 3.7 0 0 0-3.7 3.7v2.5L3 11.4h10l-1.3-2.8V6.1A3.7 3.7 0 0 0 8 2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.6 13.2a1.4 1.4 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.2v3.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="5.4" r=".8" fill="currentColor"/></svg>',
    };
    let messages = load();
    let seq = 0;
    let pop = null;
    let dismissHandler = null;

    function load() {
        try {
            const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
            return Array.isArray(raw) ? raw.slice(0, MAX_MESSAGES) : [];
        } catch (e) {
            return [];
        }
    }

    function persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify(messages.slice(0, MAX_MESSAGES)));
        } catch (e) {
            // localStorage 不可用（如隐私模式）：降级为内存态，不影响本会话使用
        }
    }

    function btnEl() {
        return document.getElementById('btn-messages');
    }

    function badgeEl() {
        return document.getElementById('msg-badge');
    }

    function unreadCount() {
        return messages.filter((m) => !m.read).length;
    }

    function refreshBadge() {
        const badge = badgeEl();
        const btn = btnEl();
        const count = unreadCount();
        if (badge && btn) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.classList.toggle('hidden', !count);
            btn.title = count ? '消息中心（' + count + ' 条未读）' : '消息中心';
        }
        if (pop && pop.isConnected) renderPanel(pop);
    }

    // 新增消息：msg = {kind: 'ai'|'success'|'error'|'update'|'info', title, body, sessionId?}；
    // opts.toast = true 时右下角弹出提示框（弹完消息仍在列表）。
    function add(msg, opts) {
        const item = {
            id: 'm' + Date.now() + '-' + (++seq),
            ts: Date.now(),
            kind: KIND_ICONS[msg && msg.kind] ? msg.kind : 'info',
            title: String((msg && msg.title) || '').slice(0, 120) || '消息',
            body: String((msg && msg.body) || '').slice(0, 2000),
            sessionId: String((msg && msg.sessionId) || ''),
            read: false,
        };
        messages.unshift(item);
        if (messages.length > MAX_MESSAGES) messages.length = MAX_MESSAGES;
        persist();
        refreshBadge();
        if (opts && opts.toast) showToast(item);
        return item.id;
    }

    function markAllRead() {
        for (const m of messages) m.read = true;
        persist();
        refreshBadge();
    }

    function clearAll() {
        messages = [];
        persist();
        refreshBadge();
    }

    function relativeTime(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // 右下角弹出提示：复用 #app-toasts 与 .app-toast 样式（与原任务完成 toast 同形态）
    function showToast(item) {
        const host = document.getElementById('app-toasts');
        if (!host) return;
        const toast = document.createElement('div');
        toast.className = 'app-toast ' + (item.kind === 'error' ? 'error' : (item.kind === 'success' ? 'success' : 'info'));
        const icon = document.createElement('span');
        icon.className = 'app-toast-icon';
        icon.innerHTML = KIND_ICONS[item.kind] || KIND_ICONS.info;
        const main = document.createElement('div');
        main.className = 'app-toast-main';
        const title = document.createElement('div');
        title.className = 'app-toast-title';
        title.textContent = item.title;
        const body = document.createElement('div');
        body.className = 'app-toast-body';
        body.textContent = item.body;
        main.append(title, body);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'app-toast-close';
        close.title = '关闭提示';
        close.textContent = '×';
        toast.append(icon, main, close);
        let timer = 0;
        const dismiss = () => {
            if (timer) clearTimeout(timer);
            timer = 0;
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 180);
        };
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss();
        });
        toast.addEventListener('click', () => {
            if (item.sessionId && typeof ctx.focusSession === 'function') ctx.focusSession(item.sessionId);
            dismiss();
        });
        host.appendChild(toast);
        while (host.children.length > 3) host.firstElementChild.remove();
        requestAnimationFrame(() => toast.classList.add('show'));
        timer = setTimeout(dismiss, 9000);
    }

    // 浮层面板：未读在上（其余按时间倒序），行点击标记已读；「清空全部」清队列
    function renderPanel(host) {
        host.textContent = '';
        const head = document.createElement('div');
        head.className = 'msg-center-head';
        const title = document.createElement('span');
        title.className = 'msg-center-title';
        title.textContent = '消息';
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'msg-center-clear';
        clear.textContent = '清空全部';
        clear.addEventListener('click', () => {
            clearAll();
            renderPanel(host);
        });
        head.append(title, clear);
        host.appendChild(head);
        if (!messages.length) {
            const empty = document.createElement('div');
            empty.className = 'msg-center-empty';
            empty.textContent = '暂无消息';
            host.appendChild(empty);
            return;
        }
        const ordered = messages.slice().sort((a, b) => ((a.read === true) - (b.read === true)) || (b.ts - a.ts));
        for (const item of ordered) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'msg-center-row' + (item.read ? '' : ' unread');
            const icon = document.createElement('span');
            icon.className = 'msg-center-ico';
            icon.innerHTML = KIND_ICONS[item.kind] || KIND_ICONS.info;
            const main = document.createElement('span');
            main.className = 'msg-center-main';
            const line1 = document.createElement('span');
            line1.className = 'msg-center-line1';
            const name = document.createElement('span');
            name.className = 'msg-center-row-title';
            name.textContent = item.title;
            const time = document.createElement('span');
            time.className = 'msg-center-time';
            time.textContent = relativeTime(item.ts);
            line1.append(name, time);
            const body = document.createElement('span');
            body.className = 'msg-center-body';
            body.textContent = item.body;
            main.append(line1, body);
            row.append(icon, main);
            row.title = item.body;
            row.addEventListener('click', () => {
                if (!item.read) {
                    item.read = true;
                    persist();
                    refreshBadge();
                }
                if (item.sessionId && typeof ctx.focusSession === 'function') ctx.focusSession(item.sessionId);
                closePanel();
            });
            host.appendChild(row);
        }
    }

    function closePanel() {
        if (!pop) return;
        pop.remove();
        pop = null;
        if (dismissHandler) {
            document.removeEventListener('pointerdown', dismissHandler, true);
            document.removeEventListener('keydown', dismissHandler, true);
            dismissHandler = null;
        }
    }

    function togglePanel(anchor) {
        if (pop) {
            closePanel();
            return;
        }
        const panel = document.createElement('div');
        panel.className = 'msg-center-pop';
        document.body.appendChild(panel);
        renderPanel(panel);
        const rect = anchor.getBoundingClientRect();
        const place = () => {
            panel.style.left = Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8)) + 'px';
            panel.style.top = Math.max(8, Math.min(rect.top - panel.offsetHeight - 8, window.innerHeight - panel.offsetHeight - 8)) + 'px';
        };
        place();
        pop = panel;
        // 打开即视为已读：未读角标清零
        markAllRead();
        dismissHandler = (e) => {
            if (e.key === 'Escape' || (e.type === 'pointerdown' && !panel.contains(e.target) && !anchor.contains(e.target))) {
                closePanel();
            }
        };
        document.addEventListener('pointerdown', dismissHandler, true);
        document.addEventListener('keydown', dismissHandler, true);
    }

    function init() {
        const btn = btnEl();
        if (!btn) return;
        btn.addEventListener('click', () => togglePanel(btn));
        refreshBadge();
    }

    init();
    return {add, clearAll, refreshBadge, togglePanel};
}
