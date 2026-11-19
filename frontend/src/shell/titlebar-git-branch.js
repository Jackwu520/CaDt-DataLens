// 标题栏 Git 分支弹层（IDEA 式）：分支树、搜索、切换/新建/推送/拉取/更新项目、固定与键盘导航。
// 从 titlebar-popovers.js 拆出；定位工具与 SVG 常量由宿主经 deps 注入，关闭项目弹层经 deps.closeProjectPopover。
import {overlayStack} from '../core/overlay-stack.js';

export function createTitlebarGitBranch(deps) {

// ===== 标题栏弹层：Git 分支（IDEA 式） =====

const gitBranchPopState = {
    open: false,
    loading: false,
    data: null,
    error: '',
    query: '',
    active: -1,
    pinned: false,
    collapsed: new Set(),
    anchor: null,
    dir: '',
};
// 本地分支每次打开都刷新；远程分支列表缓存，只在 fetch 按钮或 push/pull 后重读
const gitBranchCache = {dir: '', remote: [], hasRemote: false, result: null};
let gitBranchRows = [];
// 分支弹层的弹层栈条目（showBranchMenu/closeGitBranchPopover 收口）
let gbStackHandle = null;

function invalidateGitBranchRemoteCache() {
    gitBranchCache.hasRemote = false;
    gitBranchCache.remote = [];
    if (gitBranchCache.result) gitBranchCache.result.remote = [];
}

function closeGitBranchPopover() {
    if (!deps.els.gitBranchPop) return;
    if (gbStackHandle) {
        gbStackHandle.dispose();
        gbStackHandle = null;
    }
    deps.els.gitBranchPop.classList.add('hidden');
    gitBranchPopState.open = false;
    gitBranchPopState.loading = false;
    gitBranchPopState.data = null;
    gitBranchPopState.error = '';
    gitBranchPopState.query = '';
    gitBranchPopState.active = -1;
    gitBranchPopState.anchor = null;
    gitBranchPopState.dir = '';
    gitBranchRows = [];
}

function gitBranchPopButton(className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.tabIndex = -1;
    return btn;
}

function gitBranchPopDir() {
    return gitBranchPopState.dir || deps.gitRootDir();
}

function gitBranchPopMatchesQuery(text) {
    const q = gitBranchPopState.query.trim().toLowerCase();
    return !q || String(text || '').toLowerCase().includes(q);
}

function addGitBranchRow(btn, run) {
    btn.addEventListener('click', () => run());
    btn.classList.toggle('active', gitBranchRows.length === gitBranchPopState.active);
    deps.els.gbBody.appendChild(btn);
    gitBranchRows.push({el: btn, run});
}

function addGitBranchAction(icon, label, shortcut, run) {
    const btn = gitBranchPopButton('gb-row gb-action');
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = icon;
    const text = document.createElement('span');
    text.className = 'gb-row-label';
    text.textContent = label;
    btn.append(ic, text);
    if (shortcut) {
        const key = document.createElement('span');
        key.className = 'gb-row-key';
        key.textContent = shortcut;
        btn.appendChild(key);
    }
    addGitBranchRow(btn, run);
}

function addGitBranchGroup(key, label, count, indent, collapsible = true) {
    const collapsed = collapsible && gitBranchPopState.collapsed.has(key);
    const btn = gitBranchPopButton('gb-group' + (collapsed ? ' collapsed' : '') + (collapsible ? '' : ' gb-static'));
    btn.style.paddingLeft = 12 + indent * 14 + 'px';
    if (collapsible) {
        const chev = document.createElement('span');
        chev.className = 'gb-chev';
        chev.innerHTML = deps.POP_ICONS.chevron;
        btn.appendChild(chev);
    }
    const name = document.createElement('span');
    name.className = 'gb-group-name';
    name.textContent = label;
    btn.appendChild(name);
    if (count != null) {
        const countEl = document.createElement('span');
        countEl.className = 'gb-group-count';
        countEl.textContent = String(count);
        btn.appendChild(countEl);
    }
    if (collapsible) {
        btn.addEventListener('click', () => {
            if (gitBranchPopState.collapsed.has(key)) gitBranchPopState.collapsed.delete(key);
            else gitBranchPopState.collapsed.add(key);
            renderGitBranchPopover();
        });
    }
    deps.els.gbBody.appendChild(btn);
}

function addGitBranchRowItem(branch, remote, indent) {
    const btn = gitBranchPopButton('gb-row gb-branch' + (branch.current ? ' current' : ''));
    btn.style.paddingLeft = 12 + indent * 14 + 'px';
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = branch.current ? deps.POP_ICONS.check : deps.POP_ICONS.branch;
    const label = document.createElement('span');
    label.className = 'gb-row-label';
    label.textContent = branch.name;
    btn.append(ic, label);
    const meta = document.createElement('span');
    meta.className = 'gb-row-meta';
    if (!remote) {
        if (branch.gone) {
            const gone = document.createElement('span');
            gone.className = 'gb-gone';
            gone.textContent = '上游已删除';
            meta.appendChild(gone);
        } else if (branch.upstream) {
            const up = document.createElement('span');
            up.textContent = branch.upstream;
            meta.appendChild(up);
        }
        if (branch.ahead > 0) {
            const ahead = document.createElement('span');
            ahead.className = 'gb-ahead';
            ahead.textContent = '↑' + branch.ahead;
            ahead.dataset.tip = '领先上游 ' + branch.ahead + ' 个提交';
            meta.appendChild(ahead);
        }
        if (branch.behind > 0) {
            const behind = document.createElement('span');
            behind.className = 'gb-behind';
            behind.textContent = '↓' + branch.behind;
            behind.dataset.tip = '落后上游 ' + branch.behind + ' 个提交';
            meta.appendChild(behind);
        }
    }
    if (meta.childNodes.length) btn.appendChild(meta);
    btn.dataset.tip = remote ? '签出远程分支 ' + branch.name + '（自动创建本地跟踪分支）' : '签出 ' + branch.name;
    addGitBranchRow(btn, () => gitPopCheckout(branch, remote));
}

function addGitBranchTag(name) {
    const btn = gitBranchPopButton('gb-row gb-tag');
    const ic = document.createElement('span');
    ic.className = 'gb-row-icon';
    ic.innerHTML = deps.POP_ICONS.tag;
    const label = document.createElement('span');
    label.className = 'gb-row-label';
    label.textContent = name;
    btn.append(ic, label);
    btn.dataset.tip = '签出标记 ' + name;
    addGitBranchRow(btn, () => gitPopCheckoutRefValue(name));
}

function addGitBranchSep() {
    const sep = document.createElement('div');
    sep.className = 'gb-sep';
    deps.els.gbBody.appendChild(sep);
}

function addGitBranchState(text, isError) {
    const state = document.createElement('div');
    state.className = 'gb-state' + (isError ? ' error' : '');
    state.textContent = text;
    deps.els.gbBody.appendChild(state);
}

function gitBranchCountTree(node) {
    let count = node.branches.length;
    for (const child of node.children.values()) count += gitBranchCountTree(child);
    return count;
}

function gitBranchBuildTree(branches) {
    const root = {children: new Map(), branches: []};
    for (const branch of branches) {
        const parts = String(branch.name || '').split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (!node.children.has(key)) node.children.set(key, {children: new Map(), branches: []});
            node = node.children.get(key);
        }
        node.branches.push(branch);
    }
    return root;
}

