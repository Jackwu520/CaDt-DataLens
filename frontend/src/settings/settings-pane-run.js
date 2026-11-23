// 设置 → 运行：语言运行配置（绑定文件的管理/编辑、模板）、自检与首次运行确认。
// 从 writing-ui.js 拆出；deps.LANG_DEFS 与 deps.flash 由宿主注入。
// 配置语义：带 file 的绑定目标文件（标题栏 ▶ / F5 直接运行那个文件），不带的为旧版参数预设。
import {RECIPES, SELF_TEST, configRowSubtitle, extOf} from '../terminal/run.js';
import {createInput} from '../core/form-controls.js';
import {newId} from '../core/id.js';

export function createSettingsPaneRun(deps) {

// 配置编辑器状态：null = 关闭；{id} = 编辑现有；{id: ''} = 新建
let profileEditor = null;

function profilesOf() {
    return Array.isArray(deps.settings.runProfiles) ? deps.settings.runProfiles : [];
}

function renderRunProfiles() {
    const select = document.getElementById('run-profile-select');
    const list = document.getElementById('run-profile-list');
    const profiles = profilesOf();
    if (select) {
        select.textContent = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = '当前文件';
        select.appendChild(def);
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
        const active = deps.settings.runActiveProfile || '';
        select.value = profiles.some((p) => p.id === active) ? active : '';
    }
    if (!list) return;
    list.textContent = '';
    if (!profiles.length) {
        const empty = document.createElement('div');
        empty.className = 'fmt-hint';
        empty.textContent = '还没有保存的配置，点「新建配置…」创建。';
        list.appendChild(empty);
        return;
    }
    for (const p of profiles) {
        const row = document.createElement('div');
        row.className = 'run-profile-row';
        const name = document.createElement('span');
        name.className = 'run-profile-name';
        name.textContent = p.name;
        const detail = document.createElement('span');
        detail.className = 'run-profile-detail';
        detail.textContent = [configRowSubtitle(p), p.args || '', p.template || '']
            .filter(Boolean).join('  ');
        detail.dataset.tip = detail.textContent;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'run-profile-edit';
        edit.textContent = '编辑';
        edit.addEventListener('click', () => openProfileEditor(p));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'run-profile-del';
        del.textContent = '删除';
        del.addEventListener('click', () => deleteRunProfile(p.id));
        row.append(name, detail, edit, del);
        list.appendChild(row);
    }
}

function applyRunProfile(id) {
    deps.settings.runActiveProfile = id || '';
    const profile = profilesOf().find((p) => p && p.id === id) || null;
    if (profile && !profile.file) {
        // 旧版参数预设：写回语言桶（面板输入框随之回显）
        const lang = deps.runController.currentLang() || '';
        if (lang) {
            if (typeof profile.args === 'string') deps.settings.runArgs[lang] = profile.args;
            if (profile.template) deps.settings.runConfigs[lang] = profile.template;
            const tplLang = document.getElementById('run-template-lang');
            if (tplLang && [...tplLang.options].some((o) => o.value === lang)) tplLang.value = lang;
            const input = document.getElementById('run-args-input');
            if (input && typeof profile.args === 'string') input.value = profile.args;
        }
    }
    // 绑定文件的配置不写语言桶：参数/模板在运行时直接取自配置本身（run.js）
    deps.applySettings();
    renderRunProfiles();
    renderRunPane();
    if (profile) deps.flash((profile.file ? '已切换运行配置：' : '已载入运行配置：') + profile.name);
    if (deps.syncRunConfigWidget) deps.syncRunConfigWidget();
}

function deleteRunProfile(id) {
    deps.settings.runProfiles = profilesOf().filter((p) => p.id !== id);
    if (deps.settings.runActiveProfile === id) deps.settings.runActiveProfile = '';
    if (profileEditor && profileEditor.id === id) closeProfileEditor();
    deps.applySettings();
    renderRunProfiles();
    if (deps.syncRunConfigWidget) deps.syncRunConfigWidget();
}

// ---- 配置编辑器（行内表单，动态控件走 core/form-controls 工厂） ----

function editorRow(label, controlEl, hint) {
    const row = document.createElement('div');
    row.className = 'set-row';
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

function editorActions(saveLabel) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const ctl = document.createElement('div');
    ctl.className = 'set-control';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'dlg-btn';
    save.textContent = saveLabel;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dlg-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeProfileEditor);
    ctl.append(save, cancel);
    row.appendChild(ctl);
    return {row, save};
}

function closeProfileEditor() {
    profileEditor = null;
    const box = document.getElementById('run-profile-editor');
    if (box) {
        box.textContent = '';
        box.classList.add('hidden');
    }
}

