// settings-pane-precommands.js：设置 → 预指令（工作区打开时自动执行的命令）。
// 条目存 settings.preCommands（AI 没有任何写通道，方案见
// docs/finished-plans/workspace-precommands.md）；纯函数在 core/precommands.js，
// AI 四动作在 shell/precommands.js（写动作无条件动作审批，完全权限也不例外）。
// 域间依赖（analyzeDangerousCommand / runOnce / sessionPathKey）一律经 deps 注入。
// 条目行不用 .set-row 标记类——刻意不进设置树（设置树只暴露总开关一行，见 §7 决策 10）。

import {createInput, createSelect, createSwitch} from '../core/form-controls.js';
import {
    PRECMD_TIMEOUT_DEFAULT,
    PRECMD_TIMEOUT_MIN,
    PRECMD_TIMEOUT_MAX,
    PRECMD_EVENTS,
    PRECMD_MAX_TOTAL,
    PRECMD_MAX_PER_WS,
    normalizePreCommand,
    eventLabel,
    wsDisplayName,
    commandDigest,
} from '../core/precommands.js';

export function createSettingsPanePrecommands(deps) {

// 编辑器状态：null = 关闭；{id} = 编辑现有；{id: ''} = 新建
let editor = null;

function entriesOf() {
    return Array.isArray(deps.settings.preCommands) ? deps.settings.preCommands : [];
}

function wsKeyOf() {
    const ws = String(deps.getWorkspace() || '');
    return ws ? deps.sessionPathKey(ws) : '';
}

function persist() {
    deps.applySettings();
    renderPreCommandList();
}

// ---- 总开关（设置树行 id：precmd-enabled，risk=medium，AI 写入走动作审批）----

function setupMasterSwitch() {
    const control = document.getElementById('precmd-enabled');
    if (!control) return;
    control.checked = deps.settings.preCommandsEnabled !== false;
    control.addEventListener('change', () => {
        deps.settings.preCommandsEnabled = control.checked;
        deps.applySettings();
        deps.flash(control.checked ? '已启用预指令：打开工作区时自动执行' : '已停用预指令：打开工作区不再自动执行');
    });
}

// ---- 条目列表（动态行，不进设置树）----

function smallButton(label, className, onClick, tip) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'precmd-btn' + (className ? ' ' + className : '');
    btn.textContent = label;
    if (tip) btn.dataset.tip = tip;
    btn.addEventListener('click', onClick);
    return btn;
}

function renderPreCommandList() {
    const list = document.getElementById('precmd-list');
    if (!list) return;
    list.textContent = '';
    const wsKey = wsKeyOf();
    const entries = entriesOf();
    const mine = wsKey ? entries.filter((e) => String(e.ws || '') === wsKey) : [];
    if (!wsKey) {
        const empty = document.createElement('div');
        empty.className = 'fmt-hint';
        empty.textContent = '先打开一个文件夹：预指令绑定工作区，按工作区各自生效。';
        list.appendChild(empty);
        return;
    }
    if (!mine.length) {
        const empty = document.createElement('div');
        empty.className = 'fmt-hint';
        empty.textContent = '当前工作区还没有预指令，点「新建预指令…」创建。';
        list.appendChild(empty);
        return;
    }
    for (const entry of mine) {
        list.appendChild(buildPreCommandRow(entry, entries, wsKey));
    }
    if (editor && editor.id && !entries.some((e) => e && e.id === editor.id)) closePreCommandEditor();
}

