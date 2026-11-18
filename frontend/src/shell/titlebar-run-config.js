// titlebar-run-config.js：标题栏运行配置 widget 与下拉弹层（对齐 JetBrains 运行区：
// [配置名/文件名 + 展开箭头] + 运行 ▶）。从 titlebar-popovers.js 挂载的第三个弹层兄弟模块；
// 配置模型纯函数（activeRunConfig / recentConfigs 等）在 terminal/run.js，此处只做 UI 与接线。
import {activeRunConfig, configRowSubtitle, recentConfigs, resolveRunWidgetLabel} from '../terminal/run.js';

const RUN_POP_ICONS = {
    doc: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 1.8h5.2L12.5 5v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 2v3.4h3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M11.2 2.4l2.4 2.4-7.8 7.8-3.1.7.7-3.1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
};

// 「所有配置」组默认折叠（JetBrains 同款），展开状态只活在本模块内存里
let allCollapsed = true;
let lastAnchor = null;
let recencyTimer = 0;

// 下拉面板的数据模型：widget 标签 + 最近的配置 + 全量配置。纯函数便于单测。
export function runConfigMenuModel(settings, docName) {
    const profiles = Array.isArray(settings && settings.runProfiles) ? settings.runProfiles : [];
    return {
        active: activeRunConfig(settings),
        recents: recentConfigs(profiles, 5),
        all: profiles,
        label: resolveRunWidgetLabel(activeRunConfig(settings), docName),
    };
}

