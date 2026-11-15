// 终端会话管理与菜单：新建/激活/关闭/移除标签页、主题同步、shell 与标签右键菜单、重命名。
// 从 terminal-ui.js 拆出；terminalUI 状态、shell 标签、cwd/theme、runGitCommit 由宿主经 deps 注入。
import {iconSvg} from '../core/icons.js';

export function createTerminalSessions(deps) {

async function createTermSession(shell = '') {
    if (!deps.backend.TermCreate) {
        deps.flash('当前版本不支持内置终端', true);
        return null;
    }
    let created;
    try {
        created = await deps.backend.TermCreate(termDefaultCols(), termDefaultRows(), shell, deps.termCwd());
    } catch (e) {
        deps.flash('创建终端失败：' + e, true);
        return null;
    }
    const id = created.id;
    const usedShell = created.shell || shell || 'powershell';
    attachTermSession(id, usedShell, {explicitShell: !!shell});
    return {id, shell: usedShell};
}

// attachTermSession：为「已经存在的后端会话」建 xterm 视图与页签。
// AI 的 terminal 工具走的就是这条路（后端 TermCreate 由调用方负责），
// 这样 AI 自建的终端与用户点「新建终端」出来的完全一样（同一份页签与输出流）。
function attachTermSession(id, usedShell, opts = {}) {
    const existing = deps.terminalUI.sessions.get(id);
    if (existing) {
        activateTermSession(id);
        return existing;
    }
    const body = document.getElementById('term-body');
    const host = document.createElement('div');
    host.className = 'term-session';
    body.appendChild(host);
    const term = new window.Terminal({
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        fontSize: 12,
        scrollback: 2000,
        cursorBlink: true,
        theme: deps.termTheme(),
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
        fit.fit();
    } catch (e) {}
    term.onData((data) => {
        deps.backend.TermWrite(id, data).catch(() => {});
    });
    // 页签命名仿 JetBrains：默认 shell 叫「本地」，重复时加 (2)/(3)；显式选择的 shell 用名字
    const baseName = opts.explicitShell ? (deps.TERM_SHELL_LABELS[usedShell] || usedShell) : '本地';
    let dup = 0;
    for (const s of deps.terminalUI.sessions.values()) {
        if (s.baseName === baseName) dup++;
    }
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'term-tab';
    const label = document.createElement('span');
    label.className = 'term-tab-label';
    label.textContent = dup ? baseName + ' (' + (dup + 1) + ')' : baseName;
    label.dataset.tip = deps.TERM_SHELL_LABELS[usedShell] || usedShell;
    const tabClose = document.createElement('span');
    tabClose.className = 'term-tab-close';
    tabClose.innerHTML = iconSvg('close', 11);
    tabClose.dataset.tip = '关闭终端';
    tab.append(label, tabClose);
    tab.addEventListener('click', (e) => {
        const closeHit = e.target.closest('.term-tab-close');
        if (closeHit) {
            e.preventDefault();
            e.stopPropagation();
            closeTermSession(id);
            return;
        }
        if (e.shiftKey) {
            e.preventDefault();
            closeTermSession(id);
            return;
        }
        activateTermSession(id);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateTermSession(id);
        showTermTabMenu(id, e.clientX, e.clientY);
    });
    document.getElementById('term-tabs').appendChild(tab);
    const session = {id, term, fit, host, tab, shell: usedShell, baseName,
        defaultLabel: label.textContent, defaultTitle: label.title, customName: ''};
    deps.terminalUI.sessions.set(id, session);
    deps.terminalUI.order.push(id);
    activateTermSession(id);
    setTimeout(() => {
        try {
            fit.fit();
            term.focus();
        } catch (e) {}
    }, 80);
    return session;
}

function termDefaultCols() {
    return 80;
}

function termDefaultRows() {
    return 24;
}

function activateTermSession(id) {
    deps.terminalUI.activeId = id;
    for (const [sid, s] of deps.terminalUI.sessions) {
        s.host.classList.toggle('hidden', sid !== id);
        s.tab.classList.toggle('active', sid === id);
    }
    const s = deps.terminalUI.sessions.get(id);
    if (s) {
        try {
            s.fit.fit();
            s.term.focus();
        } catch (e) {}
    }
}

function fitActiveTerm() {
    const s = deps.terminalUI.sessions.get(deps.terminalUI.activeId);
    if (s) {
        try {
            s.fit.fit();
        } catch (e) {}
    }
}

async function closeTermSession(id) {
    try {
        await deps.backend.TermClose(id);
    } catch (e) {}
    removeTermSession(id);
    if (!deps.terminalUI.sessions.size) deps.toggleTerminalPanel(false);
    else activateTermSession(deps.terminalUI.order[deps.terminalUI.order.length - 1]);
}

function removeTermSession(id) {
    const s = deps.terminalUI.sessions.get(id);
    if (s) {
        try {
            s.term.dispose();
        } catch (e) {}
        s.tab.remove();
        s.host.remove();
    }
    deps.terminalUI.sessions.delete(id);
    deps.terminalUI.order = deps.terminalUI.order.filter((x) => x !== id);
}

function syncTerminalTheme() {
    for (const s of deps.terminalUI.sessions.values()) {
        try {
            s.term.options.theme = deps.termTheme();
        } catch (e) {}
    }
}

window.addEventListener('resize', () => {
    if (deps.terminalUI.open) fitActiveTerm();
});

deps.els.gitRefresh.addEventListener('click', () => deps.refreshGitStatus());

if (deps.els.gitSplitter) {
    let gitSplitting = false;
    let gitSplitStartY = 0;
    let gitSplitStartH = 0;
    deps.els.gitSplitter.addEventListener('mousedown', (e) => {
        if (!deps.els.gitCommitArea) return;
        gitSplitting = true;
        gitSplitStartY = e.clientY;
        gitSplitStartH = deps.els.gitCommitArea.offsetHeight;
        deps.setDragCursor('ns');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!gitSplitting) return;
        const h = Math.min(300, Math.max(90, gitSplitStartH - (e.clientY - gitSplitStartY)));
        deps.els.gitCommitArea.style.height = h + 'px';
        deps.els.gitCommitArea.style.flex = 'none';
    });
    window.addEventListener('mouseup', () => {
        if (!gitSplitting) return;
        gitSplitting = false;
        deps.setDragCursor(null);
        document.body.style.userSelect = '';
        deps.settings.gitCommitAreaHeight = Math.min(300, Math.max(90, deps.els.gitCommitArea.offsetHeight));
        deps.applySettings();
    });
}

// 新建终端的 shell 菜单（JetBrains 风格）：列出本机可用 shell，选中即新建页签
async function showTermShellMenu() {
    if (!deps.ctxMenu) return;
    let shells = [];
    try {
        shells = deps.backend.TermShells ? await deps.backend.TermShells() : [];
    } catch (e) {}
    if (!shells.length) {
        deps.flash('没有可用的 Shell', true);
        return;
    }
    const r = deps.els.termShellMenu.getBoundingClientRect();
    deps.ctxMenu.open(shells.map((s) => ({
        label: s.name,
        action: () => createTermSession(s.id),
    })), r.left, r.bottom + 4);
}
if (deps.els.termPanelClose) deps.els.termPanelClose.addEventListener('click', () => deps.toggleTerminalPanel(false));

// 终端标签页右键菜单（JetBrains 风格）：新建/重命名/清屏/关闭
async function showTermTabMenu(id, x, y) {
    if (!deps.ctxMenu) return;
    const s = deps.terminalUI.sessions.get(id);
    if (!s) return;
    const others = [...terminalUI.sessions.values()].filter((v) => v.id !== id);
    let shells = [];
    try {
        shells = deps.backend.TermShells ? await deps.backend.TermShells() : [];
    } catch (e) {}
    const items = [
        {label: '新建终端（默认 Shell）', icon: 'E710', action: () => createTermSession()},
    ];
    if (shells.length) {
        items.push({
            label: '用其他 Shell 新建终端',
            icon: 'E756',
            submenu: shells.map((sh) => ({label: sh.name, action: () => createTermSession(sh.id)})),
        });
    }
    items.push(
        {label: '重命名标签页', icon: 'E8AC', action: () => renameTermSession(s)},
        {label: '清屏', icon: 'eraser', action: () => { try { s.term.clear(); s.term.focus(); } catch (e) {} }},
        {sep: true},
        {label: '关闭', shortcut: 'Shift+点击', icon: 'E8BB', action: () => closeTermSession(id)},
        {label: '关闭其他标签页', disabled: !others.length, action: () => { for (const o of others) closeTermSession(o.id); }},
        {label: '关闭所有标签页', action: () => { for (const o of [...terminalUI.sessions.values()]) closeTermSession(o.id); }},
    );
    deps.ctxMenu.open(items, x, y);
}

// 重命名终端标签页：清空并确定则恢复默认名
function renameTermSession(s) {
    if (!s) return;
    deps.openNameDialog({
        title: '重命名终端标签页',
        label: '名称',
        value: s.customName || s.defaultLabel,
        okLabel: '确定',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            const label = s.tab.querySelector('.term-tab-label');
            if (!label) return;
            if (name) {
                s.customName = name;
                label.textContent = name;
                label.dataset.tip = name;
            } else {
                s.customName = '';
                label.textContent = s.defaultLabel;
                label.dataset.tip = s.defaultTitle;
            }
        },
    });
}

