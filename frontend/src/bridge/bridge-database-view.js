// bridge-database-view.js：内容区「数据库」标签页（「一切皆标签页」第一族——一个具体业务对象）。
//
// 侧栏「数据库」面板（db 域）双击工作区清单条目 → 本模块的创建点（marker + key 成对，
// key = 条目 id，去重后重复双击只激活已有标签）；视图本体在 db 域（db-tab.js），
// 经 deps.dbViewMounter 注入——bridge/ 不 import db/（同级域互相不 import）。
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';

export function createBridgeDatabaseView(deps) {

function openDatabaseTab(entry) {
    if (!entry || !entry.id) return null;
    const existing = deps.docs.find((d) => d.dbView && d.dbEntry && d.dbEntry.id === entry.id);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = createVirtualTabDoc({
        id: 'dbtab-' + entry.id,
        name: entry.name,
        format: {id: 'database', name: entry.name, extensions: [], aceMode: 'text', rawOnly: true},
        mode: 'database',
        marker: 'dbView',
        key: entry.id,
    });
    doc.dbEntry = entry;
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

function createDatabaseView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active db-tabview-pane';
    deps.els.editor.appendChild(pane);
    pane.appendChild(deps.dbViewMounter(doc));
    doc.pane = pane;
    // 统一卸载契约（closeDocNow 只调这一条）：会话断开与子状态清理在 db-tab.js 的 doc.dbViewUnmount
    doc.tabUnmount = () => {
        if (doc.dbViewUnmount) doc.dbViewUnmount();
        doc.tabUnmount = null;
        doc.dbViewUnmount = null;
    };
}

return {openDatabaseTab, createDatabaseView};
}
