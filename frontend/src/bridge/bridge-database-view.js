// bridge-database-view.js：内容区数据库虚拟标签页的创建点（「一切皆标签页」第一族——具体业务对象）。
//
// 侧栏会话树（db-session-tree.js）双击表 → openDbTableTab（每表一个标签，key = 条目|库|表）；
// 行菜单「打开查询控制台」→ openDbConsoleTab（每会话一个标签，key = 条目 id）。
// 视图本体在 db 域（db-tab-views.js），经 deps.dbTabMounter 注入——bridge/ 不 import db/（同级域互相不 import）。
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';

export function createBridgeDatabaseView(deps) {

function openDoc({id, name, marker, key, decorate}) {
    const existing = deps.docs.find((d) => d[marker] && d[marker] === key);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = createVirtualTabDoc({
        id,
        name,
        format: {id: 'database', name, extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'database',
        marker,
        key,
    });
    if (decorate) decorate(doc);
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

// 数据表标签页：marker 字段 dbTable = 去重 key（createVirtualTabDoc 成对语义），
// 视图数据在 doc.dbTableSpec
function openDbTableTab(entry, db, obj) {
    if (!entry || !entry.id || !obj) return null;
    const key = entry.id + '|' + (db || 'main') + '|' + obj.name;
    return openDoc({
        id: 'dbtable-' + key,
        name: obj.name,
        marker: 'dbTable',
        key,
        decorate(doc) {
            doc.dbTableSpec = {
                entryId: entry.id,
                entry,
                db: db || 'main',
                table: obj.name,
                kind: obj.kind || 'table',
            };
        },
    });
}

// 查询控制台标签页：每会话一个；标题带连接名便于多库区分
function openDbConsoleTab(entry) {
    if (!entry || !entry.id) return null;
    return openDoc({
        id: 'dbconsole-' + entry.id,
        name: entry.name || '查询控制台',
        marker: 'dbConsole',
        key: entry.id,
        decorate(doc) {
            doc.dbConsoleSpec = {entryId: entry.id, entry, title: (entry.name || '数据库') + ' 控制台'};
        },
    });
}

// Redis 键查看器标签页（方案 §11.13）：每个键一个，key = 条目|库|键
function openDbRedisKeyTab(entry, db, key) {
    if (!entry || !entry.id || !key) return null;
    const dedupe = entry.id + '|' + (db || '') + '|' + key;
    return openDoc({
        id: 'dbrediskey-' + dedupe,
        name: key,
        marker: 'dbRedisKey',
        key: dedupe,
        decorate(doc) {
            doc.dbRedisKeySpec = {entryId: entry.id, entry, db: db || '', key};
        },
    });
}

function createDatabaseTabView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active db-tabview-pane';
    deps.els.editor.appendChild(pane);
    pane.appendChild(deps.dbTabMounter(doc));
    doc.pane = pane;
    // 统一卸载契约（closeDocNow 只调这一条）：关标签只关视图，不断会话（会话挂侧栏）
    doc.tabUnmount = () => {
        if (doc.dbTabUnmount) doc.dbTabUnmount();
        doc.tabUnmount = null;
        doc.dbTabUnmount = null;
    };
}

return {openDbTableTab, openDbConsoleTab, openDbRedisKeyTab, createDatabaseTabView};
}
