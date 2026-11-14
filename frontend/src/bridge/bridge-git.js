// git 浅集成：状态缓存、徽标、最近提交/文件历史/diff、回滚。
// 从 bridge-ui.js 拆出；gitStateCache 与 gitGroupCollapsed 是跨模块共享的活引用（原地变更，非快照）。
export function createBridgeGit(deps) {

// ===== git 浅集成 =====
const gitStateCache = {dir: '', map: new Map(), branch: '', available: false, reason: '', untrackedSet: new Set(), ignoredSet: new Set()};
const gitGroupCollapsed = {changes: false, untracked: false};
let gitTimer = null;

function gitRootDir() {
    return deps.workspaceFolder || (deps.file && deps.file.path ? deps.file.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
}

async function refreshGitStatus() {
    if (!deps.backend.GitStatusFor) return;
    const root = gitRootDir();
    if (!root) {
        gitStateCache.dir = '';
        gitStateCache.map.clear();
        gitStateCache.available = false;
        gitStateCache.branch = '';
        applyGitBadges();
        deps.renderWorkspaceCrumbs();
        notifyAIGitEntry();
        return;
    }
    if (root !== gitStateCache.dir) {
        gitStateCache.dir = root;
        gitStateCache.map.clear();
    }
    try {
        const status = await deps.backend.GitStatusFor(root);
        if (!status || !status.available) {
            gitStateCache.map.clear();
            gitStateCache.branch = '';
            gitStateCache.available = !!status.available;
            gitStateCache.reason = status.reason || '';
        } else {
            gitStateCache.available = true;
            gitStateCache.branch = status.branch || '';
            gitStateCache.map.clear();
            gitStateCache.untrackedSet.clear();
            gitStateCache.ignoredSet.clear();
            for (const entry of status.entries || []) {
                const p = entry.path.replace(/\\/g, '/').replace(/\/+$/, '');
                if (entry.state === 'ignored') {
                    gitStateCache.ignoredSet.add(p);
                    continue;
                }
                gitStateCache.map.set(p, entry.state);
                if (entry.state === 'untracked') gitStateCache.untrackedSet.add(p);
            }
        }
    } catch (e) {}
    applyGitBadges();
    applyGitDot();
    deps.renderWorkspaceCrumbs();
    // git 状态变化（提交/回滚/外部改动被定时器捕捉）后刷新已打开文件的行级标记
    for (const d of deps.docs) deps.scheduleGitGutter(d, 400);
    if (deps.currentSidebarView() === 'git' && deps.settings.showSidebar && deps.els.gitChanges) {
        deps.renderGitPanel();
    }
    notifyAIGitEntry();
}

// AI 面板头顶的 Git 图标是否出现，取决于当前工作区是不是 git 仓库。
function notifyAIGitEntry() {
    if (deps.aiPanel && typeof deps.aiPanel.refreshGitEntry === 'function') {
        try { deps.aiPanel.refreshGitEntry(); } catch (e) {}
    }
}

function applyGitBadges() {
    document.querySelectorAll('.sb-row[data-path]').forEach((row) => {
        for (const cls of Array.from(row.classList)) {
            if (cls.startsWith('git-')) row.classList.remove(cls);
        }
        const key = row.dataset.path.replace(/\\/g, '/').replace(/\/+$/, '');
        const st = gitStateCache.map.get(key);
        // 已删除文件磁盘上不存在、不会出现在文件树；灰色删除态只在 Git 提交面板显示
        if (st && st !== 'deleted') row.classList.add('git-' + st);
        else if (gitStateCache.ignoredSet.has(key)) row.classList.add('git-ignored');
    });
}

const gitBadgeObserver = new MutationObserver(() => applyGitBadges());

function restartGitTimer() {
    if (gitTimer) clearInterval(gitTimer);
    const sec = Math.max(1, deps.settings.treeRefreshInterval || 3);
    gitTimer = setInterval(refreshGitStatus, sec * 1000);
}

function applyGitDot() {
    if (deps.els.abGit) deps.els.abGit.classList.toggle('has-changes', gitStateCache.map.size > 0);
}

async function showGitRecentLog() {
    if (!deps.backend.GitRecentLogFor) {
        deps.flash('当前版本不支持查看提交历史', true);
        return;
    }
    const dir = gitStateCache.dir || gitRootDir();
    if (!dir) {
        deps.flash('请先打开一个文件或目录', true);
        return;
    }
    try {
        const log = await deps.backend.GitRecentLogFor(dir, 100);
        deps.openVirtualDoc('Git 最近提交.gitlog', log || '（没有提交）');
    } catch (e) {
        deps.flash('读取提交历史失败：' + e, true);
    }
}

async function showGitFileHistory(path) {
    if (!deps.backend.GitFileHistoryFor) {
        deps.flash('当前版本不支持查看文件历史', true);
        return;
    }
    const dir = gitStateCache.dir || gitRootDir();
    if (!dir) return;
    try {
        const log = await deps.backend.GitFileHistoryFor(dir, path, 50);
        deps.openVirtualDoc('Git 文件历史 — ' + path.replace(/^.*[\\/]/, '') + '.history', log || '（该文件没有提交历史）');
    } catch (e) {
        deps.flash('读取文件历史失败：' + e, true);
    }
}

async function gitRollbackPaths(paths, untracked) {
    if (!deps.backend.GitRollbackFor) {
        deps.flash('当前版本不支持回滚', true);
        return;
    }
    const root = gitStateCache.dir || gitRootDir();
    const tracked = paths.filter((p) => !untracked.includes(p));
    const realUntracked = untracked.filter((p) => untracked.includes(p));
    try {
        await deps.backend.GitRollbackFor(root, tracked, realUntracked);
        deps.flash('已回滚 ' + (tracked.length + realUntracked.length) + ' 个文件');
    } catch (e) {
        deps.flash('回滚失败：' + e, true);
    }
    await refreshGitStatus();
    deps.renderGitPanel();
}

async function showGitDiff(path) {
    if (!deps.backend.GitDiffFor) return;
    try {
        const res = await deps.backend.GitDiffFor(gitStateCache.dir || gitRootDir(), path);
        if (!res || !res.hasChanges) {
            deps.flash('该文件暂无差异');
            return;
        }
        deps.openVirtualDoc('Git 差异 — ' + path.replace(/^.*[\\/]/, '') + '.diff', res.diff);
    } catch (e) {
        deps.flash('读取差异失败：' + e, true);
    }
}


try {
    if (deps.els.sbBody) gitBadgeObserver.observe(deps.els.sbBody, {childList: true, subtree: false});
    restartGitTimer();
    refreshGitStatus();
    if (deps.settings.sidebarView === 'git') deps.switchSidebarView('git');
} catch (e) {
    window.__gitInitErr = String((e && e.stack) || e);
}
deps.initCodeFoldHover();


return {gitGroupCollapsed, gitStateCache, gitRootDir, notifyAIGitEntry, refreshGitStatus,
        showGitDiff, showGitFileHistory, showGitRecentLog, gitRollbackPaths};
}