function gitBranchRenderTree(node, depth, prefix) {
    const groups = Array.from(node.children.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
    for (const [name, child] of groups) {
        const full = prefix ? prefix + '/' + name : name;
        const key = 'localp:' + full;
        addGitBranchGroup(key, name, gitBranchCountTree(child), depth, true);
        if (!gitBranchPopState.collapsed.has(key)) gitBranchRenderTree(child, depth + 1, full);
    }
    const branches = node.branches.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const branch of branches) addGitBranchRowItem(branch, false, depth);
}

function renderGitBranchPopover() {
    if (!deps.els.gbBody || !gitBranchPopState.open) return;
    const body = deps.els.gbBody;
    body.textContent = '';
    gitBranchRows = [];
    gitBranchPopState.active = -1;
    const state = gitBranchPopState;
    if (state.loading && !state.data) {
        addGitBranchState('正在读取分支…');
        deps.positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
        return;
    }
    if (state.error) {
        addGitBranchState(state.error, true);
        deps.positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
        return;
    }
    const data = state.data;
    if (!data) {
        addGitBranchState('正在读取分支…');
        return;
    }
    if (!data.available) {
        addGitBranchState(data.reason || '当前目录不在 Git 仓库内');
        deps.positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
        return;
    }
    const q = state.query.trim().toLowerCase();
    const matches = (text) => !q || String(text || '').toLowerCase().includes(q);
    const allActions = [
        {icon: deps.POP_ICONS.update, label: '更新项目…', shortcut: 'Ctrl+T', run: gitPopUpdateProject},
        {icon: deps.POP_ICONS.commit, label: '提交…', shortcut: 'Ctrl+K', run: gitPopOpenCommit},
        {icon: deps.POP_ICONS.push, label: '推送…', shortcut: 'Ctrl+Shift+K', run: gitPopPush},
        {sep: true},
        {icon: deps.POP_ICONS.plus, label: '新建分支…', shortcut: 'Ctrl+Alt+N', run: gitPopNewBranch},
        {icon: deps.POP_ICONS.tag, label: '签出标记或修订…', run: gitPopCheckoutRef},
    ];
    const actions = q ? allActions.filter((action) => !action.sep && matches(action.label)) : allActions;
    for (const action of actions) {
        if (action.sep) addGitBranchSep();
        else addGitBranchAction(action.icon, action.label, action.shortcut, action.run);
    }
    const localAll = data.local || [];
    const local = localAll.filter((b) => matches(b.name));
    const remote = (data.remote || []).filter((b) => matches(b.name));
    const tags = (data.tags || []).filter((t) => matches(t));
    const recentNames = new Set(data.recent || []);
    const recent = localAll.filter((b) => recentNames.has(b.name) && !b.current && matches(b.name));
    let groupsRendered = 0;
    if (recent.length) {
        if (q) addGitBranchGroup('recent', '最近', recent.length, 0, false);
        else addGitBranchGroup('recent', '最近', recent.length, 0, true);
        if (q || !state.collapsed.has('recent')) {
            for (const branch of recent) addGitBranchRowItem(branch, false, 0);
        }
        groupsRendered++;
    }
    if (local.length) {
        if (q) {
            addGitBranchGroup('local', '本地', local.length, 0, false);
            for (const branch of local) addGitBranchRowItem(branch, false, 0);
        } else {
            addGitBranchGroup('local', '本地', local.length, 0, true);
            if (!state.collapsed.has('local')) gitBranchRenderTree(gitBranchBuildTree(local), 0, '');
        }
        groupsRendered++;
    }
    if (remote.length) {
        addGitBranchGroup('remote', '远程', remote.length, 0, !q);
        if (q || !state.collapsed.has('remote')) {
            for (const branch of remote) addGitBranchRowItem(branch, true, 0);
        }
        groupsRendered++;
    }
    if (tags.length) {
        addGitBranchGroup('tags', '标签', tags.length, 0, !q);
        if (q || !state.collapsed.has('tags')) {
            for (const tag of tags) addGitBranchTag(tag);
        }
        groupsRendered++;
    }
    if (!groupsRendered) {
        addGitBranchState(q ? '没有匹配的分支或操作' : '仓库里还没有可用的分支');
    }
    deps.positionToolbarPopover(deps.els.gitBranchPop, state.anchor);
}