function buildPreCommandRow(entry, entries, wsKey) {
    const row = document.createElement('div');
    row.className = 'precmd-row';

    const toggle = createSwitch({
        checked: entry.enabled !== false,
        onChange: () => {
            // 直接改存量条目，不走 normalize（不触碰命令文本）；origin 保持不变
            entry.enabled = toggle.control.checked;
            persist();
        },
    });
    row.appendChild(toggle.element);

    const preview = document.createElement('span');
    preview.className = 'precmd-cmd';
    preview.textContent = commandDigest(entry.command, 120);
    preview.dataset.tip = entry.command;
    row.appendChild(preview);

    const evTag = document.createElement('span');
    evTag.className = 'precmd-tag';
    evTag.textContent = eventLabel(entry.event);
    row.appendChild(evTag);

    if (entry.origin === 'ai') {
        const tag = document.createElement('span');
        tag.className = 'precmd-tag';
        tag.textContent = 'AI 配置';
        tag.dataset.tip = '该条目由 AI 写入并经你审批；你在本页保存过它会改回「用户配置」';
        row.appendChild(tag);
    }
    const verdict = typeof deps.analyzeDangerousCommand === 'function'
        ? deps.analyzeDangerousCommand(entry.command) : null;
    if (verdict && verdict.dangerous) {
        const danger = document.createElement('span');
        danger.className = 'precmd-danger';
        danger.textContent = '⚠ ' + (verdict.label || '危险命令');
        danger.dataset.tip = '命中危险命令规则（只提示，不拦截）：' + (verdict.segment || entry.command);
        row.appendChild(danger);
    }

    // 上移 / 下移：只在同工作区条目之间交换（全局数组里跳过别的工作区的条目）
    const siblings = entries
        .map((e, i) => ({e, i}))
        .filter((x) => String(x.e.ws || '') === wsKey);
    const pos = siblings.findIndex((x) => x.e.id === entry.id);
    row.appendChild(smallButton('↑', '', () => movePreCommand(siblings, pos, -1),
        pos > 0 ? '上移（执行顺序 = 列表顺序）' : '已经是第一条'));
    row.appendChild(smallButton('↓', '', () => movePreCommand(siblings, pos, 1),
        pos < siblings.length - 1 ? '下移（执行顺序 = 列表顺序）' : '已经是最后一条'));
    row.appendChild(smallButton('编辑', 'precmd-btn-edit', () => openPreCommandEditor(entry)));
    row.appendChild(smallButton('删除', 'precmd-btn-del', () => deletePreCommand(entry)));
    return row;
}

function movePreCommand(siblings, pos, delta) {
    const next = pos + delta;
    if (next < 0 || next >= siblings.length) return;
    const entries = entriesOf();
    const a = siblings[pos].i;
    const b = siblings[next].i;
    const tmp = entries[a];
    entries[a] = entries[b];
    entries[b] = tmp;
    deps.settings.preCommands = entries;
    persist();
}

function deletePreCommand(entry) {
    const doRemove = () => {
        deps.settings.preCommands = entriesOf().filter((e) => e.id !== entry.id);
        if (editor && editor.id === entry.id) closePreCommandEditor();
        persist();
        deps.flash('已删除预指令：' + commandDigest(entry.command, 40));
    };
    if (typeof deps.confirmAction === 'function') {
        deps.confirmAction('删除预指令「' + commandDigest(entry.command, 60) + '」？', doRemove, '删除', '删除预指令', 'danger');
    } else {
        doRemove();
    }
}

// ---- 新建 / 编辑（行内表单，控件走 core/form-controls 工厂）----

function editorRow(label, controlEl, hint) {
    const row = document.createElement('div');
    row.className = 'precmd-edit-row';
    const main = document.createElement('div');
    main.className = 'set-main';
    const title = document.createElement('div');
    title.className = 'set-title';
    title.textContent = label;
    main.appendChild(title);
    if (hint) {
        const d = document.createElement('div');
        d.className = 'set-desc';
        d.textContent = hint;
        main.appendChild(d);
    }
    const ctl = document.createElement('div');
    ctl.className = 'set-control';
    if (controlEl) ctl.appendChild(controlEl);
    row.append(main, ctl);
    return {row, ctl};
}

function closePreCommandEditor() {
    editor = null;
    const box = document.getElementById('precmd-editor');
    if (box) {
        box.textContent = '';
        box.classList.add('hidden');
    }
}