function openProfileEditor(profile) {
    profileEditor = {id: profile ? profile.id : ''};
    const box = document.getElementById('run-profile-editor');
    if (!box) return;
    box.textContent = '';
    box.classList.remove('hidden');
    const lang0 = profile ? (profile.lang || '') : (deps.runController.currentLang() || '');
    const nameIn = createInput({value: profile ? profile.name : '', placeholder: '配置名称，例如：跑后端脚本', spellcheck: false, autocomplete: 'off'});
    const fileIn = createInput({value: (profile && profile.file) || '', placeholder: '留空 = 参数预设（作用于当前文件）', spellcheck: false, autocomplete: 'off'});
    const argsIn = createInput({value: profile ? (profile.args || '') : (lang0 ? deps.runArgsText(lang0) : ''), placeholder: '传给脚本的参数，例如：--verbose', spellcheck: false, autocomplete: 'off'});
    const tplIn = createInput({
        value: profile ? (profile.template || '') : ((lang0 && deps.settings.runConfigs && deps.settings.runConfigs[lang0]) || ''),
        placeholder: '留空使用默认命令 / 语言模板',
        spellcheck: false, autocomplete: 'off',
    });

    const fileRow = editorRow('目标文件', null, '绑定后：选中配置时标题栏 ▶ / F5 直接运行这个文件');
    fileIn.element.style.flex = '1';
    fileIn.element.style.minWidth = '0';
    const browse = document.createElement('button');
    browse.type = 'button';
    browse.className = 'dlg-btn';
    browse.textContent = '浏览…';
    browse.addEventListener('click', async () => {
        if (!deps.backend.ShowOpenFileDialog) {
            deps.flash('当前版本不支持选择文件', true);
            return;
        }
        try {
            const picked = await deps.backend.ShowOpenFileDialog('选择配置目标文件', '');
            if (picked) fileIn.control.value = picked;
        } catch (e) {
            deps.flash('选择文件失败：' + ((e && e.message) || e), true);
        }
    });
    fileRow.ctl.append(fileIn.element, browse);

    const actions = editorActions(profile ? '保存修改' : '创建配置');
    actions.save.addEventListener('click', () => saveProfileEditor({
        id: profileEditor ? profileEditor.id : '',
        name: nameIn.control.value,
        file: fileIn.control.value,
        args: argsIn.control.value,
        template: tplIn.control.value,
    }));

    box.append(
        editorRow('名称', nameIn.element).row,
        fileRow.row,
        editorRow('运行参数', argsIn.element).row,
        editorRow('命令模板', tplIn.element, '完整命令行，占位符 $TOOL/$FILE/$ARGS 等，与「命令模板」组一致').row,
        actions.row,
    );
    nameIn.control.focus();
}

function saveProfileEditor(form) {
    const name = String(form.name || '').trim();
    if (!name) {
        deps.flash('请填配置名称', true);
        return;
    }
    const file = String(form.file || '').trim();
    let lang = '';
    if (file) {
        lang = (RECIPES[extOf(file)] || {}).lang || '';
        if (!lang) {
            deps.flash('该文件类型不支持运行：' + file, true);
            return;
        }
    }
    if (!file) {
        // 旧版参数预设需要语言归属：编辑沿用原值，新建取当前活动任务语言
        const prev = profilesOf().find((p) => p.id === form.id);
        lang = (prev && prev.lang) || deps.runController.currentLang() || '';
        if (!lang) {
            deps.flash('先打开一个可运行的文件，或给配置绑定目标文件', true);
            return;
        }
    }
    let profiles = profilesOf();
    let savedId = form.id;
    if (form.id) {
        profiles = profiles.map((p) => (p.id === form.id ? {...p, name, file, lang, args: form.args, template: form.template.trim()} : p));
        deps.settings.runProfiles = profiles;
    } else {
        savedId = newId('rp-', {sep: '-', suffixLength: 4});
        deps.settings.runProfiles = profiles.concat([{
            id: savedId,
            name, file, lang,
            args: form.args,
            template: form.template.trim(),
        }]);
    }
    deps.settings.runActiveProfile = savedId;
    deps.applySettings();
    closeProfileEditor();
    renderRunProfiles();
    renderRunPane();
    if (deps.syncRunConfigWidget) deps.syncRunConfigWidget();
    deps.flash((form.id ? '已保存运行配置：' : '已创建运行配置：') + name);
}

let runTemplateSaveTimer = 0;
setupRunSettings();