async function loadGitBranches(includeRemote) {
    if (!deps.backend.GitBranchesFor) return;
    const dir = gitBranchPopDir();
    if (!dir) return;
    gitBranchPopState.loading = true;
    if (!gitBranchPopState.data) renderGitBranchPopover();
    try {
        const data = await deps.backend.GitBranchesFor(dir, !!includeRemote);
        if (data && data.available) {
            if (includeRemote) {
                gitBranchCache.remote = data.remote || [];
                gitBranchCache.hasRemote = true;
            } else {
                data.remote = gitBranchCache.remote || [];
            }
            gitBranchCache.dir = dir;
            gitBranchCache.result = data;
        } else {
            gitBranchCache.dir = '';
            gitBranchCache.remote = [];
            gitBranchCache.hasRemote = false;
            gitBranchCache.result = null;
        }
        gitBranchPopState.data = data;
        gitBranchPopState.error = '';
    } catch (e) {
        const message = '读取分支失败：' + ((e && e.message) || e);
        if (gitBranchPopState.data) deps.flash(message, true);
        else gitBranchPopState.error = message;
    }
    gitBranchPopState.loading = false;
    if (gitBranchPopState.open) renderGitBranchPopover();
}

function showBranchMenu(anchor) {
    if (!deps.els.gitBranchPop) return;
    if (deps.isToolbarPopOpen(deps.els.gitBranchPop)) {
        closeGitBranchPopover();
        return;
    }
    deps.closeProjectPopover();
    if (deps.closeRunConfigPopover) deps.closeRunConfigPopover();
    const dir = deps.gitRootDir();
    if (!dir) {
        deps.flash('请先打开文件或目录', true);
        return;
    }
    if (!deps.backend.GitBranchesFor) {
        deps.flash('当前版本不支持 Git 分支管理', true);
        return;
    }
    const cached = gitBranchCache.result && deps.samePathValue(gitBranchCache.dir, dir) && gitBranchCache.result.available
        ? gitBranchCache.result
        : null;
    gitBranchPopState.open = true;
    gitBranchPopState.loading = true;
    gitBranchPopState.data = cached;
    gitBranchPopState.error = '';
    gitBranchPopState.query = '';
    gitBranchPopState.active = -1;
    gitBranchPopState.dir = dir;
    gitBranchPopState.anchor = anchor;
    gitBranchRows = [];
    deps.els.gbSearch.value = '';
    deps.els.gbBody.textContent = '';
    deps.els.gitBranchPop.classList.remove('hidden');
    // 进全局弹层栈（popover 档）：Esc 由栈按层序退；pinned 时不影响 Esc 语义
    if (gbStackHandle) gbStackHandle.dispose();
    gbStackHandle = overlayStack.open({
        id: 'git-branch-pop', kind: 'popover', el: deps.els.gitBranchPop,
        onClose: () => { closeGitBranchPopover(); return true; },
    });
    if (cached) {
        renderGitBranchPopover();
    } else {
        addGitBranchState('正在读取分支…');
        deps.positionToolbarPopover(deps.els.gitBranchPop, anchor);
    }
    deps.els.gbSearch.focus();
    loadGitBranches(!cached || !gitBranchCache.hasRemote);
}

