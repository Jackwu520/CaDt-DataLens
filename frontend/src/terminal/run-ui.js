// 运行代码（F5）接线：编辑器/设置/对话框这些宿主能力在此汇聚，配方与输出渲染在 run.js。
// 从 terminal-ui.js 拆出；toggleTerminalPanel / toggleDockView 由宿主经 deps 注入。
import {activeRunConfig, createRunController, splitRunArgs} from './run.js';
import {isDocReadOnly} from '../core/readonly.js';

export function createRunUI(deps) {

// ---- 运行代码（F5）----
// 语言配方与输出渲染在 src/run.js；这里只提供「编辑器 / 设置 / 对话框」这些宿主能力。

let runDirtyResolve = null;
let runConfirmResolve = null;

// 当前文档的文本（与插件 runtime 的 getActiveText 同源，按视图取正确的那份）
function activeDocText() {
    if (!deps.file) return '';
    if (deps.currentMode === 'code' && deps.editor && deps.editor.aceEditor) return deps.editor.aceEditor.getValue();
    if (deps.currentMode === 'tree' && deps.editor && deps.file.format && typeof deps.file.format.stringify === 'function') {
        try {
            return deps.file.format.stringify(deps.editor.get());
        } catch (e) {
            return '';
        }
    }
    const ta = deps.textArea();
    if (ta) return ta.value;
    return deps.file.binary ? '' : (deps.file.content || '');
}

function finishRunDirty(choice) {
    const resolve = runDirtyResolve;
    runDirtyResolve = null;
    const remember = !!(deps.elsDialogs.runDirtyRemember && deps.elsDialogs.runDirtyRemember.checked);
    if (remember && (choice === 'save' || choice === 'temp')) {
        deps.settings.runDirtyMode = choice;
        deps.applySettings();
    }
    if (deps.elsDialogs.runDirtyRemember) deps.elsDialogs.runDirtyRemember.checked = false;
    deps.closeTopDialog();
    if (resolve) resolve(choice);
}

function finishRunConfirm(ok) {
    const resolve = runConfirmResolve;
    runConfirmResolve = null;
    deps.closeTopDialog();
    if (resolve) resolve(!!ok);
}

// 未保存修改的处理：设置里固定的模式直接返回，否则弹三选一
function askRunDirty(info) {
    return new Promise((resolve) => {
        if (deps.settings.runDirtyMode === 'temp') {
            resolve('temp');
            return;
        }
        if (deps.settings.runDirtyMode === 'save') {
            resolve(info.canSave ? 'save' : 'temp');
            return;
        }
        deps.elsDialogs.runDirtyText.textContent = info.canSave
            ? ('「' + (info.name || '当前文件') + '」有未保存的修改，运行前怎么处理？')
            : ('「' + (info.name || '当前文件') + '」还没有保存到磁盘，只能用临时副本运行。');
        deps.elsDialogs.runDirtySave.disabled = !info.canSave;
        runDirtyResolve = resolve;
        deps.openDialogEl(deps.elsDialogs.runDirty, {keepSettings: true});
    });
}

// 首次运行某种语言：明示风险，确认后记住
function confirmRunOnce(label) {
    return new Promise((resolve) => {
        deps.elsDialogs.runConfirmText.textContent =
            '将以你的 Windows 账户权限在本机执行 ' + label + ' 代码。只运行你自己写的或可信的文件。';
        runConfirmResolve = resolve;
        deps.openDialogEl(deps.elsDialogs.runConfirm, {keepSettings: true});
    });
}

if (deps.elsDialogs.runDirtySave) {
    deps.elsDialogs.runDirtySave.addEventListener('click', () => finishRunDirty('save'));
    deps.elsDialogs.runDirtyTemp.addEventListener('click', () => finishRunDirty('temp'));
    deps.elsDialogs.runDirtyCancel.addEventListener('click', () => finishRunDirty('cancel'));
    const closeBtn = deps.elsDialogs.runDirty.querySelector('.dialog-close');
    if (closeBtn) closeBtn.addEventListener('click', () => finishRunDirty('cancel'));
}
if (deps.elsDialogs.runConfirmOk) {
    deps.elsDialogs.runConfirmOk.addEventListener('click', () => finishRunConfirm(true));
    deps.elsDialogs.runConfirmCancel.addEventListener('click', () => finishRunConfirm(false));
    const closeBtn = deps.elsDialogs.runConfirm.querySelector('.dialog-close');
    if (closeBtn) closeBtn.addEventListener('click', () => finishRunConfirm(false));
}

// 工具链：优先用设置里缓存的扫描结果，没扫过就现场扫一次
async function ensureToolchainForRun(langId, toolId) {
    let eff = deps.effectiveToolEnv(langId, toolId);
    if (eff && eff.ok && eff.path) return eff;
    const env = deps.toolEnvFor(langId, toolId);
    if (!env.scannedAt) {
        try {
            const res = deps.backend.DetectToolchain ? await deps.backend.DetectToolchain(toolId, env.pathOverride || '') : null;
            const list = res && Array.isArray(res.envs) ? res.envs : [];
            env.envs = list;
            env.scannedAt = Date.now();
            env.error = list.length ? '' : ((res && res.error) || '未找到可用环境');
            deps.applySettings();
        } catch (e) {
            env.error = (e && e.message) || String(e);
        }
        eff = deps.effectiveToolEnv(langId, toolId);
    }
    return eff && eff.ok && eff.path ? eff : null;
}

// 从运行输出里点位置引用 → 打开（或切到）对应文件的对应行列
async function openDocAtLocation(path, line, column) {
    if (!path) return;
    let doc = deps.findDocByPath(path);
    if (!doc) {
        await deps.openPathsHere([path]);
        doc = deps.findDocByPath(path);
    }
    if (!doc) {
        deps.flash('打不开：' + path, true);
        return;
    }
    await deps.selectLineInDoc(doc, line, column);
}

// 运行参数：按语言记住输入框原文（回显用），执行时才拆成 argv。
// 输入过程中只改内存并防抖落盘，避免每个字符都重同步整份设置。
function runArgsText(langId) {
    const value = deps.settings.runArgs && deps.settings.runArgs[langId];
    if (Array.isArray(value)) return value.join(' '); // 兼容早期按数组存的写法
    return typeof value === 'string' ? value : '';
}
let runArgsSaveTimer = 0;
function setRunArgs(langId, text) {
    if (!deps.settings.runArgs || typeof deps.settings.runArgs !== 'object') deps.settings.runArgs = {};
    if (runArgsText(langId) === text) return;
    deps.settings.runArgs[langId] = text;
    clearTimeout(runArgsSaveTimer);
    runArgsSaveTimer = setTimeout(deps.applySettings, 400);
}

const runController = createRunController({
    backend: deps.backend,
    onEvent: (name, cb) => {
        if (deps.rt && deps.rt.EventsOn) deps.rt.EventsOn(name, cb);
    },
    getActiveDoc: () => (deps.file ? {
        path: deps.file.path || '',
        name: deps.file.name || '',
        dirty: !!deps.file.dirty,
        binary: !!deps.file.binary,
        large: !!deps.file.large,
        formatId: deps.file.format ? deps.file.format.id : '',
    } : null),
    getDocText: () => activeDocText(),
    saveDoc: () => deps.saveDoc(deps.file, {silent: true}),
    isReadOnly: () => isDocReadOnly(deps.file, deps.settings),
    flash: deps.flash,
    askDirtyChoice: (info) => askRunDirty(info),
    hasConfirmed: (lang) => (deps.settings.runConfirmSeen || []).includes(lang),
    confirmRun: async (label, lang) => {
        const ok = await confirmRunOnce(label);
        if (ok && !deps.settings.runConfirmSeen.includes(lang)) {
            deps.settings.runConfirmSeen.push(lang);
            deps.applySettings();
        }
        return ok;
    },
    openLocation: (path, line, column) => openDocAtLocation(path, line, column),
    ensureToolchain: (langId, toolId) => ensureToolchainForRun(langId, toolId),
    copyText: (text, label) => deps.copyText(text, label),
    logActivity: (name, meta) => deps.activityLog.log('code.run', name, meta),
    askAI: (text) => deps.openAIPanelWithDraft(text),
    argsFor: (langId) => splitRunArgs(runArgsText(langId)),
    argsText: (langId) => runArgsText(langId),
    setArgs: (langId, text) => setRunArgs(langId, text),
    templateFor: (langId, override) => {
        // 绑定文件的配置自带命令模板：非空覆盖优先，否则回落该语言的模板（settings.runConfigs）
        const picked = typeof override === 'string' && override.trim() ? override
            : (deps.settings.runConfigs && deps.settings.runConfigs[langId]);
        return typeof picked === 'string' ? picked.trim() : '';
    },
    // 绑定文件的配置：运行目标由 settings.runActiveProfile 决定（activeRunConfig 纯函数在 run.js）
    activeRunConfig: () => activeRunConfig(deps.settings),
    readRunFile: async (path) => deps.backend.OpenFile(path, ''),
    samePathValue: (a, b) => (deps.samePathValue ? deps.samePathValue(a, b) : String(a) === String(b)),
    openDocDirtyByPath: (path) => (deps.openDocDirtyByPath ? deps.openDocDirtyByPath(path) : false),
    // 「最近的配置」口径：run() 校验全过后回调，绑定/旧预设配置都记 lastUsedAt
    onRunStart: (lang, cfg) => {
        if (deps.touchRunProfileRecency && cfg) deps.touchRunProfileRecency(cfg);
    },
    resolveWorkDir: (fallback) => (deps.settings.runCwd === 'workspace' && deps.workspaceFolder ? deps.workspaceFolder : fallback),
    // 运行超时（毫秒）：0 / 未配置 = 不限时；默认关（settings.runTimeoutMs 缺省即 0）
    runTimeoutMs: () => Math.max(0, Math.round(Number(deps.settings.runTimeoutMs) || 0)),
    showRunPanel: () => deps.toggleDockView('run'),
    hidePanel: () => deps.toggleTerminalPanel(false),
});

// Ctrl+F5：探测当前文件 / 工作区所属项目，把候选命令列在面板里由用户确认后执行
async function startRunProject() {
    const path = (deps.file && deps.file.path) || deps.workspaceFolder || '';
    if (!path) {
        deps.flash('先打开一个文件或工作区', true);
        return;
    }
    let info;
    try {
        info = await deps.backend.DetectRunProject(path);
    } catch (e) {
        deps.flash('项目探测失败：' + ((e && e.message) || e), true);
        return;
    }
    if (!info || !info.commands || !info.commands.length) {
        deps.flash((info && info.note) || '没有可运行的项目命令', true);
        return;
    }
    runController.showProjectChoice(info);
}

// 首次确认按语言 id 记录（run.js 里传 label + lang）
runController.mount();

return {activeDocText, runArgsText, runController, setRunArgs, startRunProject};
}