// 设置 → 运行：工作目录、未保存修改策略、首次确认与临时目录
function setupRunSettings() {
    const cwd = document.getElementById('run-cwd');
    const dirtyMode = document.getElementById('run-dirty-mode');
    const timeout = document.getElementById('run-timeout');
    const reset = document.getElementById('run-confirm-reset');
    const openTemp = document.getElementById('run-open-temp');
    const templateLang = document.getElementById('run-template-lang');
    const templateInput = document.getElementById('run-template-input');
    const selfTestLang = document.getElementById('run-selftest-lang');
    const selfTestBtn = document.getElementById('run-selftest');
    if (cwd) {
        cwd.addEventListener('change', () => {
            deps.settings.runCwd = cwd.value === 'workspace' ? 'workspace' : 'file';
            deps.applySettings();
        });
    }
    if (dirtyMode) {
        dirtyMode.addEventListener('change', () => {
            deps.settings.runDirtyMode = ['ask', 'save', 'temp'].includes(dirtyMode.value) ? dirtyMode.value : 'ask';
            deps.applySettings();
        });
    }
    if (timeout) {
        timeout.addEventListener('change', () => {
            // 档位白名单：0 = 关闭（不限时），非法值一律回落 0
            const v = Math.round(Number(timeout.value));
            deps.settings.runTimeoutMs = [0, 30000, 60000, 120000, 300000, 600000, 1800000].includes(v) ? v : 0;
            deps.applySettings();
            renderRunPane();
        });
    }
    if (reset) {
        reset.addEventListener('click', () => {
            deps.settings.runConfirmSeen = [];
            deps.applySettings();
            renderRunPane();
            deps.flash('已重置，每种语言下次运行会再提示一次');
        });
    }
    if (openTemp) {
        openTemp.addEventListener('click', async () => {
            try {
                const dir = await deps.backend.GetRunTempDir();
                await deps.backend.ShowInFolder(dir);
            } catch (e) {
                deps.flash('打开临时目录失败：' + e, true);
            }
        });
    }

    // 命令模板按语言覆盖（同一语言的多个扩展名共用一份）
    if (templateLang) {
        const seen = new Map();
        for (const recipe of Object.values(RECIPES)) {
            if (!seen.has(recipe.lang)) seen.set(recipe.lang, recipe.label);
        }
        for (const [id, label] of seen) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            templateLang.appendChild(opt);
        }
        templateLang.addEventListener('change', renderRunPane);
    }
    if (templateInput) {
        templateInput.addEventListener('input', () => {
            const lang = templateLang ? templateLang.value : '';
            if (!lang) return;
            if (!deps.settings.runConfigs || typeof deps.settings.runConfigs !== 'object') deps.settings.runConfigs = {};
            deps.settings.runConfigs[lang] = templateInput.value;
            clearTimeout(runTemplateSaveTimer);
            runTemplateSaveTimer = setTimeout(deps.applySettings, 400);
        });
    }
    if (selfTestLang) {
        for (const ext of Object.keys(SELF_TEST)) {
            const recipe = RECIPES[ext];
            if (!recipe) continue;
            const opt = document.createElement('option');
            opt.value = ext;
            opt.textContent = recipe.label + ' (.' + ext + ')';
            selfTestLang.appendChild(opt);
        }
    }
    if (selfTestBtn) {
        selfTestBtn.addEventListener('click', () => {
            if (selfTestLang && selfTestLang.value) deps.runController.selfTest(selfTestLang.value);
        });
    }
    const profileSelect = document.getElementById('run-profile-select');
    const profileNew = document.getElementById('run-profile-new');
    if (profileSelect) profileSelect.addEventListener('change', () => applyRunProfile(profileSelect.value));
    if (profileNew) profileNew.addEventListener('click', () => openProfileEditor(null));
    renderRunProfiles();
}

function renderRunPane() {
    const cwd = document.getElementById('run-cwd');
    const dirtyMode = document.getElementById('run-dirty-mode');
    const timeout = document.getElementById('run-timeout');
    const timeoutHint = document.getElementById('run-timeout-hint');
    const hint = document.getElementById('run-confirm-hint');
    const tempHint = document.getElementById('run-temp-hint');
    const templateLang = document.getElementById('run-template-lang');
    const templateInput = document.getElementById('run-template-input');
    if (cwd) cwd.value = deps.settings.runCwd;
    if (dirtyMode) dirtyMode.value = deps.settings.runDirtyMode;
    if (timeout) {
        const v = Math.round(Number(deps.settings.runTimeoutMs) || 0);
        const known = [0, 30000, 60000, 120000, 300000, 600000, 1800000].includes(v);
        timeout.value = String(known ? v : 0);
    }
    if (timeoutHint) {
        const v = Math.round(Number(deps.settings.runTimeoutMs) || 0);
        timeoutHint.textContent = v > 0
            ? ('超过 ' + (v % 60000 === 0 ? (v / 60000) + ' 分钟' : Math.round(v / 1000) + ' 秒') + ' 强制停止并提示')
            : '默认关闭，不限制运行时长';
    }
    if (templateLang && templateInput) {
        templateInput.value = (deps.settings.runConfigs && deps.settings.runConfigs[templateLang.value]) || '';
    }
    if (hint) {
        const seen = deps.settings.runConfirmSeen || [];
        hint.textContent = seen.length
            ? ('已确认 ' + seen.length + ' 种语言：' + seen.join('、'))
            : '尚未确认任何语言，首次运行会出现提示。';
    }
    if (tempHint && deps.backend.GetRunTempDir) {
        deps.backend.GetRunTempDir().then((dir) => {
            tempHint.textContent = dir;
        }).catch((e) => {
            tempHint.textContent = '读取失败：' + ((e && e.message) || e);
        });
    }
    renderRunProfiles();
}


return {applyRunProfile, deleteRunProfile, renderRunPane, renderRunProfiles, setupRunSettings};
}