function gitBranchMoveActive(delta) {
    if (!gitBranchRows.length) return;
    let next = gitBranchPopState.active + delta;
    if (gitBranchPopState.active < 0) next = delta > 0 ? 0 : gitBranchRows.length - 1;
    next = Math.max(0, Math.min(gitBranchRows.length - 1, next));
    gitBranchPopState.active = next;
    gitBranchRows.forEach((row, i) => row.el.classList.toggle('active', i === next));
    gitBranchRows[next].el.scrollIntoView({block: 'nearest'});
}

function gitBranchRunActive() {
    const row = gitBranchRows[gitBranchPopState.active];
    if (row) row.run();
}

function openGitOutput(name, output) {
    deps.openVirtualDoc(name, output || '（命令没有输出）');
}

async function gitPopCheckout(branch, remote) {
    const dir = gitBranchPopDir();
    const name = branch.name;
    closeGitBranchPopover();
    if (branch.current) return;
    deps.flash('正在切换到 ' + name + '…');
    try {
        const res = await deps.backend.GitCheckoutBranch(dir, name, !!remote);
        if (!res || !res.success) {
            deps.flash('切换分支失败', true);
            if (res && res.output) openGitOutput('切换分支失败.txt', res.output);
            return;
        }
        deps.flash('已切换到分支：' + (res.branch || name));
        await deps.refreshGitStatus();
        await deps.reloadAllFromDisk();
    } catch (e) {
        deps.flash('切换分支失败：' + e, true);
    }
}

