// 设置页对话框族：遮罩/栈式关闭、关于、保存冲突、命名对话框，以及 confirmAction 访问器。
// 从 settings-ui.js 拆出；elsDialogs 与 openSettings 由宿主经 deps 注入。
export function createSettingsDialogs(deps) {

function openDialogEl(dlg, options) {
    const keepSettings = !!(options && options.keepSettings) &&
        dlg !== deps.elsDialogs.settings &&
        !deps.elsDialogs.settings.classList.contains('hidden');
    deps.elsDialogs.mask.classList.remove('hidden');
    if (!keepSettings) deps.elsDialogs.settings.classList.add('hidden');
    for (const other of [deps.elsDialogs.confirm, deps.elsDialogs.conflict, deps.elsDialogs.runDirty, deps.elsDialogs.runConfirm, deps.elsDialogs.name, deps.elsDialogs.goto, deps.elsDialogs.props, deps.elsDialogs.update, deps.elsDialogs.writing, deps.elsDialogs.writingName]) {
        if (other !== dlg) other.classList.add('hidden');
    }
    dlg.dataset.parentSettings = keepSettings ? '1' : '';
    dlg.style.left = '';
    dlg.style.top = '';
    dlg.style.transform = '';
    dlg.classList.remove('hidden');
    deps.syncAllBrowserTabs();
}

function closeTopDialog() {
    if (!deps.elsDialogs.settings.classList.contains('hidden')) {
            for (const dlg of [deps.elsDialogs.confirm, deps.elsDialogs.conflict, deps.elsDialogs.runDirty, deps.elsDialogs.runConfirm, deps.elsDialogs.name, deps.elsDialogs.goto, deps.elsDialogs.props, deps.elsDialogs.update, deps.elsDialogs.writing, deps.elsDialogs.writingName]) {
            if (dlg.classList.contains('hidden') || dlg.dataset.parentSettings !== '1') continue;
            dlg.classList.add('hidden');
            if (dlg === deps.elsDialogs.confirm) confirmAction = null;
            if (dlg === deps.elsDialogs.conflict) finishSaveConflict('cancel');
            if (dlg === deps.elsDialogs.name) {
                nameSubmit = null;
                nameBusy = false;
            }
            deps.syncAllBrowserTabs();
            return;
        }
    }
    closeDialogs();
}

function closeDialogs() {
    if (deps.aiPanel && typeof deps.aiPanel.closeModelEditor === 'function') {
        try { deps.aiPanel.closeModelEditor(false); } catch (e) {}
    }
    deps.elsDialogs.mask.classList.add('hidden');
    deps.elsDialogs.settings.classList.add('hidden');
    deps.elsDialogs.confirm.classList.add('hidden');
    if (saveConflictResolve) finishSaveConflict('cancel');
    deps.elsDialogs.conflict.classList.add('hidden');
    deps.elsDialogs.name.classList.add('hidden');
    deps.elsDialogs.goto.classList.add('hidden');
    deps.elsDialogs.props.classList.add('hidden');
    deps.elsDialogs.update.classList.add('hidden');
    deps.elsDialogs.writing.classList.add('hidden');
    deps.elsDialogs.writingName.classList.add('hidden');
    confirmAction = null;
    deps.syncAllBrowserTabs();
    nameSubmit = null;
    nameBusy = false;
}

function openAbout() {
    deps.openSettings('about');
}

let confirmAction = null;
// 保存冲突对话框的 Promise resolver：关闭对话框（按钮 / Esc / 遮罩）一律按取消处理
let saveConflictResolve = null;

function finishSaveConflict(choice) {
    const resolve = saveConflictResolve;
    saveConflictResolve = null;
    deps.elsDialogs.conflict.classList.add('hidden');
    if (!deps.elsDialogs.mask.classList.contains('hidden')) closeTopDialog();
    if (resolve) resolve(choice);
}

function openSaveConflictDialog(doc, deleted) {
    return new Promise((resolve) => {
        saveConflictResolve = resolve;
        const name = (doc && (doc.name || doc.path)) || '文件';
        deps.elsDialogs.conflictText.textContent = deleted
            ? '「' + name + '」已在磁盘上被删除或移动，但编辑器里还有未保存的修改。'
            : '「' + name + '」已被其他程序修改，但编辑器里还有未保存的修改。请选择如何处理：';
        deps.elsDialogs.conflictReload.disabled = !!deleted;
        openDialogEl(deps.elsDialogs.conflict);
    });
}

deps.elsDialogs.conflictReload.addEventListener('click', () => finishSaveConflict('reload'));
deps.elsDialogs.conflictOverwrite.addEventListener('click', () => finishSaveConflict('overwrite'));
deps.elsDialogs.conflictCancel.addEventListener('click', () => finishSaveConflict('cancel'));
let nameSubmit = null;
let nameBusy = false;

function openNameDialog(options) {
    const opts = options || {};
    deps.elsDialogs.nameTitle.textContent = opts.title || '名称';
    deps.elsDialogs.nameLabel.textContent = opts.label || '名称';
    deps.elsDialogs.nameInput.value = opts.value || '';
    deps.elsDialogs.nameInput.placeholder = opts.placeholder || '';
    deps.elsDialogs.nameError.textContent = '';
    deps.elsDialogs.nameError.classList.add('hidden');
    deps.elsDialogs.nameOk.textContent = opts.okLabel || '确定';
    nameSubmit = opts.onSubmit || null;
    nameBusy = false;
    openDialogEl(deps.elsDialogs.name, {keepSettings: true});
    setTimeout(() => {
        const input = deps.elsDialogs.nameInput;
        input.focus();
        const dot = input.value.lastIndexOf('.');
        if (opts.selectStem && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    }, 0);
}

function nameDialogError(message) {
    deps.elsDialogs.nameError.textContent = String(message || '');
    deps.elsDialogs.nameError.classList.remove('hidden');
}

async function submitNameDialog() {
    if (!nameSubmit || nameBusy) return;
    const value = deps.elsDialogs.nameInput.value;
    nameBusy = true;
    deps.elsDialogs.nameOk.disabled = true;
    deps.elsDialogs.nameError.classList.add('hidden');
    try {
        await nameSubmit(value);
        nameBusy = false;
        deps.elsDialogs.nameOk.disabled = false;
        closeTopDialog();
    } catch (e) {
        nameDialogError((e && e.message) || e);
        nameBusy = false;
        deps.elsDialogs.nameOk.disabled = false;
    }
}

deps.elsDialogs.nameOk.addEventListener('click', submitNameDialog);
document.getElementById('btn-name-cancel').addEventListener('click', closeTopDialog);
deps.elsDialogs.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitNameDialog();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTopDialog();
    }
});


function getConfirmAction() { return confirmAction; }
function setConfirmAction(v) { confirmAction = v; }

return {closeDialogs, closeTopDialog, getConfirmAction, openAbout, openDialogEl, openNameDialog,
        openSaveConflictDialog, setConfirmAction};
}
