// terminal-ui.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 内置终端 / 侧栏与底部面板 / git 面板；运行接线与会话管理已拆到同目录兄弟模块。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {iconSvg} from '../core/icons.js';
import {createRunUI} from './run-ui.js';
import {createTerminalSessions} from './terminal-sessions.js';
import {createGitGraph} from '../git-graph/git-graph.js';

export function createTerminalUI(deps) {

const terminalUI = {open: false, sessions: new Map(), order: [], activeId: null};
const TERM_SHELL_LABELS = {pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt', gitbash: 'Git Bash'};
const cmdOutHandlers = new Map();
const cmdExitHandlers = new Map();
let cmdSeq = 0;

// 运行接线与会话管理经 Object.create 委托原 deps（getter 仍惰性），只补它们需要的宿主能力
const runDeps = Object.create(deps);
runDeps.toggleTerminalPanel = toggleTerminalPanel;
runDeps.toggleDockView = toggleDockView;
const runMod = createRunUI(runDeps);

const sessDeps = Object.create(deps);
sessDeps.terminalUI = terminalUI;
sessDeps.TERM_SHELL_LABELS = TERM_SHELL_LABELS;
sessDeps.termCwd = termCwd;
sessDeps.termTheme = termTheme;
sessDeps.toggleTerminalPanel = toggleTerminalPanel;
sessDeps.runGitCommit = runGitCommit;
const sessMod = createTerminalSessions(sessDeps);

// AI 面板初始化必须在 terminalUI 等模块级声明之后：面板若按上次状态自动打开，
// open() → onLayout 会同步引用这些声明，放在前面会触发 TDZ 中断整个模块求值。
deps.initAIPanel();
let mockBgSeq = 0; // mock 后台作业编号
let mockSchedSeq = 0; // mock 定时任务编号



// gitRelParentDir 返回 path 相对仓库根的父目录（JetBrains 式灰字，Windows 反斜杠显示）。
function gitRelParentDir(path) {
    const root = (deps.gitStateCache.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const p = String(path || '').replace(/\\/g, '/');
    if (!root || !p.toLowerCase().startsWith(root.toLowerCase() + '/')) return '';
    const rel = p.slice(root.length + 1);
    const idx = rel.lastIndexOf('/');
    if (idx <= 0) return '';
    return rel.slice(0, idx).replace(/\//g, '\\');
}

function renderGitPanel() {
    if (!deps.els.gitChanges) return;
    const available = deps.gitStateCache.available && deps.gitStateCache.dir;
    deps.els.gitBranch.textContent = deps.gitStateCache.branch ? '分支：' + deps.gitStateCache.branch : '';
    if (!available) {
        deps.els.gitHint.textContent = deps.gitStateCache.reason || '当前目录不在 git 仓库内';
        deps.els.gitChanges.innerHTML = '';
        deps.els.gitCommitBtn.disabled = true;
        deps.els.gitCommitPushBtn.disabled = true;
        return;
    }
    deps.els.gitHint.textContent = '';
    deps.els.gitCommitBtn.disabled = false;
    deps.els.gitCommitPushBtn.disabled = false;
    const changes = [];
    const untracked = [];
    for (const [path, state] of deps.gitStateCache.map) {
        if (state === 'untracked') untracked.push(path);
        else changes.push({path, state});
    }
    deps.els.gitChanges.textContent = '';
    if (!changes.length && !untracked.length) {
        const empty = document.createElement('div');
        empty.className = 'git-empty';
        empty.textContent = '（工作区干净，没有变更）';
        deps.els.gitChanges.appendChild(empty);
        return;
    }
    const makeRow = (path, checked, state) => {
        const row = document.createElement('label');
        row.className = 'git-file-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.dataset.path = path;
        // 勾选状态写入共享集合，跨轮询重渲染保留
        cb.addEventListener('change', () => {
            if (cb.checked) deps.gitUncheckedFiles.delete(path);
            else deps.gitUncheckedFiles.add(path);
        });
        const name = document.createElement('span');
        name.className = 'git-fname git-st-' + (state || 'modified');
        name.textContent = path.replace(/^.*[\\/]/, '');
        row.append(cb, name);
        // JetBrains 式：文件名后跟一行淡灰小字 = 相对仓库根的父目录
        const relParent = gitRelParentDir(path);
        if (relParent) {
            const dirSpan = document.createElement('span');
            dirSpan.className = 'git-fpath';
            dirSpan.textContent = relParent;
            row.append(dirSpan);
        }
        row.dataset.tip = path;
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!deps.ctxMenu) return;
            const isUntracked = deps.gitStateCache.untrackedSet.has(path);
            deps.ctxMenu.open([
                {label: '查看差异', icon: 'E8D3', action: () => deps.showGitDiff(path)},
                {label: '文件历史', icon: 'E81C', action: () => deps.showGitFileHistory(path)},
                {sep: true},
                {label: '回滚更改', icon: 'E7A7', danger: true, action: () => {
                    const what = isUntracked ? '该文件未被版本管理，回滚将删除文件：' : '将丢弃该文件的全部未提交修改：';
                    deps.openConfirmDialog(what + '\n' + path, () => deps.gitRollbackPaths([path], isUntracked ? [path] : []), '回滚', '回滚更改', 'danger');
                }},
            ], e.clientX, e.clientY);
        });
        return row;
    };
    // 分组块：组头勾选框 = 全选/全不选该组文件（JetBrains 式，支持半选态）；组头箭头与文件勾选态均跨轮询重渲染保留
    const makeGroupBlock = (title, rows, key) => {
        const block = document.createElement('div');
        block.className = 'git-group-block';
        const head = document.createElement('div');
        head.className = 'git-group';
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'git-chev';
        // 箭头方向自明，不再挂 data-tip；展开态与可访问名走原生属性
        chev.setAttribute('aria-label', title + '（展开或收起）');
        chev.setAttribute('aria-expanded', String(!deps.gitGroupCollapsed[key]));
        chev.innerHTML = iconSvg(deps.gitGroupCollapsed[key] ? 'chevron-right' : 'chevron-down', 10);
        const gcb = document.createElement('input');
        gcb.type = 'checkbox';
        gcb.className = 'git-group-cb';
        const label = document.createElement('span');
        label.textContent = title;
        head.append(chev, gcb, label);
        const rowsWrap = document.createElement('div');
        rowsWrap.className = 'git-group-rows' + (deps.gitGroupCollapsed[key] ? ' collapsed' : '');
        const rowCbs = () => [...rowsWrap.querySelectorAll('.git-file-row input[type="checkbox"]')];
        const updateGroupState = () => {
            const cbs = rowCbs();
            const checkedCount = cbs.filter((c) => c.checked).length;
            gcb.checked = cbs.length > 0 && checkedCount === cbs.length;
            gcb.indeterminate = checkedCount > 0 && checkedCount < cbs.length;
        };
        gcb.addEventListener('change', () => {
            for (const c of rowCbs()) {
                c.checked = gcb.checked;
                // 组头全选/全不选是程序赋值，不触发行 change 事件，这里手动同步集合
                if (gcb.checked) deps.gitUncheckedFiles.delete(c.dataset.path);
                else deps.gitUncheckedFiles.add(c.dataset.path);
            }
            updateGroupState();
        });
        chev.addEventListener('click', () => {
            deps.gitGroupCollapsed[key] = !deps.gitGroupCollapsed[key];
            rowsWrap.classList.toggle('collapsed', deps.gitGroupCollapsed[key]);
            chev.innerHTML = iconSvg(deps.gitGroupCollapsed[key] ? 'chevron-right' : 'chevron-down', 10);
        });
        block.append(head, rowsWrap);
        for (const row of rows) {
            rowsWrap.append(row);
            row.querySelector('input[type="checkbox"]').addEventListener('change', updateGroupState);
        }
        updateGroupState();
        return block;
    };
    if (changes.length) {
        const rows = changes.map((item) => {
            const row = makeRow(item.path, !deps.gitUncheckedFiles.has(item.path), item.state);
            row.querySelector('input').dataset.path = item.path;
            row.addEventListener('dblclick', () => deps.showGitDiff(item.path));
            return row;
        });
        deps.els.gitChanges.appendChild(makeGroupBlock('更改（' + changes.length + ' 个文件）', rows, 'changes'));
    }
    if (untracked.length) {
        const rows = untracked.map((path) => {
            const row = makeRow(path, !deps.gitUncheckedFiles.has(path), 'untracked');
            row.addEventListener('dblclick', () => deps.showGitDiff(path));
            return row;
        });
        deps.els.gitChanges.appendChild(makeGroupBlock('未进行版本管理的文件（' + untracked.length + ' 个文件）', rows, 'untracked'));
    }
}

function currentSidebarView() {
    if (deps.settings.sidebarView === 'git' || deps.settings.sidebarView === 'structure' || deps.settings.sidebarView === 'chats') return deps.settings.sidebarView;
    return 'files';
}

function switchSidebarView(view) {
    if (!['files', 'git', 'structure', 'chats'].includes(view)) view = 'files';
    deps.settings.sidebarView = view;
    if (deps.structurePanel && view === 'structure') deps.structurePanel.setDoc(deps.file);
    deps.applySettings();
    if (view === 'git') {
        deps.refreshGitStatus().then(() => renderGitPanel()).catch(() => renderGitPanel());
    }
}

function toggleSidebarView(view) {
    if (deps.settings.showSidebar && currentSidebarView() === view) {
        deps.settings.showSidebar = false;
    } else {
        deps.settings.showSidebar = true;
        switchSidebarView(view);
    }
    deps.applySettings();
}

function termCwd() {
    return deps.workspaceFolder || (deps.file && deps.file.path ? deps.file.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
}

function termTheme() {
    const cs = getComputedStyle(document.documentElement);
    return {
        background: cs.getPropertyValue('--bg').trim() || '#1e1f24',
        foreground: cs.getPropertyValue('--text').trim() || '#e0e0e0',
        cursor: cs.getPropertyValue('--accent').trim() || '#4f8cff',
        cursorAccent: cs.getPropertyValue('--bg').trim() || '#1e1f24',
        selectionBackground: '#88888855',
    };
}

function toggleTerminalPanel(force) {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const show = force === undefined ? !terminalUI.open : force;
    if (show) {
        panel.classList.remove('hidden');
        terminalUI.open = true;
        if (dockView === 'terminal' && !terminalUI.sessions.size) sessMod.createTermSession();
        applyDockView();
    } else {
        panel.classList.add('hidden');
        terminalUI.open = false;
        applyDockView();
    }
}

let dockView = 'terminal'; // 底部面板当前内容：'terminal' | 'debug' | 'run' | 'graph'

// Git 图谱域模块（懒初始化：首次切到该视图才建实例并拉数据）
let gitGraphMod = null;
function getGitGraph() {
    if (!gitGraphMod) {
        // 注入宿主能力（关闭面板），与 runDeps / sessDeps 同款
        const graphDeps = Object.create(deps);
        graphDeps.toggleTerminalPanel = toggleTerminalPanel;
        gitGraphMod = createGitGraph(graphDeps);
    }
    return gitGraphMod;
}

// 应用底部面板视图：终端、调试控制台、运行面板与 Git 图谱共用同一个容器
function applyDockView() {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    const termOpen = terminalUI.open && dockView === 'terminal';
    const debugOpen = terminalUI.open && dockView === 'debug';
    const runOpen = terminalUI.open && dockView === 'run';
    const graphOpen = terminalUI.open && dockView === 'graph';
    const head = panel.querySelector('.term-head');
    if (head) head.classList.toggle('hidden', terminalUI.open && dockView !== 'terminal');
    const termBody = document.getElementById('term-body');
    if (termBody) termBody.classList.toggle('hidden', terminalUI.open && dockView !== 'terminal');
    const debugView = document.getElementById('debug-view');
    if (debugView) debugView.classList.toggle('hidden', !debugOpen);
    const runView = document.getElementById('run-view');
    if (runView) runView.classList.toggle('hidden', !runOpen);
    const graphView = document.getElementById('git-graph-view');
    if (graphView) graphView.classList.toggle('hidden', !graphOpen);
    if (deps.els.abTerminal) {
        deps.els.abTerminal.classList.toggle('active', termOpen);
        deps.els.abTerminal.setAttribute('aria-pressed', String(termOpen));
    }
    if (deps.els.abDebug) {
        deps.els.abDebug.classList.toggle('active', debugOpen);
        deps.els.abDebug.setAttribute('aria-pressed', String(debugOpen));
    }
    if (deps.els.abGitGraph) {
        deps.els.abGitGraph.classList.toggle('active', graphOpen);
        deps.els.abGitGraph.setAttribute('aria-pressed', String(graphOpen));
    }
    // tb-run 是动作按钮（点击即运行），不随运行面板开关显示选中态
    if (termOpen) sessMod.fitActiveTerm();
    if (graphOpen) getGitGraph().show();
}

// 左下活动栏 / 菜单 / F12 的统一入口：同一视图再点一次收起，不同视图则切换
function toggleDockView(view) {
    const target = view === 'debug' ? 'debug' : (view === 'run' ? 'run' : (view === 'graph' ? 'graph' : 'terminal'));
    const panel = document.getElementById('terminal-panel');
    if (!panel) return;
    if (!terminalUI.open) {
        dockView = target;
        toggleTerminalPanel(true);
        return;
    }
    if (dockView !== target) {
        dockView = target;
        if (target === 'terminal' && !terminalUI.sessions.size) sessMod.createTermSession();
        applyDockView();
        return;
    }
    if (target === 'run') {
        // 运行面板再次点击不收起：它承载的是运行结果，收起会让人以为结果丢了
        applyDockView();
        return;
    }
    toggleTerminalPanel(false);
}


deps.els.gitRecentLog.addEventListener('click', () => deps.showGitRecentLog());
deps.els.gitCommitBtn.addEventListener('click', () => runGitCommit(false));
deps.els.gitCommitPushBtn.addEventListener('click', () => runGitCommit(true));

function collectCheckedPaths() {
    return [...deps.els.gitChanges.querySelectorAll('.git-file-row input[type="checkbox"]:checked')].map((cb) => cb.dataset.path);
}

async function runGitCommit(push) {
    if (!deps.backend.GitCommitChanges) {
        deps.flash('当前版本不支持 git 提交', true);
        return;
    }
    const paths = collectCheckedPaths();
    const message = deps.els.gitMessage.value.trim();
    const amend = deps.els.gitAmend.checked;
    if (!amend && !message) {
        deps.flash('请填写提交消息', true);
        deps.els.gitMessage.focus();
        return;
    }
    if (!paths.length && !amend) {
        deps.flash('请勾选要提交的文件', true);
        return;
    }
    deps.els.gitCommitBtn.disabled = true;
    deps.els.gitCommitPushBtn.disabled = true;
    try {
        const res = await deps.backend.GitCommitChanges(deps.gitStateCache.dir, message, paths, amend, push);
        const tail = (res.output || '').trim().split('\n').slice(-4).join('\n');
        if (res.success) {
            deps.flash((push ? '提交并推送完成' : '提交完成') + (tail ? '：' + tail : ''));
            deps.els.gitMessage.value = '';
        } else {
            deps.flash('git 提交失败：' + (tail || '无输出'), true);
        }
    } catch (e) {
        deps.flash('git 提交失败：' + e, true);
    } finally {
        deps.els.gitCommitBtn.disabled = false;
        deps.els.gitCommitPushBtn.disabled = false;
        await deps.refreshGitStatus();
        renderGitPanel();
    }
}

if (deps.els.termNew) deps.els.termNew.addEventListener('click', () => sessMod.createTermSession());
if (deps.els.termShellMenu) deps.els.termShellMenu.addEventListener('click', () => sessMod.showTermShellMenu());



if (deps.els.terminalPanel && deps.settings.terminalHeight) {
    deps.els.terminalPanel.style.height = deps.settings.terminalHeight + 'px';
}
if (deps.els.sidebarResize) {
    let sidebarResizing = false;
    let sidebarStartX = 0;
    let sidebarStartW = 0;
    deps.els.sidebarResize.addEventListener('mousedown', (e) => {
        if (!deps.settings.showSidebar) return;
        sidebarResizing = true;
        sidebarStartX = e.clientX;
        sidebarStartW = deps.els.sidebar.offsetWidth;
        deps.setDragCursor('ew');
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!sidebarResizing) return;
        const w = Math.min(500, Math.max(160, sidebarStartW + (e.clientX - sidebarStartX)));
        deps.els.sidebar.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!sidebarResizing) return;
        sidebarResizing = false;
        deps.setDragCursor(null);
        document.body.style.userSelect = '';
        deps.settings.sidebarWidth = Math.min(500, Math.max(160, deps.els.sidebar.offsetWidth));
        deps.applySettings();
    });
}