async function gitPopUpdateProject() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitPullFor) return;
    deps.flash('正在更新项目…');
    try {
        const res = await deps.backend.GitPullFor(dir);
        if (!res || !res.success) {
            deps.flash('更新项目失败', true);
            if (res && res.output) openGitOutput('更新项目失败.txt', res.output);
            return;
        }
        deps.flash('项目已更新');
        invalidateGitBranchRemoteCache();
        await deps.refreshGitStatus();
        await deps.reloadAllFromDisk();
    } catch (e) {
        deps.flash('更新项目失败：' + e, true);
    }
}

function gitPopOpenCommit() {
    closeGitBranchPopover();
    deps.settings.showSidebar = true;
    deps.switchSidebarView('git');
    setTimeout(() => {
        if (deps.els.gitMessage) deps.els.gitMessage.focus();
    }, 80);
}

async function gitPopPush() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitPushFor) return;
    deps.flash('正在推送…');
    try {
        const res = await deps.backend.GitPushFor(dir);
        if (!res || !res.success) {
            deps.flash('推送失败', true);
            if (res && res.output) openGitOutput('推送失败.txt', res.output);
            return;
        }
        deps.flash('已推送当前分支');
        invalidateGitBranchRemoteCache();
        await deps.refreshGitStatus();
    } catch (e) {
        deps.flash('推送失败：' + e, true);
    }
}

function gitPopNewBranch() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitCreateBranch) {
        deps.flash('当前版本不支持新建分支', true);
        return;
    }
    deps.openNameDialog({
        title: '新建分支',
        label: '分支名称',
        placeholder: 'feature/my-branch',
        okLabel: '创建并检出',
        onSubmit: async (value) => {
            const name = String(value || '').trim();
            if (!name) throw new Error('请输入分支名');
            const res = await deps.backend.GitCreateBranch(dir, name);
            if (!res || !res.success) throw new Error((res && res.output) || '创建分支失败');
            deps.flash('已创建并切换到分支：' + name);
            await deps.refreshGitStatus();
        },
    });
}

function gitPopCheckoutRefValue(ref) {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitCheckoutRefFor) {
        deps.flash('当前版本不支持签出标记或修订', true);
        return;
    }
    deps.flash('正在签出 ' + ref + '…');
    deps.backend.GitCheckoutRefFor(dir, ref).then(async (res) => {
        if (!res || !res.success) {
            deps.flash('签出失败', true);
            if (res && res.output) openGitOutput('签出失败.txt', res.output);
            return;
        }
        deps.flash('已签出：' + ref);
        await deps.refreshGitStatus();
        await deps.reloadAllFromDisk();
    }).catch((e) => deps.flash('签出失败：' + e, true));
}

function gitPopCheckoutRef() {
    const dir = gitBranchPopDir();
    closeGitBranchPopover();
    if (!deps.backend.GitCheckoutRefFor) {
        deps.flash('当前版本不支持签出标记或修订', true);
        return;
    }
    deps.openNameDialog({
        title: '签出标记或修订',
        label: '分支、标记或提交 SHA',
        placeholder: 'v1.0.0 / 1a2b3c4 / feature/x',
        okLabel: '签出',
        onSubmit: async (value) => {
            const ref = String(value || '').trim();
            if (!ref) throw new Error('请输入分支、标记或提交 SHA');
            const res = await deps.backend.GitCheckoutRefFor(dir, ref);
            if (!res || !res.success) throw new Error((res && res.output) || '签出失败');
            deps.flash('已签出：' + ref);
            await deps.refreshGitStatus();
            await deps.reloadAllFromDisk();
        },
    });
}

