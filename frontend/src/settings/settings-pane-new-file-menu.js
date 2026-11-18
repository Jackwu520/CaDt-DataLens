// 设置 → 菜单管理：资源管理器右键「新建」子菜单的显隐 / 排序 / 自定义模板。
// 配置本体只有 settings.newFileMenu 一份（localStorage 随 applySettings 落盘）；
// 本模块只渲染与调用 new-file-menu.js 的纯函数，不另存状态。
//
// 控件一律经 core/form-controls.js 工厂创建（表单硬规范），权限判定不在这里——
// readOnlyMode 由 explorer-ops 合成菜单时兜底，配置改了也绕不过去。

import {createInput, createSwitch, createTextarea} from '../core/form-controls.js';
import {iconSvg} from '../core/icons.js';
import {
    BUILTIN_FILE_TYPES, MAX_CUSTOM, SPECIAL_IDS, SPECIAL_LABELS,
    defaultNewFileMenu, moveMenuItem, normalizeNewFileMenu, promoteMenuItem,
    removeCustomTemplate, reorderMenuItem, setMenuItemHidden, upsertCustomTemplate,
} from '../explorer/new-file-menu.js';

export function createSettingsPaneNewFileMenu(deps) {

let formOpen = false;
let editingId = null;
let draggingId = '';   // 正在拖拽的条目 id（仅本模块内使用，对齐排队消息的 draggingQueueId）

// 拖动排序：与排队消息同一套「目标位置让出一条插槽」的 JetBrains 式让位，
// 不画描边 / 插入线；重绘会换掉行 DOM，届时 draggingId 一并作废。
function clearDropGaps() {
    const card = document.querySelector('#new-file-menu-settings .nfm-list');
    if (!card) return;
    for (const row of card.querySelectorAll('.drop-gap-before, .drop-gap-after')) {
        row.classList.remove('drop-gap-before', 'drop-gap-after');
    }
}

function currentConfig() {
    return normalizeNewFileMenu(deps.settings && deps.settings.newFileMenu);
}

function save(next, message) {
    deps.settings.newFileMenu = next;
    formOpen = false;
    editingId = null;
    if (typeof deps.applySettings === 'function') deps.applySettings();
    if (message && typeof deps.flash === 'function') deps.flash(message);
    renderNewFileMenuPane();
}

function span(className, text) {
    const el = document.createElement('span');
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
}

function btn(label, className, onClick, disabled) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className || 'dlg-btn';
    el.textContent = label;
    if (disabled) el.disabled = true;
    if (typeof onClick === 'function') el.addEventListener('click', onClick);
    return el;
}

// allRows：先按 order（含已隐藏项），再补上还在「更多」二级里的内置类型。
function allRows(config) {
    const meta = new Map();
    for (const id of SPECIAL_IDS) meta.set(id, {label: SPECIAL_LABELS[id], name: ''});
    for (const type of BUILTIN_FILE_TYPES) meta.set(type.id, type);
    for (const item of config.custom) meta.set(item.id, item);
    const ids = [...config.order];
    for (const id of meta.keys()) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => {
        const item = meta.get(id) || {label: id, name: ''};
        return {
            id, label: item.label, name: item.name || '',
            custom: config.custom.some((c) => c.id === id),
            hidden: config.hidden.includes(id),
            inOrder: config.order.includes(id),
        };
    });
}

function buildRow(row, config) {
    const line = document.createElement('div');
    line.className = 'set-row nfm-row';
    line.dataset.nfmId = row.id;

    // 拖动手柄：只让手柄可拖，行内开关 / 上下移 / 编辑 / 删除仍可正常点击。
    const handle = document.createElement('span');
    handle.className = 'nfm-drag';
    handle.draggable = true;
    handle.dataset.tip = '拖动排序：调整菜单条目顺序';
    handle.setAttribute('aria-label', '拖动排序');
    handle.innerHTML = iconSvg('grip', 12);
    handle.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        draggingId = row.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.id);
        try { e.dataTransfer.setDragImage(line, 12, 12); } catch (err) { /* 预览失败不影响排序 */ }
        line.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
        draggingId = '';
        line.classList.remove('dragging');
        clearDropGaps();
    });
    line.addEventListener('dragover', (e) => {
        if (!draggingId || line.dataset.nfmId === draggingId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = line.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        clearDropGaps();
        if (before) {
            line.classList.add('drop-gap-before');
        } else {
            const next = line.nextElementSibling;
            // 向下拖时让下一行让位，插槽始终出现在「将要插入的位置」
            if (next && next.classList.contains('nfm-row') && next.dataset.nfmId) {
                next.classList.add('drop-gap-before');
            } else {
                line.classList.add('drop-gap-after');
            }
        }
    });
    line.addEventListener('drop', (e) => {
        if (!draggingId) return;
        e.preventDefault();
        const rect = line.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        const id = draggingId;
        draggingId = '';
        clearDropGaps();
        if (id !== line.dataset.nfmId) {
            save(reorderMenuItem(config, id, line.dataset.nfmId, !before), '已调整顺序：' + row.label);
        }
    });

    const main = document.createElement('div');
    main.className = 'set-main';
    const title = span('set-title', row.label + (row.name ? '  ' + row.name : ''));
    main.appendChild(title);
    const note = row.custom ? '自定义模板 · 可编辑'
        : row.inOrder ? '一级菜单' : '「更多」二级菜单';
    main.appendChild(span('set-desc', note));

    const control = document.createElement('div');
    control.className = 'set-control';
    const toggle = createSwitch({
        checked: !row.hidden,
        title: row.hidden ? '在菜单中显示' : '在菜单中隐藏',
        onChange: () => save(setMenuItemHidden(config, row.id, toggle.control.checked),
            (toggle.control.checked ? '已显示：' : '已隐藏：') + row.label),
    });
    const up = btn('↑', 'dlg-btn gen-move', () => {
        const next = row.inOrder ? moveMenuItem(config, row.id, -1) : promoteMenuItem(config, row.id);
        save(next, '已上移：' + row.label);
    });
    up.dataset.tip = '上移' + (row.inOrder ? '' : '到一级菜单');
    const down = btn('↓', 'dlg-btn gen-move', () => save(moveMenuItem(config, row.id, 1), '已下移：' + row.label),
        !row.inOrder || config.order.indexOf(row.id) === config.order.length - 1);
    down.dataset.tip = '下移';
    control.append(toggle.element, up, down);
    if (row.custom) {
        control.appendChild(btn('编辑', 'dlg-btn', () => {
            editingId = row.id;
            formOpen = true;
            renderNewFileMenuPane();
        }));
        control.appendChild(btn('删除', 'dlg-btn danger', () => {
            save(removeCustomTemplate(config, row.id), '已删除模板：' + row.label);
        }));
    }
    line.append(handle, main, control);
    return line;
}

