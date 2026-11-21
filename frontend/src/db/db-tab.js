// db-tab.js：内容区「数据库」标签页——一个标签页 = 一个库会话（doc.dbEntry 来自工作区清单）。
//
// 布局沿用三栏：对象树（本库的表/视图）| 表数据网格（面板内子标签页）| SQL 控制台。
// 会话生命周期与标签页绑定：挂载时连接（SQLite 按 entry.allowEdit、MySQL 按连接配置），
// doc.tabUnmount 统一断开（closeDocNow 契约）；网格里未提交的修改随关标签丢弃。
// 「允许编辑」改动后需重开标签页生效（会话的 editable 在建连时确定）。

import {iconSvg} from '../core/icons.js';
import {createDbObjectTree} from './db-object-tree.js';
import {createDbQueryEditor} from './db-query-editor.js';
import {createDbTablePane} from './db-table-grid.js';
import {isPluginDbKind, openPluginSession, pluginDbDriverOf} from './db-plugin.js';
import {kindLabel} from './db-model.js';

export function createDbTabView(deps, doc) {

// 条目优先取创建时的快照；缺失（未来会话恢复等路径丢了域私有字段）时按 marker 值
// （doc.dbView = 条目 id）回工作区注册表自愈
function findEntry() {
    if (doc && doc.dbEntry && doc.dbEntry.id) return doc.dbEntry;
    const id = doc && doc.dbView;
    const list = (deps.settings && deps.settings.dbWorkspaceDatabases) || [];
    return list.find((e) => e.id === id) || {};
}

const entry = findEntry();
const el = document.createElement('div');
el.className = 'db-tab-view';
const root = document.createElement('div');
root.className = 'db-tabview-root';
el.appendChild(root);

let session = null;
let sessionId = '';
let connectError = '';
// 子组件的 backend 通道：内置 kind 直接用宿主绑定；插件 kind 在 connect 成功后换成
// 会话门面（与绑定同名同形，见 db-plugin.js），树/网格/控制台零改动复用
let backendApi = deps.backend;
let pluginSession = null;

// ---------- 骨架 ----------

const header = document.createElement('div');
header.className = 'db-tabview-head';
const headIcon = document.createElement('span');
headIcon.className = 'db-tabview-ic';
headIcon.innerHTML = iconSvg('database', 14);
const headName = document.createElement('span');
headName.className = 'db-tabview-name';
headName.textContent = entry.name || '数据库';
const headMeta = document.createElement('span');
headMeta.className = 'db-tabview-meta';
const headStatus = document.createElement('span');
headStatus.className = 'db-tabview-status';
header.append(headIcon, headName, headMeta, headStatus);

const body = document.createElement('div');
body.className = 'db-tabview-body';
const left = document.createElement('div');
left.className = 'db-left db-tabview-left';
const center = document.createElement('div');
center.className = 'db-center';
const right = document.createElement('div');
right.className = 'db-right';
body.append(left, center, right);

const tree = createDbObjectTree({
    get backend() { return backendApi; },
    getSessions: () => (session ? [session] : []),
    onOpenTable,
    onDisconnect: () => {},
    showDisconnect: false,
});
const treeWrap = document.createElement('div');
treeWrap.className = 'db-tabview-tree';
treeWrap.appendChild(tree.el);
left.appendChild(treeWrap);

const tabBar = document.createElement('div');
tabBar.className = 'db-tabbar';
const tabHost = document.createElement('div');
tabHost.className = 'db-tabhost';
const centerEmpty = document.createElement('div');
centerEmpty.className = 'db-center-empty';
centerEmpty.textContent = '从左侧对象树选择一张表开始浏览';
tabHost.appendChild(centerEmpty);
center.append(tabBar, tabHost);

const query = createDbQueryEditor({
    get backend() { return backendApi; },
    flash: deps.flash,
    logActivity: deps.logActivity,
});
right.appendChild(query.el);

root.append(header, body);

// 表子标签（本库内多表导航；面板内子标签页，不进内容区标签体系）
const tableTabs = new Map(); // tabId → {db, obj, pane, tabEl}
let activeTabId = '';

// ---------- 连接 ----------

async function connect() {
    connectError = '';
    renderHead('连接中…');
    try {
        let info;
        if (isPluginDbKind(entry.kind)) {
            const driver = pluginDbDriverOf(entry.kind);
            if (!driver) throw new Error('驱动未注册（插件已禁用或卸载）');
            const opened = await openPluginSession(deps.backend, entry, driver);
            info = opened.info;
            pluginSession = opened.api;
            backendApi = opened.api;
        } else {
            pluginSession = null;
            backendApi = deps.backend;
            info = entry.kind === 'sqlite'
                ? await deps.backend.DBOpen(entry.path, !!entry.allowEdit)
                : await deps.backend.DBConnect(entry.connectionId);
        }
        session = info;
        sessionId = info.id;
        tree.resetSession(info.id);
        tree.render();
        query.setSession(info);
        renderHead('');
    } catch (e) {
        session = null;
        pluginSession = null;
        backendApi = deps.backend;
        connectError = String(e && e.message || e);
        renderHead('连接失败');
        renderStatus();
    }
}

async function disconnect() {
    if (!sessionId) return;
    try {
        await backendApi.DBClose(sessionId);
    } catch (e) {
        // 会话可能已被空闲回收，照常清理界面
    }
    session = null;
    sessionId = '';
    pluginSession = null;
    backendApi = deps.backend;
}

function renderHead(status) {
    headMeta.textContent = kindLabel(entry.kind) + (session && session.server ? ' · ' + session.server : '') +
        (session && session.immutable ? ' · immutable 只读快照' : '') +
        (session && session.editable ? ' · 可编辑' : ' · 只读');
    headStatus.textContent = status || (connectError ? '连接失败：' + connectError : '');
}

function renderStatus() {
    // 连接失败时把重试入口放进中央空态，避免只有状态栏一行小字
    tabHost.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'db-center-empty';
    if (connectError) {
        const msg = document.createElement('div');
        msg.textContent = '连接失败：' + connectError;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'db-btn primary';
        retry.textContent = '重试连接';
        retry.style.marginTop = '10px';
        retry.addEventListener('click', () => {
            connectError = '';
            connect();
        });
        empty.append(msg, retry);
    } else {
        empty.textContent = '从左侧对象树选择一张表开始浏览';
    }
    tabHost.appendChild(empty);
    if (!tableTabs.size) centerEmpty.hidden = false;
}

// ---------- 表子标签 ----------

function onOpenTable(s, db, obj) {
    session = s;
    const tabId = db + '|' + obj.name;
    if (tableTabs.has(tabId)) {
        activeTabId = tabId;
        renderTabs();
        return;
    }
    const pane = createDbTablePane(
        {
            get backend() { return backendApi; },
            flash: deps.flash,
            settings: deps.settings,
            logActivity: deps.logActivity,
        },
        s, db, obj.name);
    const tabEl = document.createElement('div');
    tabEl.className = 'db-tab';
    const label = document.createElement('span');
    label.className = 'db-tab-label';
    label.textContent = obj.name;
    label.title = (db && db !== 'main' ? db + '.' : '') + obj.name;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'db-tab-close';
    close.innerHTML = iconSvg('close', 10);
    close.addEventListener('click', () => closeTab(tabId));
    tabEl.append(label, close);
    tableTabs.set(tabId, {db, obj, pane, tabEl});
    activeTabId = tabId;
    renderTabs();
}

function closeTab(tabId) {
    tableTabs.delete(tabId);
    if (activeTabId === tabId) activeTabId = Array.from(tableTabs.keys())[0] || '';
    renderTabs();
}

function renderTabs() {
    tabBar.textContent = '';
    tabHost.textContent = '';
    if (!tableTabs.size) {
        tabHost.appendChild(centerEmpty);
        centerEmpty.hidden = false;
        return;
    }
    for (const [tabId, tab] of tableTabs) {
        const tabEl = tab.tabEl;
        tabEl.classList.toggle('active', tabId === activeTabId);
        tabEl.addEventListener('click', (ev) => {
            if (ev.target.closest('.db-tab-close')) return;
            activeTabId = tabId;
            renderTabs();
        });
        tabBar.appendChild(tabEl);
    }
    const active = tableTabs.get(activeTabId);
    if (active) tabHost.appendChild(active.pane.el);
    else {
        activeTabId = Array.from(tableTabs.keys())[0] || '';
        const fallback = tableTabs.get(activeTabId);
        if (fallback) tabHost.appendChild(fallback.pane.el);
        for (const [tabId, tab] of tableTabs) tab.tabEl.classList.toggle('active', tabId === activeTabId);
    }
}

// ---------- 启动与卸载 ----------

function mount() {
    if (!entry.id) {
        renderHead('');
        headStatus.textContent = '该数据库条目无效（已被移除或数据损坏）';
        return;
    }
    connect();
}

mount();

// 域内卸载钩子（bridge-database-view.js 的 doc.tabUnmount 统一契约会调它）：
// 关标签 = 断开该库会话；未提交的网格修改一并丢弃
doc.dbViewUnmount = () => {
    disconnect();
    tableTabs.clear();
    doc.dbViewUnmount = null;
};

return el;
}