async function gitPopFetch() {
    if (!gitBranchPopState.open || gitBranchPopState.loading || !deps.backend.GitFetchFor) return;
    if (deps.els.gbFetch) {
        deps.els.gbFetch.disabled = true;
        deps.els.gbFetch.classList.add('active');
    }
    try {
        const res = await deps.backend.GitFetchFor(gitBranchPopDir());
        if (!res || !res.success) {
            closeGitBranchPopover();
            deps.flash('获取远程分支失败', true);
            if (res && res.output) openGitOutput('获取远程分支失败.txt', res.output);
            return;
        }
        deps.flash('已获取远程分支');
        await loadGitBranches(true);
    } catch (e) {
        deps.flash('获取远程分支失败：' + e, true);
    } finally {
        if (deps.els.gbFetch) {
            deps.els.gbFetch.disabled = false;
            deps.els.gbFetch.classList.remove('active');
        }
    }
}

function gitPopTogglePin() {
    gitBranchPopState.pinned = !gitBranchPopState.pinned;
    if (deps.els.gbPin) {
        deps.els.gbPin.classList.toggle('active', gitBranchPopState.pinned);
        deps.els.gbPin.setAttribute('aria-pressed', String(gitBranchPopState.pinned));
        deps.els.gbPin.dataset.tip = gitBranchPopState.pinned ? '取消固定窗口' : '固定窗口（点击外部不关闭）';
    }
}

if (deps.els.gbSearch) {
    deps.els.gbSearch.addEventListener('input', () => {
        gitBranchPopState.query = deps.els.gbSearch.value;
        renderGitBranchPopover();
    });
    deps.els.gbSearch.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            gitBranchMoveActive(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            gitBranchMoveActive(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            gitBranchRunActive();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeGitBranchPopover();
        }
    });
}
if (deps.els.gbFetch) deps.els.gbFetch.addEventListener('click', gitPopFetch);
if (deps.els.gbPin) deps.els.gbPin.addEventListener('click', gitPopTogglePin);

document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (deps.isToolbarPopOpen(deps.els.projectPop) && !deps.els.projectPop.contains(target) && !deps.els.wsProject.contains(target)) {
        deps.closeProjectPopover();
    }
    if (deps.isToolbarPopOpen(deps.els.gitBranchPop) && !deps.els.gitBranchPop.contains(target) && !deps.els.wsBranch.contains(target) && !gitBranchPopState.pinned) {
        closeGitBranchPopover();
    }
    if (deps.isToolbarPopOpen(deps.els.runConfigPop) && deps.els.tbRunConfig && !deps.els.runConfigPop.contains(target) && !deps.els.tbRunConfig.contains(target)) {
        deps.closeRunConfigPopover();
    }
}, true);

document.addEventListener('keydown', (e) => {
    // 三个弹层的 Esc 已归全局弹层栈（各自 show 时注册），不再逐个点名；这里只保留
    // 分支弹层开着时的 Ctrl+F 聚焦搜索快捷键。
    if (!gitBranchPopState.open) return;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (deps.els.gbSearch) {
            deps.els.gbSearch.focus();
            deps.els.gbSearch.select();
        }
    }
}, true);

window.addEventListener('blur', () => {
    deps.closeProjectPopover();
    closeGitBranchPopover();
    if (deps.closeRunConfigPopover) deps.closeRunConfigPopover();
});
window.addEventListener('resize', () => {
    deps.closeProjectPopover();
    closeGitBranchPopover();
    if (deps.closeRunConfigPopover) deps.closeRunConfigPopover();
});


return {closeGitBranchPopover, gitPopNewBranch, gitPopOpenCommit, gitPopPush, gitPopUpdateProject, showBranchMenu};
}
