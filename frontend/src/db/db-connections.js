// db-connections.js：MySQL 连接管理对话框——对齐 JetBrains「数据源和驱动程序」形态。
//
// 左列表（全部全局连接 + 工作区徽标，+ 新建 / − 删除）| 右表单（名称自动建议 user@host:port、
// 主机端口并排、URL 预览、允许编辑开关、加入当前工作区开关）| 底部 测试连接 / 取消 / 应用 / 确定。
// 「应用」= 保存草稿并刷新列表不关窗；「确定」= 应用 + 关窗；连接配置存全局
// （Go db-connections.json），工作区引用由 deps.syncWorkspaceRef 同步（db-ui.js 提供）。
// 密码 DPAPI 加密、不回显、不进配置 JSON；表单走 core/form-controls.js，弹层走 overlay-stack。
//
// JetBrains 对照：名称自动建议（@localhost / user@localhost）↔ nameTouched 前自动跟随主机端口；
// 「项目数据源」↔「加入当前工作区」开关；URL 自动生成 ↔ 只读预览（不支持 URL 驱动表单，够用）。

import {iconSvg} from '../core/icons.js';
import {createInput, createSelect, createSwitch} from '../core/form-controls.js';
import {overlayStack} from '../core/overlay-stack.js';

function openMaskDialog(id, panel) {
    const mask = document.createElement('div');
    mask.className = 'db-preview-mask';
    mask.appendChild(panel);
    const handle = overlayStack.open({
        id,
        kind: 'modal',
        el: panel,
        underEl: mask,
        onClose: () => {
            mask.remove();
            panel.remove();
        },
    });
    document.body.appendChild(mask);
    const close = () => handle.dispose();
    mask.addEventListener('click', (ev) => {
        if (ev.target === mask) close();
    });
    return {mask, panel, close};
}

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

function suggestedName(draft) {
    const host = draft.host || 'localhost';
    return (draft.user ? draft.user + '@' : '') + host + ':' + (draft.port || 3306);
}

function draftEquals(a, b) {
    const strip = (d) => JSON.stringify({
        name: d.name, host: d.host, port: d.port, database: d.database,
        user: d.user, allowEdit: d.allowEdit,
    });
    return strip(a) === strip(b);
}

/**
 * 连接管理对话框（JetBrains「数据源和驱动程序」对齐版）。
 * @param {object} deps {backend, flash, syncWorkspaceRef(id, inWorkspace, name), workspaceFolder()}
 * @param {object} [opts] {initialSelectId}: 打开时选中的连接（侧栏「编辑连接…」直达）
 * @returns {Promise<void>} 关闭即完成（工作区引用已在应用时同步）
 */