if (deps.els.terminalResize) {
    let termResizing = false;
    let termResizeStartY = 0;
    let termResizeStartH = 0;
    // 高度上限放开到窗口 85%（IDEA 式可铺很高），但至少给顶条留 240px
    // （AI 面板贴底堆叠区需要立足之地）；极小窗口兜底 120px
    const maxPanelH = () => Math.max(120, Math.min(window.innerHeight * 0.85, window.innerHeight - 240));
    deps.els.terminalResize.addEventListener('mousedown', (e) => {
        if (!terminalUI.open) return;
        termResizing = true;
        termResizeStartY = e.clientY;
        termResizeStartH = deps.els.terminalPanel.offsetHeight;
        deps.setDragCursor('ns');
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!termResizing) return;
        const h = Math.min(maxPanelH(), Math.max(120, termResizeStartH + (termResizeStartY - e.clientY)));
        deps.els.terminalPanel.style.height = h + 'px';
        sessMod.fitActiveTerm();
    });
    window.addEventListener('mouseup', () => {
        if (!termResizing) return;
        termResizing = false;
        deps.setDragCursor(null);
        sessMod.fitActiveTerm();
        deps.settings.terminalHeight = Math.min(maxPanelH(), Math.max(120, deps.els.terminalPanel.offsetHeight));
        deps.applySettings();
    });
}

    function getDockView() { return dockView; }
    function setDockView(v) { dockView = v; }
    function nextCmdSeq() { return ++cmdSeq; }
    function nextMockBgSeq() { return ++mockBgSeq; }
    function nextMockSchedSeq() { return ++mockSchedSeq; }

    return {
        ...runMod, ...sessMod,
        applyDockView, renderGitPanel, cmdExitHandlers, cmdOutHandlers, currentSidebarView,
        switchSidebarView, termCwd, terminalUI, toggleDockView, toggleSidebarView, toggleTerminalPanel,
        getDockView, setDockView, nextCmdSeq, nextMockBgSeq, nextMockSchedSeq,
    };
}
