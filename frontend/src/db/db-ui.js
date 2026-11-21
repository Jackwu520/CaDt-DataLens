// db-ui.js：侧栏「数据库」面板——本工作区下所有添加的数据库，按类型分组折叠。
//
// 工作区清单存 settings.dbWorkspaceDatabases（平铺数组，条目带 workspace 字段，
// 与 lifecycleHooks 的「本机设置、按工作区生效」同款模式；settings-changed 跨窗同步）：
//   {id, workspace, kind, name, path?|connectionId?|config?, allowEdit?, addedAt}
// kind 三族：sqlite（存路径 + 条目级 allowEdit）、mysql|mariadb（引用全局连接 id，
// 配置与凭据在 Go 侧，多工作区共享；mariadb 与 mysql 同引擎、只差分组标签）、
// `plugin:<插件id>:<驱动id>`（插件驱动，config 存声明字段、密文字段走 dpapi 凭据库）。
//
// 总开关 settings.dbToolsEnabled（默认关）：未启用时面板只显示启用门，标签页打不开。
// 双击 → 在内容区开「数据库」标签页（bridge-database-view.js 的创建点）；右键/[...] → 菜单。

import {iconSvg} from '../core/icons.js';
import {createInput, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';
import {getPluginDbDrivers} from '../shell/plugin-db-drivers.js';
import {openConnectionsManager, confirmDeleteConnection} from './db-connections.js';
import {isPluginDbKind, openPluginSession, pluginDbDriverOf, pluginDbLabel} from './db-plugin.js';
import {kindLabel} from './db-model.js';

const REGISTRY_KEY = 'dbWorkspaceDatabases';

function formRow(form, label, control) {
    const row = document.createElement('label');
    row.className = 'db-conn-rowline';
    const text = document.createElement('span');
    text.className = 'db-conn-label';
    text.textContent = label;
    row.append(text, control);
    form.appendChild(row);
    return row;
}

function basenameOf(p) {
    return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export function createDbUi(deps) {

// 折叠状态（内存即可：重启回默认全展开）
const collapsed = new Map(); // key = workspace|kind

function getSettings() {
    return deps.settings || {};
}

function currentWorkspace() {
    return deps.workspaceFolder ? (deps.workspaceFolder() || '') : '';
}

function listAll() {
    const v = getSettings()[REGISTRY_KEY];
    return Array.isArray(v) ? v : [];
}

function listForWorkspace() {
    const ws = currentWorkspace();
    return listAll().filter((e) => e.workspace === ws);
}

function persist() {
    deps.persistSettingsLight();
}

function addEntry(entry) {
    const all = listAll();
    all.push(entry);
    getSettings()[REGISTRY_KEY] = all;
    persist();
}

function removeEntry(id) {
    getSettings()[REGISTRY_KEY] = listAll().filter((e) => e.id !== id);
    persist();
}

function updateEntry(id, patch) {
    getSettings()[REGISTRY_KEY] = listAll().map((e) => (e.id === id ? Object.assign({}, e, patch) : e));
    persist();
}

function findEntry(id) {
    return listAll().find((e) => e.id === id) || null;
}

async function globalConnections() {
    try {
        return await deps.backend.DBListConnections() || [];
    } catch (e) {
        return [];
    }
}

// ---------- 添加入口 ----------

async function addSqlite() {
    const pick = await deps.backend.ShowOpenFileDialog('选择 SQLite 数据库',
        'SQLite 数据库 (*.db;*.sqlite;*.sqlite3)|*.db;*.sqlite;*.sqlite3|所有文件 (*.*)|*.*');
    const path = String(pick || '');
    if (!path) return;
    const dup = listForWorkspace().find((e) => e.kind === 'sqlite' && e.path === path);
    if (dup) {
        deps.flash('已在工作区清单里：' + dup.name);
        return;
    }
    addEntry({
        id: 'wsdb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        workspace: currentWorkspace(),
        kind: 'sqlite',
        path,
        name: basenameOf(path),
        allowEdit: false,
        addedAt: Date.now(),
    });
    deps.flash('已添加数据库：' + basenameOf(path));
    renderSidebar();
}

// MySQL/MariaDB 添加/管理：统一对话框（JetBrains「数据源和驱动程序」形态）。
// syncWorkspaceRef / listWorkspaceRefs 把全局连接与工作区清单的双向关系收在注册表这一层
// （引用条目完整返回，管理对话框据此回显驱动标签 mysql|mariadb）。
function dsDeps() {
    return {
        get backend() { return deps.backend; },
        get flash() { return deps.flash; },
        listWorkspaceRefs: () => listForWorkspace()
            .filter((e) => e.kind === 'mysql' || e.kind === 'mariadb')
            .map((e) => ({connectionId: e.connectionId, kind: e.kind})),
        syncWorkspaceRef: (connectionId, inWorkspace, name, protocol) => {
            const kind = protocol === 'mariadb' ? 'mariadb' : 'mysql';
            const kept = listAll().filter((e) => !((e.kind === 'mysql' || e.kind === 'mariadb') && e.connectionId === connectionId && e.workspace === currentWorkspace()));
            if (inWorkspace) {
                kept.push({
                    id: 'wsdb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
                    workspace: currentWorkspace(),
                    kind,
                    connectionId,
                    name: name || '',
                    addedAt: Date.now(),
                });
            }
            getSettings()[REGISTRY_KEY] = kept;
            persist();
        },
    };
}

async function addMysql() {
    await openConnectionsManager(dsDeps());
    renderSidebar();
}

// ---------- 插件驱动（cadt.registerDbDriver）添加 / 编辑 ----------

function labelForKind(kind) {
    return kind.startsWith('plugin:') ? pluginDbLabel(kind) : kindLabel(kind);
}

function newEntryId() {
    return 'wsdb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

// 插件驱动的动态连接表单：字段由驱动声明（fields），密文字段存 dpapi 凭据库。
// existing = 编辑已有条目；返回 Promise<void>（保存成功后自刷新）。
function openPluginEntryDialog(driver, existing) {
    return new Promise((resolve) => {
        const values = Object.assign({}, (existing && existing.config) || {});
        const panel = document.createElement('div');
        panel.className = 'db-preview db-conn-dialog';
        const head = document.createElement('div');
        head.className = 'db-preview-head';
        head.textContent = (existing ? '编辑' : '添加') + ' · ' + driver.label + '（插件驱动 · ' + driver.pluginName + '）';
        const form = document.createElement('div');
        form.className = 'db-conn-form';
        const nameInput = createInput({
            value: existing ? existing.name : driver.label,
            placeholder: driver.label,
        });
        formRow(form, '名称', nameInput.element);
        const inputs = {};
        for (const field of driver.fields) {
            const isSecret = field.secret && existing; // 编辑时密文留空 = 保持不变
            const input = createInput({
                type: field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text',
                value: field.type === 'password' ? '' : String(values[field.key] != null ? values[field.key] : field.default || ''),
                placeholder: isSecret ? '已保存（留空保持不变）' : (field.default ? String(field.default) : ''),
            });
            if (field.type === 'password') input.control.autocomplete = 'new-password';
            inputs[field.key] = input;
            formRow(form, field.label + (field.secret ? '（加密存储）' : '') + (field.required ? ' *' : ''), input.element);
        }
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'db-btn primary';
        saveBtn.textContent = '保存';
        foot.append(cancelBtn, saveBtn);
        panel.append(head, form, foot);

        // 遮罩弹层（overlayStack 注册，Esc/遮罩/按钮统一收口）
        const mask = document.createElement('div');
        mask.className = 'db-preview-mask';
        mask.appendChild(panel);
        let handle = null;
        const close = () => {
            if (handle) handle.dispose();
        };
        handle = overlayStack.open({
            id: 'db-plugin-entry',
            kind: 'modal',
            el: panel,
            underEl: mask,
            onClose: () => {
                mask.remove();
                panel.remove();
            },
        });
        document.body.appendChild(mask);
        mask.addEventListener('click', (ev) => {
            if (ev.target === mask) close();
        });
        cancelBtn.addEventListener('click', () => {
            close();
            resolve();
        });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            const missing = driver.fields.find((f) => f.required && !String(inputs[f.key].control.value).trim());
            if (missing) {
                saveBtn.disabled = false;
                deps.flash('必填项不能为空：' + missing.label, true);
                return;
            }
            const config = {};
            for (const field of driver.fields) {
                if (field.secret) continue; // 密文走凭据库，不进清单
                const v = inputs[field.key].control.value;
                config[field.key] = field.type === 'number' ? (Number(v) || 0) : v;
            }
            const entryId = existing ? existing.id : newEntryId();
            try {
                const secretValues = {};
                for (const field of driver.fields) {
                    if (field.secret) secretValues[field.key] = inputs[field.key].control.value;
                }
                await savePluginSecrets(deps.backend, entryId, driver, secretValues);
            } catch (e) {
                saveBtn.disabled = false;
                deps.flash('密文保存失败：' + (e && e.message || e), true);
                return;
            }
            const name = nameInput.control.value.trim() || driver.label;
            if (existing) {
                updateEntry(entryId, {name, config});
                deps.flash('已更新：' + name);
            } else {
                addEntry({
                    id: entryId,
                    workspace: currentWorkspace(),
                    kind: driver.kind,
                    name,
                    config,
                    addedAt: Date.now(),
                });
                deps.flash('已添加数据库：' + name);
            }
            close();
            renderSidebar();
            resolve();
        });
        nameInput.control.focus();
    });
}

async function addPluginDriver() {
    const drivers = getPluginDbDrivers();
    if (!drivers.length) {
        deps.flash('没有已注册的插件数据库驱动（到 设置 → 插件 安装）', true);
        return;
    }
    if (drivers.length === 1) {
        await openPluginEntryDialog(drivers[0], null);
        renderSidebar();
        return;
    }
    // 多个驱动：先选驱动再出表单
    const panel = document.createElement('div');
    panel.className = 'db-preview db-conn-dialog';
    const head = document.createElement('div');
    head.className = 'db-preview-head';
    head.textContent = '选择数据库驱动（插件）';
    const body = document.createElement('div');
    body.className = 'db-preview-body';
    for (const driver of drivers) {
        const row = document.createElement('div');
        row.className = 'db-conn-row';
        const main = document.createElement('div');
        main.className = 'db-conn-main';
        const name = document.createElement('div');
        name.className = 'db-conn-name';
        name.textContent = driver.label;
        const sub = document.createElement('div');
        sub.className = 'db-conn-sub';
        sub.textContent = driver.pluginName + ' · plugin:' + driver.id;
        main.append(name, sub);
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'db-btn primary';
        pick.textContent = '选择';
        pick.addEventListener('click', () => {
            close();
            openPluginEntryDialog(driver, null).then(() => renderSidebar());
        });
        row.append(main, pick);
        body.appendChild(row);
    }
    const foot = document.createElement('div');
    foot.className = 'db-preview-foot';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'db-btn';
    cancelBtn.textContent = '取消';
    foot.append(cancelBtn);
    panel.append(head, body, foot);
    const mask = document.createElement('div');
    mask.className = 'db-preview-mask';
    mask.appendChild(panel);
    let handle = null;
    const close = () => {
        if (handle) handle.dispose();
    };
    handle = overlayStack.open({
        id: 'db-plugin-driver-pick',
        kind: 'modal',
        el: panel,
        underEl: mask,
        onClose: () => {
            mask.remove();
            panel.remove();
        },
    });
    document.body.appendChild(mask);
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    cancelBtn.addEventListener('click', close);
}

// ---------- 行菜单 ----------

function rowMenu(entry, anchorRect) {
    const items = [];
    items.push({label: '打开', icon: 'view-table', action: () => deps.openDatabaseTab(entry)});
    if (entry.kind === 'sqlite') {
        items.push({
            label: entry.allowEdit ? '允许编辑 ✓（点击关闭）' : '允许编辑（点击开启，重开标签页生效）',
            icon: entry.allowEdit ? 'check' : 'unlock',
            action: () => {
                updateEntry(entry.id, {allowEdit: !entry.allowEdit});
                deps.flash(entry.allowEdit ? '已关闭允许编辑，重开标签页生效' : '已开启允许编辑，重开标签页生效');
                renderSidebar();
            },
        });
    }
    if (entry.kind === 'mysql') {
        items.push({sep: true});
        items.push({
            label: '测试连接',
            icon: 'zap',
            action: async () => {
                const cfg = (await globalConnections()).find((c) => c.id === entry.connectionId);
                if (!cfg) {
                    deps.flash('连接配置不存在（可能已被删除）', true);
                    return;
                }
                try {
                    const version = await deps.backend.DBTestConnection(cfg, '');
                    deps.flash('连接正常：' + version);
                } catch (e) {
                    deps.flash('测试失败：' + (e && e.message || e), true);
                }
            },
        });
        items.push({
            label: '编辑连接…（打开连接管理）',
            icon: 'gear',
            action: async () => {
                await openConnectionsManager(dsDeps(), {initialSelectId: entry.connectionId});
                renderSidebar();
            },
        });
        items.push({
            label: '删除连接…（全局，含凭据）',
            icon: 'trash',
            action: async () => {
                const cfg = (await globalConnections()).find((c) => c.id === entry.connectionId);
                if (!cfg) return;
                const ok = await confirmDeleteConnection(deps, cfg);
                if (ok) {
                    // 全局删除：所有引用它的条目一并移除
                    getSettings()[REGISTRY_KEY] = listAll().filter((e) => e.connectionId !== cfg.id);
                    persist();
                    renderSidebar();
                }
            },
        });
    }
    if (isPluginDbKind(entry.kind)) {
        items.push({sep: true});
        items.push({
            label: '测试连接（连接即测）',
            icon: 'zap',
            action: async () => {
                const driver = pluginDbDriverOf(entry.kind);
                if (!driver) {
                    deps.flash('驱动未注册（插件已禁用或卸载）', true);
                    return;
                }
                try {
                    const opened = await openPluginSession(deps.backend, entry, driver);
                    await opened.api.DBClose();
                    deps.flash('连接正常：' + driver.label);
                } catch (e) {
                    deps.flash('测试失败：' + (e && e.message || e), true);
                }
            },
        });
        items.push({
            label: '编辑连接…',
            icon: 'gear',
            action: async () => {
                const driver = pluginDbDriverOf(entry.kind);
                if (!driver) {
                    deps.flash('驱动未注册（插件已禁用或卸载）', true);
                    return;
                }
                await openPluginEntryDialog(driver, entry);
                renderSidebar();
            },
        });
    }
    items.push({sep: true});
    items.push({
        label: '从工作区移除',
        icon: 'close',
        action: () => {
            removeEntry(entry.id);
            deps.flash('已从工作区移除：' + entry.name + (entry.kind === 'mysql' ? '（连接配置保留，可重新添加）' : ''));
            renderSidebar();
        },
    });
    deps.ctxMenu.open(items, anchorRect.left, anchorRect.bottom + 2);
}

// ---------- 面板渲染 ----------

function groupHeader(kind, rows) {
    const key = currentWorkspace() + '|' + kind;
    const isCollapsed = collapsed.get(key) || false;
    const head = document.createElement('div');
    head.className = 'db-side-group-head';
    const arrow = document.createElement('span');
    arrow.className = 'db-tree-arrow' + (isCollapsed ? '' : ' open');
    arrow.textContent = '▸';
    const label = document.createElement('span');
    label.className = 'db-side-group-label';
    label.textContent = labelForKind(kind) + '（' + rows.length + '）';
    head.append(arrow, label);
    head.addEventListener('click', () => {
        collapsed.set(key, !isCollapsed);
        renderSidebar();
    });
    return head;
}

function dbRow(entry) {
    const row = document.createElement('div');
    row.className = 'db-side-row';
    row.dataset.tip = entry.kind === 'sqlite'
        ? entry.path + (entry.allowEdit ? ' · 已允许编辑' : '')
        : (entry.name + ' · 双击打开，右键更多操作');
    const ic = document.createElement('span');
    ic.className = 'db-tree-ic';
    ic.innerHTML = iconSvg(
        entry.kind === 'mysql' || entry.kind === 'mariadb' ? 'globe'
            : isPluginDbKind(entry.kind) ? 'puzzle' : 'file', 13);
    const name = document.createElement('span');
    name.className = 'db-tree-name';
    name.textContent = entry.name;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'db-tree-act';
    more.title = '更多操作';
    more.innerHTML = iconSvg('more-vertical', 12);
    row.append(ic, name, more);
    row.addEventListener('dblclick', () => deps.openDatabaseTab(entry));
    row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        rowMenu(entry, {left: ev.clientX, bottom: ev.clientY});
    });
    more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rect = more.getBoundingClientRect();
        rowMenu(entry, {left: rect.left, bottom: rect.bottom});
    });
    return row;
}

