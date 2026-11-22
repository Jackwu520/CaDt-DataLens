// db-object-tree.js：数据库连接页的对象树——连接 → 库 → 表/视图，两级按需加载（L1/L2）。
// 工厂 + deps 注入；会话清单与打开表动作由 db-page.js 注入，本模块只管树状展示与刷新。

import {iconSvg} from '../core/icons.js';
import {kindLabel, rowEstimateLabel} from './db-model.js';

export function createDbObjectTree(deps) {

const el = document.createElement('div');
el.className = 'db-tree';

// showDisconnect=false：单库标签页内嵌用（断开 = 关标签页，不在此处提供）
const showDisconnect = deps.showDisconnect !== false;

// 展开状态与会话内缓存（db/table 清单）：key = sessionId，value = {dbs, objects: Map(db → list)}
const state = new Map();

function sessionState(id) {
    if (!state.has(id)) {
        state.set(id, {expanded: false, db: '', dbs: null, objects: new Map(), loading: false, error: ''});
    }
    return state.get(id);
}

function clearSession(id) {
    state.delete(id);
}

// 刷新某会话某库的 L1 清单（SQLite database 恒为 'main'）
async function loadObjects(session, db, force) {
    const st = sessionState(session.id);
    if (st.objects.has(db) && !force) return st.objects.get(db);
    st.loading = true;
    render();
    try {
        const list = await deps.backend.DBListObjects(session.id, db);
        st.objects.set(db, list || []);
        st.error = '';
    } catch (e) {
        st.error = String(e && e.message || e);
    } finally {
        st.loading = false;
    }
    render();
    return st.objects.get(db);
}

async function loadDatabases(session) {
    const st = sessionState(session.id);
    st.loading = true;
    render();
    try {
        st.dbs = await deps.backend.DBListDatabases(session.id);
        st.error = '';
        // SQLite 只有一个库，直接展开；MySQL 展开到库级
        const first = (st.dbs || [])[0];
        if (first && (st.dbs || []).length === 1) {
            st.db = first;
            await loadObjects(session, first, false);
        }
    } catch (e) {
        st.error = String(e && e.message || e);
    } finally {
        st.loading = false;
    }
    render();
}

function rowBase(cls, label, icon, tip) {
    const row = document.createElement('div');
    row.className = 'db-tree-row ' + cls;
    if (tip) row.dataset.tip = tip;
    const ic = document.createElement('span');
    ic.className = 'db-tree-ic';
    ic.innerHTML = iconSvg(icon, 13);
    const name = document.createElement('span');
    name.className = 'db-tree-name';
    name.textContent = label;
    row.append(ic, name);
    return row;
}

function renderSessionHeader(session) {
    const st = sessionState(session.id);
    const row = rowBase('db-tree-session', session.name, 'database',
        kindLabel(session.kind) + (session.server ? ' · ' + session.server : ''));
    // 展开箭头
    const arrow = document.createElement('span');
    arrow.className = 'db-tree-arrow' + (st.expanded ? ' open' : '');
    arrow.textContent = '▸';
    row.prepend(arrow);
    // 断开按钮（单库标签页内嵌时隐藏：断开 = 关标签页）
    if (showDisconnect) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'db-tree-act';
        close.title = '断开连接';
        close.innerHTML = iconSvg('close', 12);
        close.addEventListener('click', (ev) => {
            ev.stopPropagation();
            deps.onDisconnect(session.id);
        });
        row.appendChild(close);
    }
    if (session.immutable) {
        const badge = document.createElement('span');
        badge.className = 'db-tree-badge warn';
        badge.dataset.tip = '以 immutable 模式打开：数据可能不反映其他进程的写入';
        badge.textContent = '只读快照';
        row.appendChild(badge);
    }
    if (session.editable) {
        const badge = document.createElement('span');
        badge.className = 'db-tree-badge';
        badge.textContent = '可编辑';
        row.appendChild(badge);
    }
    row.addEventListener('click', async () => {
        st.expanded = !st.expanded;
        if (st.expanded && !st.dbs) await loadDatabases(session);
        render();
    });
    return row;
}

function renderDbRow(session, db) {
    const st = sessionState(session.id);
    const active = st.db === db;
    const row = rowBase('db-tree-db' + (active ? ' active' : ''), db, 'open-folder');
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'db-tree-act';
    refresh.title = '刷新表清单';
    refresh.innerHTML = iconSvg('refresh', 12);
    refresh.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        st.objects.delete(db);
        st.db = db;
        await loadObjects(session, db, true);
        render();
    });
    row.appendChild(refresh);
    row.addEventListener('click', async () => {
        st.db = db;
        await loadObjects(session, db, false);
        render();
    });
    return row;
}

function renderObjectRow(session, db, obj) {
    const row = rowBase('db-tree-obj', obj.name, obj.kind === 'view' ? 'eye' : 'view-table',
        (obj.kind === 'view' ? '视图' : '表') + (rowEstimateLabel(obj.rowEstimate) ? ' · ' + rowEstimateLabel(obj.rowEstimate) : ''));
    row.addEventListener('click', () => {
        deps.onOpenTable(session, db, obj);
    });
    return row;
}

function renderSession(session) {
    const st = sessionState(session.id);
    const wrap = document.createElement('div');
    wrap.className = 'db-tree-group';
    wrap.appendChild(renderSessionHeader(session));
    if (!st.expanded) return wrap;
    if (st.loading && !st.dbs) {
        const hint = document.createElement('div');
        hint.className = 'db-tree-hint';
        hint.textContent = '加载中…';
        wrap.appendChild(hint);
        return wrap;
    }
    if (st.error) {
        const err = document.createElement('div');
        err.className = 'db-tree-hint error';
        err.textContent = st.error;
        wrap.appendChild(err);
        return wrap;
    }
    for (const db of st.dbs || []) {
        wrap.appendChild(renderDbRow(session, db));
        if (st.db !== db) continue;
        const objs = st.objects.get(db);
        if (st.loading && !objs) {
            const hint = document.createElement('div');
            hint.className = 'db-tree-hint';
            hint.textContent = '加载表清单…';
            wrap.appendChild(hint);
        } else if (!objs || !objs.length) {
            const hint = document.createElement('div');
            hint.className = 'db-tree-hint';
            hint.textContent = '（无表）';
            wrap.appendChild(hint);
        } else {
            for (const obj of objs) wrap.appendChild(renderObjectRow(session, db, obj));
        }
    }
    return wrap;
}

function render() {
    el.textContent = '';
    const sessions = deps.getSessions();
    if (!sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'db-tree-hint';
        empty.textContent = '尚未打开任何数据库。用上方按钮打开 SQLite 库文件，或新建 MySQL 连接。';
        el.appendChild(empty);
        return;
    }
    for (const session of sessions) {
        if (!state.has(session.id)) clearSession(session.id);
        el.appendChild(renderSession(session));
    }
}

return {
    el,
    render,
    /** 会话断开后清树内状态。 */
    removeSession(id) {
        clearSession(id);
        render();
    },
    /** 会话替换（重连）后清缓存。 */
    resetSession(id) {
        clearSession(id);
        render();
    },
    /** 连接失败时全清：上一次成功渲染的会话行不能留在树里误导（头部已显示失败）。 */
    clear() {
        state.clear();
        render();
    },
};
}
