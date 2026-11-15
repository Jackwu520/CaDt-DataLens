// 设置 → 环境变量：列表渲染、行编辑、批量保存（含加密状态）。
// 从 writing-ui.js 拆出；deps.flash 由宿主注入。
export function createSettingsPaneEnvvars(deps) {

const ENVVAR_NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const envVarState = {vars: [], encrypted: false, supported: false};
let envEditorEditing = '';

async function renderEnvVarsPane() {
    const listEl = document.getElementById('envvar-list');
    if (!listEl) return;
    const sel = document.getElementById('envvar-encrypted');
    const hint = document.getElementById('envvar-storage-hint');
    let snap = {encrypted: false, supported: false, vars: []};
    try {
        snap = (await deps.backend.GetEnvVars()) || snap;
    } catch (e) {
        if (hint) hint.textContent = '读取环境变量失败：' + e;
    }
    envVarState.vars = Array.isArray(snap.vars) ? snap.vars : [];
    envVarState.encrypted = !!snap.encrypted;
    envVarState.supported = !!snap.supported;
    if (sel) {
        const encOpt = sel.querySelector('option[value="encrypted"]');
        if (encOpt) {
            encOpt.disabled = !envVarState.supported;
            encOpt.textContent = envVarState.supported ? 'DPAPI 加密（仅本机可解）' : 'DPAPI 加密（当前平台不支持）';
        }
        sel.value = envVarState.encrypted && envVarState.supported ? 'encrypted' : 'plain';
    }
    if (hint) {
        hint.textContent = envVarState.supported
            ? (envVarState.encrypted
                ? '当前：DPAPI 加密，绑定本机与当前用户，配置文件拷到别的机器也解不开。'
                : '当前：明文 JSON，可手动备份编辑；文件位于应用数据目录 env-vars.json。')
            : '当前：明文 JSON（本平台不支持 DPAPI 加密）。';
    }
    listEl.textContent = '';
    if (!envVarState.vars.length) {
        const empty = document.createElement('div');
        empty.className = 'envvar-empty';
        empty.textContent = '还没有环境变量。点「新增变量」添加 API key 等私密值；之后新开的终端会话与命令桥命令都会注入它们。';
        listEl.appendChild(empty);
        return;
    }
    for (const v of envVarState.vars) {
        listEl.appendChild(buildEnvVarRow(v));
    }
}

function buildEnvVarRow(v) {
    const row = document.createElement('div');
    row.className = 'envvar-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'envvar-name';
    nameEl.textContent = v.name;
    const descEl = document.createElement('span');
    descEl.className = 'envvar-desc';
    descEl.textContent = v.description || '（无描述）';
    descEl.dataset.tip = v.description || '';
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'popover-label envvar-enabled';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!v.enabled;
    cb.addEventListener('change', async () => {
        try {
            await saveEnvVarsAll(envVarState.vars.map((item) => (
                item.name === v.name ? {...item, enabled: cb.checked} : item
            )));
        } catch (e) {
            deps.flash('切换失败：' + e, true);
            renderEnvVarsPane();
        }
    });
    enabledLabel.append(cb, document.createTextNode('注入'));
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'dlg-btn';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => openEnvVarEditor(v.name));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dlg-btn envvar-del';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
        if (!del.dataset.armed) {
            del.dataset.armed = '1';
            del.textContent = '确认删除？';
            del.classList.add('danger');
            setTimeout(() => {
                if (del.isConnected) {
                    del.dataset.armed = '';
                    del.textContent = '删除';
                    del.classList.remove('danger');
                }
            }, 3000);
            return;
        }
        try {
            await saveEnvVarsAll(envVarState.vars.filter((item) => item.name !== v.name));
            deps.flash('已删除环境变量：' + v.name);
        } catch (e) {
            deps.flash('删除失败：' + e, true);
        }
    });
    row.append(nameEl, descEl, enabledLabel, editBtn, del);
    return row;
}

async function saveEnvVarsAll(vars) {
    await deps.backend.SetEnvVars((vars || []).map((v) => ({
        name: v.name,
        value: v.value,
        description: v.description || '',
        enabled: !!v.enabled,
    })));
    await renderEnvVarsPane();
}