function renderGate(host) {
    const wrap = document.createElement('div');
    wrap.className = 'db-gate db-gate-side';
    const title = document.createElement('div');
    title.className = 'db-gate-title';
    title.textContent = '数据库工具未启用';
    const desc = document.createElement('div');
    desc.className = 'db-gate-desc';
    desc.textContent = '启用后可把 SQLite 库文件与 MySQL 连接添加进当前工作区，双击在标签页打开浏览。默认只读；写入需显式开启并逐次确认。';
    const row = document.createElement('label');
    row.className = 'db-gate-switch';
    const sw = createSwitch({checked: false});
    const swLabel = document.createElement('span');
    swLabel.textContent = '启用数据库工具';
    row.append(swLabel, sw.element);
    sw.control.addEventListener('change', () => {
        getSettings().dbToolsEnabled = sw.control.checked;
        persist();
        renderSidebar();
    });
    wrap.append(title, desc, row);
    host.appendChild(wrap);
}

function renderSidebar() {
    const host = document.getElementById('database-nav');
    if (!host) return;
    host.textContent = '';
    if (!getSettings().dbToolsEnabled) {
        renderGate(host);
        return;
    }
    const actions = document.createElement('div');
    actions.className = 'db-left-actions db-side-actions';
    const addSqliteBtn = document.createElement('button');
    addSqliteBtn.type = 'button';
    addSqliteBtn.className = 'db-btn';
    addSqliteBtn.innerHTML = iconSvg('plus', 11) + '<span>SQLite 库</span>';
    addSqliteBtn.addEventListener('click', addSqlite);
    const addMysqlBtn = document.createElement('button');
    addMysqlBtn.type = 'button';
    addMysqlBtn.className = 'db-btn';
    addMysqlBtn.innerHTML = iconSvg('plus', 11) + '<span>MySQL</span>';
    addMysqlBtn.addEventListener('click', addMysql);
    const addPluginBtn = document.createElement('button');
    addPluginBtn.type = 'button';
    addPluginBtn.className = 'db-btn';
    addPluginBtn.innerHTML = iconSvg('plus', 11) + '<span>插件驱动</span>';
    addPluginBtn.addEventListener('click', addPluginDriver);
    actions.append(addSqliteBtn, addMysqlBtn, addPluginBtn);
    host.appendChild(actions);

    // 分组：内置类型固定序在前，插件驱动按显示名排（一个驱动一组）
    const entries = listForWorkspace();
    const kinds = [];
    for (const e of entries) {
        if (!kinds.includes(e.kind)) kinds.push(e.kind);
    }
    const builtinOrder = {sqlite: 0, mysql: 1, mariadb: 2};
    kinds.sort((a, b) => {
        const oa = builtinOrder[a] != null ? builtinOrder[a] : 99;
        const ob = builtinOrder[b] != null ? builtinOrder[b] : 99;
        if (oa !== ob) return oa - ob;
        return labelForKind(a) < labelForKind(b) ? -1 : 1;
    });
    let empty = kinds.length === 0;
    for (const kind of kinds) {
        const rows = entries.filter((e) => e.kind === kind);
        if (!rows.length) continue;
        empty = false;
        host.appendChild(groupHeader(kind, rows));
        if (!collapsed.get(currentWorkspace() + '|' + kind)) {
            for (const entry of rows) host.appendChild(dbRow(entry));
        }
    }
    if (empty) {
        const hint = document.createElement('div');
        hint.className = 'db-tree-hint';
        hint.textContent = '本工作区还没有添加数据库。用上方按钮添加 SQLite 库文件、MySQL/MariaDB 连接或插件驱动，双击列表项在标签页打开。';
        host.appendChild(hint);
    }
}

return {
    renderSidebar,
    /** 暴露给右键测试 / 后续入口复用 */
    openDatabaseTab: (entry) => deps.openDatabaseTab(entry),
};
}