export function openConnectionsManager(deps, opts = {}) {
    return new Promise((resolve) => {
        let connections = [];
        let selectedId = opts.initialSelectId || '';
        let draft = null;        // 当前选中连接的可编辑副本（含 id；新建草稿 id 为 ''）
        let password = '';       // 只在保存/测试时使用，不落任何列表
        let nameTouched = true;  // 选中已有连接时保持已存名称；新建草稿为 false 让名称自动跟随

        const panel = document.createElement('div');
        panel.className = 'db-preview db-ds-dialog';

        const head = document.createElement('div');
        head.className = 'db-preview-head';
        head.textContent = '数据库连接管理（MySQL）';

        const body = document.createElement('div');
        body.className = 'db-ds-body';

        // ---- 左列：工具栏 + 连接清单 ----
        const left = document.createElement('div');
        left.className = 'db-ds-left';
        const toolbar = document.createElement('div');
        toolbar.className = 'db-ds-toolbar';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'db-btn';
        addBtn.innerHTML = iconSvg('plus', 12);
        addBtn.title = '新建连接';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'db-btn';
        delBtn.innerHTML = iconSvg('trash', 12);
        delBtn.title = '删除选中连接（全局，含凭据）';
        toolbar.append(addBtn, delBtn);
        const listEl = document.createElement('div');
        listEl.className = 'db-ds-list';
        left.append(toolbar, listEl);

        // ---- 右列：表单 ----
        const right = document.createElement('div');
        right.className = 'db-ds-right';
        const form = document.createElement('div');
        form.className = 'db-conn-form db-ds-form';
        const nameInput = createInput({value: '', placeholder: suggestedName({host: 'localhost', port: 3306})});
        // 驱动：MySQL 与 MariaDB 协议兼容（同一引擎），选择只决定工作区分组标签
        const protocolSelect = createSelect({
            options: [
                {value: 'mysql', label: 'MySQL', selected: true},
                {value: 'mariadb', label: 'MariaDB'},
            ],
        });
        const hostInput = createInput({value: '', placeholder: '主机（IP 或域名）'});
        const portInput = createInput({type: 'number', value: 3306, min: 1, max: 65535});
        const userInput = createInput({value: '', placeholder: '用户名'});
        const passInput = createInput({type: 'password', value: '', placeholder: '密码'});
        passInput.control.autocomplete = 'new-password';
        const dbInput = createInput({value: '', placeholder: '默认库（可留空，连接后也可在对象树切换）'});
        const editSwitch = createSwitch({checked: false});
        const wsSwitch = createSwitch({checked: false});
        const urlLine = document.createElement('div');
        urlLine.className = 'db-ds-url';
        formRow(form, '名称', nameInput.element);
        formRow(form, '驱动（同一引擎，分组标签不同）', protocolSelect.element);
        const hostPortRow = document.createElement('div');
        hostPortRow.className = 'db-conn-rowline';
        const hostLabel = document.createElement('span');
        hostLabel.className = 'db-conn-label';
        hostLabel.textContent = '主机';
        const hostWrap = document.createElement('span');
        hostWrap.className = 'db-ds-hostport';
        const portLabel = document.createElement('span');
        portLabel.className = 'db-conn-label db-ds-port-label';
        portLabel.textContent = '端口';
        hostWrap.append(hostInput.element, portLabel, portInput.element);
        hostPortRow.append(hostLabel, hostWrap);
        form.appendChild(hostPortRow);
        formRow(form, '用户', userInput.element);
        formRow(form, '密码', passInput.element);
        formRow(form, '数据库', dbInput.element);
        formRow(form, '允许编辑（写操作仍需提交预览确认）', editSwitch.element);
        formRow(form, '加入当前工作区（侧栏双击打开）', wsSwitch.element);
        form.appendChild(urlLine);
        right.appendChild(form);
        body.append(left, right);

        // ---- 底部：测试 / 取消 / 应用 / 确定 ----
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot db-ds-foot';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'db-btn';
        testBtn.textContent = '测试连接';
        const driverLabel = document.createElement('span');
        driverLabel.className = 'db-ds-driver';
        driverLabel.textContent = 'MySQL';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'db-btn';
        applyBtn.textContent = '应用';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'db-btn primary';
        okBtn.textContent = '确定';
        foot.append(testBtn, driverLabel, cancelBtn, applyBtn, okBtn);
        panel.append(head, body, foot);

        const {close} = openMaskDialog('db-connections-manager', panel);

        // ---------- 数据与渲染 ----------

        async function reload(selected) {
            connections = await deps.backend.DBListConnections() || [];
            if (selected !== undefined) selectedId = selected;
            if (!selectedId) selectedId = opts.initialSelectId && connections.some((c) => c.id === opts.initialSelectId)
                ? opts.initialSelectId
                : (connections[0] ? connections[0].id : '');
            const refs = deps.listWorkspaceRefs();
            renderList(refs);
            select(selectedId, refs);
        }

        function renderList(refs) {
            const wsSet = new Set(refs.map((r) => r.connectionId));
            listEl.textContent = '';
            if (!connections.length) {
                const hint = document.createElement('div');
                hint.className = 'db-tree-hint';
                hint.textContent = '还没有连接。点上方 + 新建。';
                listEl.appendChild(hint);
                return;
            }
            for (const cfg of connections) {
                const row = document.createElement('div');
                row.className = 'db-ds-row' + (cfg.id === selectedId ? ' active' : '');
                const main = document.createElement('div');
                main.className = 'db-ds-row-main';
                const name = document.createElement('div');
                name.className = 'db-conn-name';
                name.textContent = cfg.name;
                const sub = document.createElement('div');
                sub.className = 'db-conn-sub';
                sub.textContent = cfg.host + ':' + cfg.port + (cfg.database ? '/' + cfg.database : '');
                main.append(name, sub);
                row.appendChild(main);
                if (wsSet.has(cfg.id)) {
                    const badge = document.createElement('span');
                    badge.className = 'db-tree-badge';
                    badge.textContent = '工作区';
                    row.appendChild(badge);
                }
                row.addEventListener('click', () => select(cfg.id));
                listEl.appendChild(row);
            }
        }

        function select(id, refsArg) {
            const refs = refsArg || deps.listWorkspaceRefs();
            const wsSet = new Set(refs.map((r) => r.connectionId));
            if (draft && !draft.id && !draftEquals(draft, blankDraft())) {
                deps.flash('未保存的新建草稿已丢弃');
            }
            selectedId = id;
            password = '';
            const cfg = connections.find((c) => c.id === id);
            if (!cfg) {
                draft = null;
                renderList(refs);
                renderForm();
                return;
            }
            draft = Object.assign({}, cfg);
            nameTouched = true;
            wsSwitch.control.checked = wsSet.has(id);
            // 驱动标签跟随工作区引用条目（mysql | mariadb）
            const ref = refs.find((r) => r.connectionId === id);
            protocolSelect.control.value = ref && ref.kind === 'mariadb' ? 'mariadb' : 'mysql';
            renderList(refs);
            renderForm();
        }

        function blankDraft() {
            return {id: '', kind: 'mysql', name: '', host: '', port: 3306, database: '', user: '', allowEdit: false};
        }

        function newDraft() {
            selectedId = '';
            draft = blankDraft();
            password = '';
            nameTouched = false; // 名称自动跟随 user@host:port（JetBrains 的 @localhost 习惯）
            renderList(new Set(deps.listWorkspaceRefs()));
            renderForm();
            nameInput.control.focus();
        }

        function renderForm() {
            const empty = !draft;
            form.classList.toggle('hidden', empty);
            driverLabel.hidden = empty;
            testBtn.disabled = empty;
            applyBtn.disabled = empty;
            okBtn.disabled = empty;
            delBtn.disabled = !selectedId;
            if (empty) {
                urlLine.textContent = '';
                return;
            }
            nameInput.control.value = draft.name;
            hostInput.control.value = draft.host;
            portInput.control.value = draft.port || 3306;
            userInput.control.value = draft.user || '';
            dbInput.control.value = draft.database || '';
            passInput.control.value = '';
            passInput.control.placeholder = draft.id ? '已保存（留空保持不变）' : '密码';
            editSwitch.control.checked = !!draft.allowEdit;
            updateUrl();
        }

        function collectDraft() {
            return {
                id: draft.id || '',
                name: nameInput.control.value.trim(),
                kind: 'mysql',
                host: hostInput.control.value.trim(),
                port: Number(portInput.control.value) || 0,
                database: dbInput.control.value.trim(),
                user: userInput.control.value.trim(),
                allowEdit: editSwitch.control.checked,
                updatedAt: draft.updatedAt || 0,
            };
        }

        function updateUrl() {
            const d = collectDraft();
            urlLine.textContent = 'mysql://' + (d.user ? d.user + '@' : '') + d.host + ':' + (d.port || 3306) + (d.database ? '/' + d.database : '');
        }

        // ---------- 动作 ----------

        async function applyDraft() {
            if (!draft) return false;
            const d = collectDraft();
            if (!d.name) d.name = suggestedName(d); // 名称留空时按建议值落盘
            try {
                const saved = await deps.backend.DBSaveConnection(d, password);
                await deps.syncWorkspaceRef(saved.id, wsSwitch.control.checked, saved.name, protocolSelect.control.value);
                password = '';
                await reload(saved.id);
                deps.flash('连接已保存：' + saved.name);
                return true;
            } catch (e) {
                deps.flash('保存失败：' + (e && e.message || e), true);
                return false;
            }
        }

        nameInput.control.addEventListener('input', () => {
            nameTouched = true;
        });
        for (const input of [hostInput, portInput, userInput]) {
            input.control.addEventListener('input', () => {
                if (!nameTouched && draft) {
                    const d = collectDraft();
                    nameInput.control.value = suggestedName(d);
                }
                updateUrl();
            });
        }
        dbInput.control.addEventListener('input', updateUrl);

        addBtn.addEventListener('click', newDraft);
        delBtn.addEventListener('click', async () => {
            const cfg = connections.find((c) => c.id === selectedId);
            if (!cfg) return;
            const ok = await confirmDeleteConnection(deps, cfg);
            if (!ok) return;
            await deps.syncWorkspaceRef(cfg.id, false, cfg.name);
            await reload('');
        });
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            try {
                const version = await deps.backend.DBTestConnection(collectDraft(), password);
                deps.flash('连接正常：' + version);
            } catch (e) {
                deps.flash('测试失败：' + (e && e.message || e), true);
            } finally {
                testBtn.disabled = false;
            }
        });
        applyBtn.addEventListener('click', () => applyDraft());
        okBtn.addEventListener('click', async () => {
            if (await applyDraft()) {
                close();
                resolve();
            }
        });
        cancelBtn.addEventListener('click', () => {
            close();
            resolve();
        });

        reload();
    });
}