export function createTitlebarRunConfig(deps) {

function badgeColor(name) {
    const badgeColors = ['#4f8cff', '#3fb950', '#a371f7', '#d18616', '#1fa5a0', '#d4577d'];
    let hash = 0;
    for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return badgeColors[hash % badgeColors.length];
}

function currentDocName() {
    const f = deps.file;
    return f ? (f.name || '') : '';
}

function setAnchorExpanded(expanded) {
    if (lastAnchor) lastAnchor.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function closeRunConfigPopover() {
    if (deps.els.runConfigPop) deps.els.runConfigPop.classList.add('hidden');
    setAnchorExpanded(false);
}

function appendSep(body) {
    const sep = document.createElement('div');
    sep.className = 'pp-sep';
    body.appendChild(sep);
}

function appendLabel(body, text) {
    const label = document.createElement('div');
    label.className = 'pp-label';
    label.textContent = text;
    body.appendChild(label);
}

function appendActionItem(body, icon, label, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-item';
    const ic = document.createElement('span');
    ic.className = 'pp-icon';
    ic.innerHTML = icon;
    const text = document.createElement('span');
    text.className = 'pp-name';
    text.textContent = label;
    btn.append(ic, text);
    btn.addEventListener('click', action);
    body.appendChild(btn);
}

function appendConfigItem(body, cfg, isActive) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-item' + (isActive ? ' rc-active' : '');
    const badge = document.createElement('span');
    badge.className = 'pp-badge';
    badge.style.background = badgeColor(cfg.name || cfg.lang || '?');
    badge.textContent = deps.projectBadgeText(cfg.name || cfg.lang || '?');
    const main = document.createElement('div');
    main.className = 'pp-main';
    const name = document.createElement('div');
    name.className = 'pp-name';
    name.textContent = cfg.name || '未命名配置';
    const sub = document.createElement('div');
    sub.className = 'pp-path';
    sub.textContent = configRowSubtitle(cfg);
    sub.dataset.tip = sub.textContent;
    main.append(name, sub);
    btn.append(badge, main);
    btn.addEventListener('click', () => activateConfig(cfg.id));
    body.appendChild(btn);
}

function activateConfig(id) {
    closeRunConfigPopover();
    if (typeof deps.applyRunProfile === 'function') deps.applyRunProfile(id);
    if (!id && deps.flash) deps.flash('已切换为运行当前文件');
    syncRunConfigWidget();
}

function renderRunConfigPopover() {
    const body = deps.els.runConfigPopBody;
    if (!body) return;
    body.textContent = '';
    const model = runConfigMenuModel(deps.settings, currentDocName());
    if (model.recents.length) {
        appendSep(body);
        appendLabel(body, '最近的配置');
        for (const cfg of model.recents) {
            appendConfigItem(body, cfg, !!model.active && model.active.id === cfg.id);
        }
    }
    appendSep(body);
    const group = document.createElement('button');
    group.type = 'button';
    group.className = 'gb-group' + (allCollapsed ? ' collapsed' : '');
    const chev = document.createElement('span');
    chev.className = 'gb-chev';
    chev.innerHTML = deps.POP_ICONS.chevron;
    const name = document.createElement('span');
    name.className = 'gb-group-name';
    name.textContent = '所有配置';
    const count = document.createElement('span');
    count.className = 'gb-group-count';
    count.textContent = String(model.all.length);
    group.append(chev, name, count);
    group.addEventListener('click', () => {
        allCollapsed = !allCollapsed;
        renderRunConfigPopover();
    });
    body.appendChild(group);
    if (!model.all.length) {
        const empty = document.createElement('div');
        empty.className = 'pp-label';
        empty.textContent = '还没有保存的配置，点「编辑配置…」创建';
        body.appendChild(empty);
    } else if (!allCollapsed) {
        for (const cfg of model.all) {
            appendConfigItem(body, cfg, !!model.active && model.active.id === cfg.id);
        }
    }
    appendSep(body);
    appendActionItem(body, RUN_POP_ICONS.doc, '当前文件', () => activateConfig(''));
    appendActionItem(body, RUN_POP_ICONS.edit, '编辑配置…', () => {
        closeRunConfigPopover();
        if (typeof deps.openSettings === 'function') deps.openSettings('run');
    });
    deps.positionToolbarPopover(deps.els.runConfigPop, lastAnchor);
}

function showRunConfigMenu(anchor) {
    if (!deps.els.runConfigPop) return;
    lastAnchor = anchor || null;
    if (deps.isToolbarPopOpen(deps.els.runConfigPop)) {
        closeRunConfigPopover();
        return;
    }
    deps.closeProjectPopover();
    deps.closeGitBranchPopover();
    renderRunConfigPopover();
    deps.els.runConfigPop.classList.remove('hidden');
    setAnchorExpanded(true);
    deps.positionToolbarPopover(deps.els.runConfigPop, anchor);
}

// widget 同步：配置名/文件名 + 徽标（配置 → 彩色字母徽标；当前文件 → 文件图标）。
// 调用点：syncRunButtonState（随文档切换/只读变化）、applyRunProfile、deleteRunProfile。
function syncRunConfigWidget() {
    if (!deps.els.tbRunName) return;
    const cfg = activeRunConfig(deps.settings);
    const docName = currentDocName();
    const label = resolveRunWidgetLabel(cfg, docName);
    deps.els.tbRunName.textContent = label;
    if (label.length >= 16) deps.els.tbRunName.dataset.tip = label;
    else delete deps.els.tbRunName.dataset.tip;
    const badge = deps.els.tbRunBadge;
    if (badge) {
        if (cfg) {
            badge.classList.remove('file');
            badge.style.background = badgeColor(cfg.name || cfg.lang || '?');
            badge.textContent = deps.projectBadgeText(cfg.name || cfg.lang || '?');
        } else {
            badge.classList.add('file');
            badge.style.background = '';
            badge.innerHTML = docName && deps.fileIconSpec ? deps.fileIconSpec(docName).svg : '';
        }
    }
    if (deps.els.tbRunConfig) {
        deps.els.tbRunConfig.dataset.tip = cfg
            ? '运行配置：' + cfg.name
            : (docName ? '运行当前文件，点开可选配置' : '选择运行配置');
    }
}

// 「最近的配置」口径：每次运行（校验全过后）把所用配置记为最近使用，防抖落盘
function touchRunProfileRecency(cfg) {
    if (!cfg || !cfg.id || !deps.settings) return;
    const profiles = Array.isArray(deps.settings.runProfiles) ? deps.settings.runProfiles : [];
    const p = profiles.find((x) => x && x.id === cfg.id);
    if (!p) return;
    p.lastUsedAt = Date.now();
    clearTimeout(recencyTimer);
    recencyTimer = setTimeout(() => {
        if (typeof deps.applySettings === 'function') deps.applySettings();
    }, 400);
}


return {closeRunConfigPopover, showRunConfigMenu, syncRunConfigWidget, touchRunProfileRecency};
}