// AI 面板的终端桥（main.js 以 getter 注入 ai-panel）：AI 自建/操作终端时与用户共用同一份 UI 状态
// （页签、xterm、底部面板）。这里只做转发，不做权限判断——审批在 ai-panel 的 terminal 工具里，
// 与 run_command 共用同一条命令审批链。
function terminalHostApi() {
    return {
        async open(shell) {
            const created = await createTermSession(shell || '');
            if (!created) throw new Error('创建终端失败（详见状态栏提示）');
            deps.toggleTerminalPanel(true);
            activateTermSession(created.id);
            return created;
        },
        list() {
            return [...deps.terminalUI.sessions.values()].map((s) => ({
                id: s.id,
                shell: s.shell,
                label: s.customName || s.defaultLabel || s.id,
                active: deps.terminalUI.activeId === s.id,
            }));
        },
        send(id, data) {
            if (!deps.terminalUI.sessions.has(id)) throw new Error('终端不在界面上：' + id);
            return deps.backend.TermWrite(id, data);
        },
        focus(id) {
            if (!deps.terminalUI.sessions.has(id)) return false;
            deps.toggleTerminalPanel(true);
            activateTermSession(id);
            return true;
        },
        close(id) {
            return closeTermSession(id);
        },
    };
}

return {activateTermSession, closeTermSession, createTermSession, fitActiveTerm, removeTermSession,
        renameTermSession, showTermShellMenu, showTermTabMenu, syncTerminalTheme, terminalHostApi,
        termDefaultCols, termDefaultRows};
}