/**
 * 删除连接确认（全局删除：配置 + 加密凭据一并清）。
 * @returns {Promise<boolean>} true = 用户确认删除且已删除
 */
export function confirmDeleteConnection(deps, cfg) {
    return new Promise((resolve) => {
        const panel = document.createElement('div');
        panel.className = 'db-preview db-conn-dialog';
        const head = document.createElement('div');
        head.className = 'db-preview-head';
        head.textContent = '删除连接「' + cfg.name + '」？';
        const body = document.createElement('div');
        body.className = 'db-preview-body';
        body.textContent = '连接配置与保存的密码（加密凭据）一并删除；引用它的工作区清单条目同步移除；不影响数据库本身。';
        const foot = document.createElement('div');
        foot.className = 'db-preview-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'db-btn';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'db-btn danger';
        okBtn.textContent = '删除';
        foot.append(cancelBtn, okBtn);
        panel.append(head, body, foot);
        const {close} = openMaskDialog('db-conn-delete', panel);
        cancelBtn.addEventListener('click', () => {
            close();
            resolve(false);
        });
        okBtn.addEventListener('click', async () => {
            try {
                await deps.backend.DBDeleteConnection(cfg.id);
                deps.flash('连接已删除：' + cfg.name);
                close();
                resolve(true);
            } catch (e) {
                deps.flash('删除失败：' + (e && e.message || e), true);
            }
        });
    });
}