function showEnvEditorError(message) {
    const errorEl = document.getElementById('env-opt-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
}

function closeEnvVarEditor() {
    const dlg = document.getElementById('dlg-env-editor');
    const mask = document.getElementById('dlg-env-editor-mask');
    if (dlg) dlg.classList.add('hidden');
    if (mask) mask.classList.add('hidden');
    envEditorEditing = '';
    showEnvEditorError('');
    const input = document.getElementById('env-opt-value');
    const toggle = document.getElementById('env-opt-value-toggle');
    if (input) input.type = 'password';
    if (toggle) toggle.textContent = '显示';
}

function openEnvVarEditor(name) {
    const dlg = document.getElementById('dlg-env-editor');
    if (!dlg) return;
    const mask = document.getElementById('dlg-env-editor-mask');
    envEditorEditing = envVarState.vars.some((v) => v.name === name) ? name : '';
    const existing = envEditorEditing
        ? envVarState.vars.find((v) => v.name === envEditorEditing)
        : null;
    const title = document.getElementById('dlg-env-title');
    const nameInput = document.getElementById('env-opt-name');
    const descInput = document.getElementById('env-opt-desc');
    const valueInput = document.getElementById('env-opt-value');
    const enabledInput = document.getElementById('env-opt-enabled');
    const warn = document.getElementById('env-opt-name-warn');
    if (title) title.textContent = existing ? '编辑变量：' + existing.name : '新增变量';
    if (nameInput) nameInput.value = existing ? existing.name : '';
    if (descInput) descInput.value = existing ? (existing.description || '') : '';
    if (valueInput) valueInput.value = existing ? (existing.value || '') : '';
    if (enabledInput) enabledInput.checked = existing ? !!existing.enabled : true;
    if (warn) warn.classList.toggle('hidden', !existing || existing.name.toUpperCase() !== 'PATH');
    showEnvEditorError('');
    if (valueInput) valueInput.type = 'password';
    const toggle = document.getElementById('env-opt-value-toggle');
    if (toggle) toggle.textContent = '显示';
    if (mask) mask.classList.remove('hidden');
    dlg.classList.remove('hidden');
    setTimeout(() => {
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }, 50);
}

async function saveEnvVarEditor() {
    const nameInput = document.getElementById('env-opt-name');
    const descInput = document.getElementById('env-opt-desc');
    const valueInput = document.getElementById('env-opt-value');
    const enabledInput = document.getElementById('env-opt-enabled');
    if (!nameInput || !valueInput) return;
    const name = String(nameInput.value || '').trim();
    if (!ENVVAR_NAME_RULE.test(name)) {
        showEnvEditorError('名称无效：字母/数字/下划线，字母或下划线开头，最长 128 字符');
        nameInput.focus();
        return;
    }
    const dup = envVarState.vars.some((v) => v.name === name && v.name !== envEditorEditing);
    if (dup) {
        showEnvEditorError('已存在同名变量：' + name);
        nameInput.focus();
        return;
    }
    const entry = {
        name,
        value: String(valueInput.value || ''),
        description: String((descInput && descInput.value) || '').trim(),
        enabled: !!(enabledInput && enabledInput.checked),
    };
    const list = envEditorEditing
        ? envVarState.vars.map((v) => (v.name === envEditorEditing ? entry : v))
        : envVarState.vars.concat([entry]);
    const wasEditing = envEditorEditing;
    try {
        await deps.backend.SetEnvVars(list);
        closeEnvVarEditor();
        deps.flash((wasEditing ? '已保存环境变量：' : '已新增环境变量：') + name);
        await renderEnvVarsPane();
    } catch (e) {
        showEnvEditorError(String(e));
    }
}

function setupEnvVarsSettings() {
    const addBtn = document.getElementById('envvar-add');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => openEnvVarEditor(''));
    const saveBtn = document.getElementById('dlg-env-save');
    if (saveBtn) saveBtn.addEventListener('click', saveEnvVarEditor);
    const cancelBtn = document.getElementById('dlg-env-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEnvVarEditor);
    const closeBtn = document.getElementById('dlg-env-editor-close');
    if (closeBtn) closeBtn.addEventListener('click', closeEnvVarEditor);
    const mask = document.getElementById('dlg-env-editor-mask');
    if (mask) mask.addEventListener('click', closeEnvVarEditor);
    // 捕获阶段拦截 Esc：编辑器开着时只关编辑器，不动背后的设置窗口
    // （main.js 的全局 Esc 走 window capture，这里必须同样挂 window capture 且先注册才能拦住）
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const dlg = document.getElementById('dlg-env-editor');
        if (!dlg || dlg.classList.contains('hidden')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        closeEnvVarEditor();
    }, true);
    const valueToggle = document.getElementById('env-opt-value-toggle');
    if (valueToggle) {
        valueToggle.addEventListener('click', () => {
            const input = document.getElementById('env-opt-value');
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            valueToggle.textContent = show ? '隐藏' : '显示';
        });
    }
    const nameInput = document.getElementById('env-opt-name');
    if (nameInput) {
        nameInput.addEventListener('input', () => {
            const warn = document.getElementById('env-opt-name-warn');
            if (warn) warn.classList.toggle('hidden', nameInput.value.trim().toUpperCase() !== 'PATH');
        });
    }
    const sel = document.getElementById('envvar-encrypted');
    if (sel) {
        sel.addEventListener('change', async () => {
            try {
                await deps.backend.SetEnvVarEncrypted(sel.value === 'encrypted');
                deps.flash(sel.value === 'encrypted' ? '已切换为 DPAPI 加密存储' : '已切换为明文存储');
            } catch (e) {
                deps.flash('切换存储方式失败：' + e, true);
            }
            renderEnvVarsPane();
        });
    }
}

setupEnvVarsSettings();


return {renderEnvVarsPane, setupEnvVarsSettings};
}