function blockRow(titleText, control, hint) {
    const line = document.createElement('div');
    line.className = 'set-row-top';
    const main = document.createElement('div');
    main.className = 'set-main';
    main.appendChild(span('set-title', titleText));
    if (hint) main.appendChild(span('set-desc', hint));
    line.append(main, control.element || control);
    return line;
}

function buildForm(config) {
    const card = document.createElement('div');
    card.className = 'set-card';
    const item = editingId ? config.custom.find((c) => c.id === editingId) : null;
    const label = createInput({value: item ? item.label : '', placeholder: '例如：Vue 组件'});
    const name = createInput({value: item ? item.name : '', placeholder: '例如：新建组件.vue'});
    const content = createTextarea({rows: 5, value: item ? item.content : '',
        placeholder: '模板初始内容（可留空）'});
    const error = span('set-desc', '');
    error.style.color = 'var(--red)';

    card.append(
        blockRow('显示名称', label),
        blockRow('文件名', name, '需带扩展名，创建后可改'),
        blockRow('初始内容', content, '最多 4096 字符，不支持 {date} 之类变量'),
        error,
    );
    const foot = document.createElement('div');
    foot.className = 'set-control';
    foot.append(
        btn(item ? '保存模板' : '添加模板', 'dlg-btn primary', () => {
            const result = upsertCustomTemplate(config,
                {label: label.control.value, name: name.control.value, content: content.control.value},
                editingId);
            if (!result.ok) {
                error.textContent = result.error;
                return;
            }
            save(result.config, item ? '已保存模板：' + label.control.value : '已添加模板：' + label.control.value);
        }),
        btn('取消', 'dlg-btn', () => {
            formOpen = false;
            editingId = null;
            renderNewFileMenuPane();
        }),
    );
    card.appendChild(foot);
    return card;
}

function renderNewFileMenuPane() {
    const root = document.getElementById('new-file-menu-settings');
    if (!root) return;
    // 重绘会换掉全部行 DOM：进行中的拖动作废，避免 dragend 丢失后留下过期 draggingId。
    draggingId = '';
    root.textContent = '';
    const config = currentConfig();

    root.appendChild(span('set-group-title', '新建菜单（资源管理器右键）'));
    const intro = document.createElement('div');
    intro.className = 'set-desc';
    intro.textContent = '控制「新建」子菜单里出现哪些条目与顺序：拖左侧手柄排序，或用右侧上下移。隐藏不是删除，随时可以切回来。';
    root.appendChild(intro);

    const head = document.createElement('div');
    head.className = 'set-control';
    head.style.margin = '8px 0';
    const add = btn('＋ 添加模板', 'dlg-btn', () => {
        if (config.custom.length >= MAX_CUSTOM) {
            if (typeof deps.flash === 'function') deps.flash('自定义模板最多 ' + MAX_CUSTOM + ' 个', true);
            return;
        }
        editingId = null;
        formOpen = true;
        renderNewFileMenuPane();
    });
    add.dataset.tip = '自定义一个带初始内容的文件类型';
    const reset = btn('恢复默认', 'dlg-btn', () => {
        if (reset.dataset.confirm !== '1') {
            reset.dataset.confirm = '1';
            reset.textContent = '确认恢复？';
            return;
        }
        save(defaultNewFileMenu(), '新建菜单已恢复默认');
    });
    head.append(add, reset);
    root.appendChild(head);

    if (formOpen) root.appendChild(buildForm(config));

    const card = document.createElement('div');
    card.className = 'set-card nfm-list';
    for (const row of allRows(config)) card.appendChild(buildRow(row, config));
    root.appendChild(card);
}

return {renderNewFileMenuPane};
}
