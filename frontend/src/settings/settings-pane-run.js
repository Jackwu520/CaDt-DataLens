// 设置 → 运行：语言运行配置（增删改/模板）、自检与首次运行确认。
// 从 writing-ui.js 拆出；deps.LANG_DEFS 与 deps.flash 由宿主注入。
import {RECIPES, SELF_TEST} from '../terminal/run.js';

export function createSettingsPaneRun(deps) {

function renderRunProfiles() {
    const select = document.getElementById('run-profile-select');
    const list = document.getElementById('run-profile-list');
    const profiles = Array.isArray(deps.settings.runProfiles) ? deps.settings.runProfiles : [];
    if (select) {
        select.textContent = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = '默认配置';
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
        empty.textContent = '还没有保存的配置。';
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
        detail.textContent = [p.lang ? '[' + p.lang + ']' : '', p.args || '', p.template || '']
            .filter(Boolean).join('  ');
        detail.dataset.tip = detail.textContent;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'run-profile-del';
        del.textContent = '删除';
        del.addEventListener('click', () => deleteRunProfile(p.id));
        row.append(name, detail, del);
        list.appendChild(row);
    }
}

function applyRunProfile(id) {
    deps.settings.runActiveProfile = id || '';
    const profile = (deps.settings.runProfiles || []).find((p) => p.id === id);
    if (profile) {
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
    deps.applySettings();
    renderRunProfiles();
    renderRunPane();
    if (profile) deps.flash('已载入运行配置：' + profile.name);
}

function saveRunProfile() {
    const nameEl = document.getElementById('run-profile-name');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) {
        deps.flash('请填配置名称', true);
        return;
    }
    const lang = deps.runController.currentLang() || '';
    if (!lang) {
        deps.flash('先打开一个可运行的文件，再保存配置', true);
        return;
    }
    const argsEl = document.getElementById('run-args-input');
    const args = argsEl ? argsEl.value : deps.runArgsText(lang);
    const template = (deps.settings.runConfigs && deps.settings.runConfigs[lang]) || '';
    if (!Array.isArray(deps.settings.runProfiles)) deps.settings.runProfiles = [];
    const profile = {
        id: 'rp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name, lang, args, template,
    };
    deps.settings.runProfiles.push(profile);
    deps.settings.runActiveProfile = profile.id;
    if (nameEl) nameEl.value = '';
    deps.applySettings();
    renderRunProfiles();
    deps.flash('已保存运行配置：' + name);
}

function deleteRunProfile(id) {
    deps.settings.runProfiles = (deps.settings.runProfiles || []).filter((p) => p.id !== id);
    if (deps.settings.runActiveProfile === id) deps.settings.runActiveProfile = '';
    deps.applySettings();
    renderRunProfiles();
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
    const profileSave = document.getElementById('run-profile-save');
    const profileName = document.getElementById('run-profile-name');
    if (profileSelect) profileSelect.addEventListener('change', () => applyRunProfile(profileSelect.value));
    if (profileSave) profileSave.addEventListener('click', saveRunProfile);
    if (profileName) {
        profileName.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation();
            saveRunProfile();
        });
    }
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


return {applyRunProfile, deleteRunProfile, renderRunPane, renderRunProfiles, saveRunProfile, setupRunSettings};
}