function openPreCommandEditor(entry) {
    editor = {id: entry ? entry.id : ''};
    const box = document.getElementById('precmd-editor');
    if (!box) return;
    box.textContent = '';
    box.classList.remove('hidden');
    const cmdIn = createInput({
        value: entry ? entry.command : '',
        placeholder: '例如：npm run dev（工作目录为该工作区根）',
        spellcheck: false, autocomplete: 'off',
    });
    cmdIn.element.style.flex = '1';
    cmdIn.element.style.minWidth = '0';
    const seconds = entry ? Math.round((entry.timeoutMs || PRECMD_TIMEOUT_DEFAULT) / 1000)
        : Math.round(PRECMD_TIMEOUT_DEFAULT / 1000);
    const timeoutIn = createInput({
        type: 'number', value: String(seconds),
        min: Math.round(PRECMD_TIMEOUT_MIN / 1000), max: Math.round(PRECMD_TIMEOUT_MAX / 1000), step: 1,
        onChange: () => {},
    });
    const eventSel = createSelect({
        options: PRECMD_EVENTS.map((ev) => ({value: ev, label: eventLabel(ev), selected: entry ? entry.event === ev : ev === 'workspace-open'})),
    });

    const actions = document.createElement('div');
    actions.className = 'precmd-edit-row';
    const ctl = document.createElement('div');
    ctl.className = 'set-control';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'dlg-btn';
    save.textContent = entry ? '保存修改' : '创建预指令';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dlg-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closePreCommandEditor);
    ctl.append(save, cancel);
    actions.appendChild(ctl);
    save.addEventListener('click', () => savePreCommandEditor({
        id: entry ? entry.id : '',
        command: cmdIn.control.value,
        timeoutMs: Math.round(Number(timeoutIn.control.value) || 0) * 1000,
        event: eventSel.control.value,
    }));

    box.append(
        editorRow('命令', cmdIn.element, '要特定 shell 直接写在命令里（如 powershell -Command …）').row,
        editorRow('时机', eventSel.element, '打开工作区：打开/切回时执行 · 关闭工作区：关闭或切走时执行 · AI 会话开始：空会话第一轮流起前执行（起轮等待跑完）').row,
        editorRow('超时（秒）', timeoutIn.element, '到点强制停止并记为失败；范围 1–600 秒').row,
        actions,
    );
    cmdIn.control.focus();
}

function savePreCommandEditor(form) {
    const command = String(form.command || '').trim();
    if (!command) {
        deps.flash('请填命令', true);
        return;
    }
    const event = PRECMD_EVENTS.includes(form.event) ? form.event : 'workspace-open';
    const entries = entriesOf();
    if (form.id) {
        const idx = entries.findIndex((e) => e && e.id === form.id);
        if (idx < 0) {
            deps.flash('该预指令已被删除', true);
            closePreCommandEditor();
            renderPreCommandList();
            return;
        }
        // 用户亲手保存 = 最后写入方，origin 归 'user'（AI 配置徽标随之消失）
        const norm = normalizePreCommand({command, timeoutMs: form.timeoutMs, event, origin: 'user'}, entries[idx]);
        if (!norm.ok) {
            deps.flash(norm.error, true);
            return;
        }
        deps.settings.preCommands = entries.map((e, i) => (i === idx ? norm.entry : e));
    } else {
        const wsKey = wsKeyOf();
        if (!wsKey) {
            deps.flash('先打开一个文件夹：预指令绑定工作区', true);
            return;
        }
        if (entries.length >= PRECMD_MAX_TOTAL) {
            deps.flash('预指令已达全局上限 ' + PRECMD_MAX_TOTAL + ' 条，请先删除不用的条目', true);
            return;
        }
        const mine = entries.filter((e) => String(e.ws || '') === wsKey);
        if (mine.length >= PRECMD_MAX_PER_WS) {
            deps.flash('当前工作区的预指令已达上限 ' + PRECMD_MAX_PER_WS + ' 条', true);
            return;
        }
        const norm = normalizePreCommand({command, timeoutMs: form.timeoutMs, event, ws: wsKey, origin: 'user'});
        if (!norm.ok) {
            deps.flash(norm.error, true);
            return;
        }
        deps.settings.preCommands = entries.concat([norm.entry]);
    }
    deps.applySettings();
    closePreCommandEditor();
    renderPreCommandList();
    deps.flash(form.id ? '已保存预指令' : '已创建预指令：' + commandDigest(command, 40));
}

// ---- 预跑一次（纯用户入口，不走审批；AI 没有对应动作，见 §7 决策 5）----

function setupActions() {
    const runNow = document.getElementById('precmd-run-now');
    if (runNow) {
        runNow.addEventListener('click', () => {
            if (!deps.getWorkspace()) {
                deps.flash('先打开一个文件夹：预指令绑定工作区', true);
                return;
            }
            deps.flash('已触发预指令执行（' + wsDisplayName(deps.getWorkspace()) + '），结果见状态栏消息中心');
            Promise.resolve(deps.runOnce()).catch((e) => {
                console.error('precmd: 预跑失败', e);
            });
        });
    }
    const newBtn = document.getElementById('precmd-new');
    if (newBtn) newBtn.addEventListener('click', () => openPreCommandEditor(null));
}

function renderPreCommandsPane() {
    const master = document.getElementById('precmd-enabled');
    if (master) master.checked = deps.settings.preCommandsEnabled !== false;
    renderPreCommandList();
}

setupMasterSwitch();
setupActions();
renderPreCommandList();

return {renderPreCommandsPane};
}
