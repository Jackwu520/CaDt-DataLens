// db-tab-views.js：数据库的独立虚拟标签页——数据表网格（每表一个）与 SQL 控制台（每会话一个）。
// 由原 db-tab.js 三栏布局演进（方案 §11.8）：侧栏会话树承接对象浏览后，双击表直接全宽开标签页。
// 会话经 db-sessions.js 共享：关标签页只关视图不断会话；会话失效/断开时面板给出重连入口。

import {iconSvg} from '../core/icons.js';
import {createDbQueryEditor} from './db-query-editor.js';
import {createDbTablePane} from './db-table-grid.js';
import {createDbRedisKeyPane} from './db-redis-view.js';
import {kindLabel} from './db-model.js';
import {ensureSession, getSessionState, disconnectSession, reconnectSession, subscribeSession} from './db-sessions.js';

// 会话门面通道在 build 回调内按 getSessionState 动态解析（api || deps.backend）

// 会话挂载通用壳：连接中/失败/断开三态覆盖层 + 就绪后 build(ready)
// 返回 {el, dispose}；dispose 撤订阅并拒绝后续回调（关标签页时的竞态防线）
function mountWithSession(deps, doc, build) {
    const el = document.createElement('div');
    el.className = 'db-tab-session';
    const spec = doc.dbTableSpec || doc.dbConsoleSpec || doc.dbRedisKeySpec;
    const entry = spec.entry;
    const entryId = spec.entryId;
    let disposed = false;
    let ready = false; // build 完成为 true：会话恢复（connected）时据此决定是否重建内容
    let unsub = subscribeSession(entryId, () => {
        const st = getSessionState(entryId);
        if (st && st.status === 'connected') {
            // 在别处重连成功（侧栏树/另一个标签页）：本页还停在覆盖层就跟着重建
            if (!disposed && !ready) start();
            return;
        }
        showGate(st);
    });
    let paneEl = null;

    // 会话被 Go 侧空闲回收是服务端静默行为（前端 status 仍是 connected），只有调用失败才知道。
    // 捕获方调 sessionLost()：自动重连并返回是否成功；5s 节流防「重连又失败」死循环。
    let lastLost = 0;
    function sessionLost() {
        const now = Date.now();
        if (now - lastLost < 5000) return Promise.resolve(false);
        lastLost = now;
        return reconnectSession(entry).then(() => true).catch(() => false);
    }

    // 自动重连成功后重建面板内容（build 里 init 会自动重新加载当前页）
    function sessionRecovered() {
        ready = false;
        start();
    }

    function clearGate() {
        if (paneEl) {
            paneEl.remove();
            paneEl = null;
        }
        el.textContent = '';
    }

    function showGate(st) {
        if (disposed) return;
        ready = false;
        clearGate();
        const gate = document.createElement('div');
        gate.className = 'db-tab-gate';
        const ic = document.createElement('div');
        ic.className = 'db-gate-icon';
        ic.innerHTML = iconSvg('database', 22);
        const msg = document.createElement('div');
        msg.className = 'db-gate-title';
        gate.append(ic, msg);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'db-btn primary';
        if (!st || st.status === 'closed') {
            msg.textContent = '会话未连接';
            btn.textContent = '连接';
            btn.addEventListener('click', () => start());
        } else if (st.status === 'connecting') {
            msg.textContent = '连接中…';
            btn.remove();
        } else if (st.status === 'error') {
            msg.textContent = '连接失败：' + st.error;
            btn.textContent = '重试连接';
            btn.addEventListener('click', () => start());
        } else {
            msg.textContent = '会话已断开';
            btn.textContent = '重新连接';
            btn.addEventListener('click', () => start());
        }
        if (btn.parentNode) gate.appendChild(btn);
        el.appendChild(gate);
        paneEl = gate;
    }

    async function start() {
        if (disposed) return;
        clearGate();
        const gate = document.createElement('div');
        gate.className = 'db-tab-gate';
        gate.innerHTML = '<div class="db-gate-title">连接中…</div>';
        el.appendChild(gate);
        paneEl = gate;
        try {
            const readyResult = await ensureSession(entry);
            if (disposed) return;
            clearGate();
            ready = true;
            paneEl = build(readyResult, {sessionLost, sessionRecovered}); // 就绪内容
            el.appendChild(paneEl);
        } catch (e) {
            if (disposed) return;
            showGate(getSessionState(entryId));
        }
    }

    start();

    return {
        el,
        dispose() {
            disposed = true;
            unsub();
        },
    };
}

// 数据表标签页：一个表 = 一个标签页（全宽网格）
export function createDbTableTabView(deps, doc) {
    const t = doc.dbTableSpec; // {entryId, entry, db, table, kind}
    const view = mountWithSession(deps, doc, (ready, hooks) => {
        const session = ready.info;
        const pane = createDbTablePane(
            {
                get backend() { return getSessionState(t.entryId) ? (getSessionState(t.entryId).api || deps.backend) : deps.backend; },
                flash: deps.flash,
                settings: deps.settings,
                logActivity: deps.logActivity,
                get enhanceSelect() { return deps.enhanceSelect; },
                get ctxMenu() { return deps.ctxMenu; },
                get copyText() { return deps.copyText; },
                get sessionLost() { return hooks.sessionLost; },
                get sessionRecovered() { return hooks.sessionRecovered; },
            },
            session, t.db, t.table);
        return pane.el;
    });
    // 统一卸载契约：bridge 的 doc.tabUnmount 会调 doc.dbTabUnmount（dispose 撤会话订阅）
    doc.dbTabUnmount = () => view.dispose();
    return view.el;
}

// Redis 键查看器标签页（方案 §11.13）：每个键一个；内容由 db-redis-view.js 提供
export function createDbRedisKeyTabView(deps, doc) {
    const t = doc.dbRedisKeySpec; // {entryId, entry, db, key}
    const view = mountWithSession(deps, doc, (ready, hooks) => {
        const session = ready.info;
        const pane = createDbRedisKeyPane(
            {
                get backend() { return getSessionState(t.entryId) ? (getSessionState(t.entryId).api || deps.backend) : deps.backend; },
                flash: deps.flash,
                get logActivity() { return deps.logActivity; },
                get enhanceSelect() { return deps.enhanceSelect; },
                get ctxMenu() { return deps.ctxMenu; },
                get copyText() { return deps.copyText; },
                get openConfirmDialog() { return deps.openConfirmDialog; },
                get overlayStack() { return deps.overlayStack; },
                get sessionLost() { return hooks.sessionLost; },
                get sessionRecovered() { return hooks.sessionRecovered; },
                get onKeyDeleted() { return deps.onRedisKeyDeleted; },
            },
            session, t.db, t.key);
        return pane.el;
    });
    doc.dbTabUnmount = () => view.dispose();
    return view.el;
}

// 查询控制台标签页：每个会话一个（头部显示会话信息 + 断开按钮）
export function createDbConsoleTabView(deps, doc) {
    const c = doc.dbConsoleSpec; // {entryId, entry, title}
    const root = document.createElement('div');
    root.className = 'db-console-view';
    const head = document.createElement('div');
    head.className = 'db-console-head';
    const headIc = document.createElement('span');
    headIc.innerHTML = iconSvg('terminal', 13);
    const headName = document.createElement('span');
    headName.className = 'db-console-name';
    const headMeta = document.createElement('span');
    headMeta.className = 'db-console-meta';
    const disconnectBtn = document.createElement('button');
    disconnectBtn.type = 'button';
    disconnectBtn.className = 'db-btn';
    disconnectBtn.innerHTML = iconSvg('close', 11) + '<span>断开连接</span>';
    disconnectBtn.addEventListener('click', () => {
        disconnectSession(c.entryId);
    });
    head.append(headIc, headName, headMeta, disconnectBtn);
    root.appendChild(head);

    const body = document.createElement('div');
    body.className = 'db-console-body';
    root.appendChild(body);

    const view = mountWithSession(deps, doc, (ready, hooks) => {
        const session = ready.info;
        headName.textContent = session.name || '数据库';
        headMeta.textContent = kindLabel(session.kind) + (session.server ? ' · ' + session.server : '') +
            (session.editable ? ' · 可编辑' : ' · 只读');
        const query = createDbQueryEditor({
            get backend() { return getSessionState(c.entryId) ? (getSessionState(c.entryId).api || deps.backend) : deps.backend; },
            flash: deps.flash,
            logActivity: deps.logActivity,
            settings: deps.settings,
            get enhanceSelect() { return deps.enhanceSelect; },
            get sessionLost() { return hooks.sessionLost; },
            get sessionRecovered() { return hooks.sessionRecovered; },
        });
        query.setSession(session);
        return query.el;
    });

    body.appendChild(view.el);
    doc.dbTabUnmount = () => view.dispose();

    return root;
}
