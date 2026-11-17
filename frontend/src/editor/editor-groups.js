// editor-groups.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 编辑器分栏（编辑器组 + 二叉分割树，VS Code 式）
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import DOMPurify from 'dompurify';
import {iconSvg} from '../core/icons.js';
import {isDocReadOnly, isTabReadOnlyFixed, isTabReadOnlyLocked} from '../core/readonly.js';
import {createEditorAceHooks} from './editor-ace-hooks.js';
import {createEditorCsvView} from './editor-csv-view.js';
import {createEditorSplitPreview} from './editor-split-preview.js';
import {createEditorBrowserTab} from './editor-browser-tab.js';
import {createEditorSqlView} from './editor-sql-view.js';
import {createEditorDocExtras} from './editor-doc-extras.js';
import {createEditorExportMenus} from './editor-export-menus.js';
import {createFileIcon, fileIconSpec} from '../core/fileicons.js';
import {formats, detectFormat, defaultMediaMode, isKnownCodeFileName} from '../core/formats.js';
import {showPatchView, disposePatchView} from './patch-view.js';

export function createEditorGroups(deps) {

let editorGroups = [];
let splitRoot = null;
let focusedGroupId = null;
let groupSeq = 0;
let dragTabId = null;
let dragTabGroupId = null;
let dropZone = null;
const SPLIT_MAX_DEPTH = 3;
const SPLIT_MIN_W = 240;
const SPLIT_MIN_H = 180;

// ---- Ace 会话钩子域：applyAceMode / 折叠范围 / 多光标 / python token（editor-ace-hooks.js） ----
const aceHooks = createEditorAceHooks(deps);
const applyAceMode = (...a) => aceHooks.applyAceMode(...a);
const hookCodeFoldRanges = (...a) => aceHooks.hookCodeFoldRanges(...a);
const hookMultiCursor = (...a) => aceHooks.hookMultiCursor(...a);
const initCodeFoldHover = (...a) => aceHooks.initCodeFoldHover(...a);

// ---- CSV/TSV 表格视图域（editor-csv-view.js） ----
const csvDeps = Object.create(deps);
csvDeps.markDocDirty = (...a) => markDocDirty(...a);
csvDeps.updateStatus = (...a) => updateStatus(...a);
const csvView = createEditorCsvView(csvDeps);
const createCsvTableView = (...a) => csvView.createCsvTableView(...a);
const renderCsvTableView = (...a) => csvView.renderCsvTableView(...a);
const tableHistory = (...a) => csvView.tableHistory(...a);
const showCsvTableView = (...a) => csvView.showCsvTableView(...a);
const flushCsvCellEditor = (...a) => csvView.flushCsvCellEditor(...a);
const applyCsvTableZoom = (...a) => csvView.applyCsvTableZoom(...a);
const zoomCsvTable = (...a) => csvView.zoomCsvTable(...a);
const enterCsvTable = (...a) => csvView.enterCsvTable(...a);
const leaveCsvTable = (...a) => csvView.leaveCsvTable(...a);

// ---- 分屏与预览视图域（editor-split-preview.js） ----
const spDeps = Object.create(deps);
spDeps.applyAceMode = (...a) => applyAceMode(...a);
spDeps.updateStatus = (...a) => updateStatus(...a);
spDeps.showBanner = (...a) => showBanner(...a);
spDeps.syncTabViewTools = (...a) => syncTabViewTools(...a);
spDeps.patchMarkdownPreview = (...a) => exportMenus.patchMarkdownPreview(...a);
spDeps.renderMarkdownBlocksHtml = (...a) => exportMenus.renderMarkdownBlocksHtml(...a);
const splitPreview = createEditorSplitPreview(spDeps);
const createMarkdownPreview = (...a) => splitPreview.createMarkdownPreview(...a);
const renderMarkdownPreview = (...a) => splitPreview.renderMarkdownPreview(...a);
const showMarkdownPreview = (...a) => splitPreview.showMarkdownPreview(...a);
const enterMarkdownPreview = (...a) => splitPreview.enterMarkdownPreview(...a);
const leaveMarkdownPreview = (...a) => splitPreview.leaveMarkdownPreview(...a);
const mdSyncScrollFromAce = (...a) => splitPreview.mdSyncScrollFromAce(...a);
const scheduleSplitPreview = (...a) => splitPreview.scheduleSplitPreview(...a);
const enterSplitView = (...a) => splitPreview.enterSplitView(...a);
const exitSplitView = (...a) => splitPreview.exitSplitView(...a);
const createImageView = (...a) => splitPreview.createImageView(...a);
const showImageView = (...a) => splitPreview.showImageView(...a);
const enterImageView = (...a) => splitPreview.enterImageView(...a);
const createVideoView = (...a) => splitPreview.createVideoView(...a);
const showVideoView = (...a) => splitPreview.showVideoView(...a);
const hideVideoView = (...a) => splitPreview.hideVideoView(...a);
const enterVideoView = (...a) => splitPreview.enterVideoView(...a);
const pauseVideoInDoc = (...a) => splitPreview.pauseVideoInDoc(...a);
const releaseVideo = (...a) => splitPreview.releaseVideo(...a);
const createAudioView = (...a) => splitPreview.createAudioView(...a);
const showAudioView = (...a) => splitPreview.showAudioView(...a);
const hideAudioView = (...a) => splitPreview.hideAudioView(...a);
const enterAudioView = (...a) => splitPreview.enterAudioView(...a);
const pauseAudioInDoc = (...a) => splitPreview.pauseAudioInDoc(...a);
const releaseAudio = (...a) => splitPreview.releaseAudio(...a);
const applyImageZoom = (...a) => splitPreview.applyImageZoom(...a);
const zoomImageBy = (...a) => splitPreview.zoomImageBy(...a);
const enterSvgRender = (...a) => splitPreview.enterSvgRender(...a);
const hideSvgRender = (...a) => splitPreview.hideSvgRender(...a);
const zoomSvgRenderBy = (...a) => splitPreview.zoomSvgRenderBy(...a);
const enterBinaryView = (...a) => splitPreview.enterBinaryView(...a);
const enterTextView = (...a) => splitPreview.enterTextView(...a);

// ---- 浏览器标签域（editor-browser-tab.js） ----
const browserTabDeps = Object.create(deps);
browserTabDeps.renderTabs = (...a) => renderTabs(...a);
browserTabDeps.setFilename = (...a) => setFilename(...a);
const browserTab = createEditorBrowserTab(browserTabDeps);
const createBrowserView = (...a) => browserTab.createBrowserView(...a);
const syncBrowserTab = (...a) => browserTab.syncBrowserTab(...a);
const syncAllBrowserTabs = (...a) => browserTab.syncAllBrowserTabs(...a);
const updateBrowserTitle = (...a) => browserTab.updateBrowserTitle(...a);
const setBrowserViewport = (...a) => browserTab.setBrowserViewport(...a);
const browserViewportLabel = (...a) => browserTab.browserViewportLabel(...a);

// ---- SQL 查询视图域（editor-sql-view.js） ----
const sqlDeps = Object.create(deps);
sqlDeps.updateStatus = (...a) => updateStatus(...a);
sqlDeps.exitSplitView = (...a) => exitSplitView(...a);
const sqlView = createEditorSqlView(sqlDeps);
const disposeSqlDoc = (...a) => sqlView.disposeSqlDoc(...a);
const closeSqlView = (...a) => sqlView.closeSqlView(...a);
const enterSqlView = (...a) => sqlView.enterSqlView(...a);

// ---- 文档周边杂项域（editor-doc-extras.js） ----
const extrasDeps = Object.create(deps);
extrasDeps.groupDocs = (...a) => groupDocs(...a);
extrasDeps.groupOfDoc = (...a) => groupOfDoc(...a);
extrasDeps.updateStatus = (...a) => updateStatus(...a);
extrasDeps.closeDocsWithConfirm = (...a) => closeDocsWithConfirm(...a);
extrasDeps.requestCloseDoc = (...a) => requestCloseDoc(...a);
extrasDeps.showPathInFolder = (...a) => showPathInFolder(...a);
extrasDeps.reopenClosedTab = (...a) => reopenClosedTab(...a);
extrasDeps.renderMarkdownPreview = (...a) => renderMarkdownPreview(...a);
extrasDeps.syncTabViewTools = (...a) => syncTabViewTools(...a);
const docExtras = createEditorDocExtras(extrasDeps);
const hideBanner = (...a) => docExtras.hideBanner(...a);
const dismissBanner = (...a) => docExtras.dismissBanner(...a);
const showBanner = (...a) => docExtras.showBanner(...a);
const humanizeCounts = (...a) => docExtras.humanizeCounts(...a);
const renderBookmarks = (...a) => docExtras.renderBookmarks(...a);
const toggleBookmark = (...a) => docExtras.toggleBookmark(...a);
const jumpBookmark = (...a) => docExtras.jumpBookmark(...a);
const applyPendingDocView = (...a) => docExtras.applyPendingDocView(...a);
const rememberDocView = (...a) => docExtras.rememberDocView(...a);
const scheduleGitGutter = (...a) => docExtras.scheduleGitGutter(...a);
const expandAllWithGuard = (...a) => docExtras.expandAllWithGuard(...a);
const setupTreeContextMenu = (...a) => docExtras.setupTreeContextMenu(...a);

// ---- Markdown 块渲染与导出菜单域（editor-export-menus.js） ----
const menusDeps = Object.create(deps);
menusDeps.renderMarkdownPreview = (...a) => renderMarkdownPreview(...a);
menusDeps.updateStatus = (...a) => updateStatus(...a);
menusDeps.closeDocsWithConfirm = (...a) => closeDocsWithConfirm(...a);
menusDeps.requestCloseDoc = (...a) => requestCloseDoc(...a);
menusDeps.showPathInFolder = (...a) => showPathInFolder(...a);
menusDeps.openWithDefaultApp = (...a) => openWithDefaultApp(...a);
menusDeps.reopenClosedTab = (...a) => reopenClosedTab(...a);
menusDeps.groupDocs = (...a) => groupDocs(...a);
menusDeps.groupOfDoc = (...a) => groupOfDoc(...a);
const exportMenus = createEditorExportMenus(menusDeps);
const showSvgMenu = (...a) => exportMenus.showSvgMenu(...a);
const showImageMenu = (...a) => exportMenus.showImageMenu(...a);
const showMdPreviewMenu = (...a) => exportMenus.showMdPreviewMenu(...a);
const showTabMenu = (...a) => exportMenus.showTabMenu(...a);

function nextGroupId() { return 'g' + (++groupSeq); }
function groupById(gid) { return editorGroups.find((g) => g.id === gid) || null; }
function groupOfDoc(docId) { return editorGroups.find((g) => g.docIds.includes(docId)) || null; }
function groupDocs(g) { return (g ? g.docIds.map((id) => deps.docs.find((d) => d.id === id)).filter(Boolean) : []); }
function focusedGroup() { return groupById(focusedGroupId) || editorGroups[0] || null; }
function createGroup(docIds) {
    const g = { id: nextGroupId(), docIds: docIds || [], activeId: (docIds && docIds.length ? docIds[0] : null) };
    editorGroups.push(g);
    if (!focusedGroupId) focusedGroupId = g.id;
    return g;
}
// 新开文件归入当前聚焦组（多开时只 activate 最后一个，其余仍需可见）
function addDocToFocusedGroup(doc) {
    if (!doc) return null;
    const g = focusedGroup() || createGroup();
    if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    return g;
}
function leafDepth(node, gid, d) {
    if (!node) return -1;
    if (typeof node === 'string') return node === gid ? d : -1;
    const a = leafDepth(node.a, gid, d + 1);
    if (a >= 0) return a;
    return leafDepth(node.b, gid, d + 1);
}
function groupDepth(gid) { return splitRoot ? leafDepth(splitRoot, gid, 0) : 0; }
function splitReplaceLeaf(node, gid, dir, side, newGid) {
    const mkSplit = (existing) => ({ dir, ratio: 0.5, a: side === 'before' ? newGid : existing, b: side === 'before' ? existing : newGid });
    if (!node) return mkSplit(gid);
    if (typeof node === 'string') return node === gid ? mkSplit(node) : node;
    if (node.a === gid) return { dir: node.dir, ratio: node.ratio, a: mkSplit(gid), b: node.b };
    if (node.b === gid) return { dir: node.dir, ratio: node.ratio, a: node.a, b: mkSplit(gid) };
    return { dir: node.dir, ratio: node.ratio, a: splitReplaceLeaf(node.a, gid, dir, side, newGid), b: splitReplaceLeaf(node.b, gid, dir, side, newGid) };
}
function collapseTree(node) {
    if (typeof node === 'string') return groupById(node) ? node : null;
    const a = collapseTree(node.a);
    const b = collapseTree(node.b);
    if (a === null) return b;
    if (b === null) return a;
    return { dir: node.dir, ratio: node.ratio, a, b };
}
function removeGroupIfEmpty(gid) {
    if (!gid) return;
    const idx = editorGroups.findIndex((g) => g.id === gid);
    if (idx < 0) return;
    if (editorGroups[idx].docIds.length) return;
    editorGroups.splice(idx, 1);
    if (splitRoot) splitRoot = collapseTree(splitRoot);
    if (focusedGroupId === gid || !groupById(focusedGroupId)) {
        const fg = focusedGroup();
        focusedGroupId = fg ? fg.id : null;
    }
}
function moveTabInGroup(gid, srcId, targetId, before) {
    const g = groupById(gid);
    if (!g) return;
    const si = g.docIds.indexOf(srcId);
    const ti = g.docIds.indexOf(targetId);
    if (si < 0 || ti < 0 || srcId === targetId) return;
    g.docIds.splice(si, 1);
    const idx = g.docIds.indexOf(targetId);
    g.docIds.splice(before ? idx : idx + 1, 0, srcId);
    renderTabs();
}

function renderTabs() { renderEditorLayout(); }

function renderEditorLayout() {
    deps.syncRunButtonState();
    // 提示条先移出布局区，避免被整体清空
    if (deps.els.banner && deps.els.banner.parentElement === deps.els.editor) deps.els.editorArea.appendChild(deps.els.banner);
    deps.els.editor.textContent = '';
    const root = splitRoot || (focusedGroupId || (editorGroups[0] && editorGroups[0].id));
    if (!root || !editorGroups.length) return;
    buildSplitNode(deps.els.editor, root);
    deps.scheduleSessionSave();
    for (const g of editorGroups) {
        const host = deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
        if (!host) continue;
        const list = groupDocs(g);
        for (const d of list) {
            if (d.pane && d.pane.parentElement !== host) host.appendChild(d.pane);
        }
        const active = list.find((d) => d.id === g.activeId) || list[0];
        if (active) g.activeId = active.id;
        for (const d of list) {
            if (d.pane) d.pane.classList.toggle('active', d.id === g.activeId);
        }
    }
    // 提示条：放在聚焦分栏的标签条下方
    const fgWrap = deps.els.editor.querySelector('.egroup[data-gid="' + (focusedGroupId || (editorGroups[0] && editorGroups[0].id) || '') + '"]');
    if (fgWrap) {
        const fgHost = fgWrap.querySelector('.ehost');
        if (fgHost && deps.els.banner.parentElement !== fgWrap) fgWrap.insertBefore(deps.els.banner, fgHost);
    }
    // 全局 file 对齐聚焦组（直接更新 chrome，绝不递归回 renderTabs）
    if (!deps.file || !groupOfDoc(deps.file.id)) {
        const fg = focusedGroup();
        const fd = fg ? deps.docs.find((d) => d.id === fg.activeId) : null;
        if (fd) {
            deps.file = fd;
            deps.dirty = !!fd.dirty;
            // file 对齐到新活动 doc 时必须同步 currentMode，否则残留上一个 doc 的
            // 视图模式（browser doc 关闭后状态栏/工具条会卡在「网页视图」）
            deps.currentMode = deps.normalizeLegacySqlMode(fd);
        }
    }
    if (deps.file) {
        setFilename(deps.file.name, deps.file.path);
        renderBreadcrumb(deps.file.path);
        showBanner(deps.file, deps.file.parseError);
        deps.updateWindowTitle();
        updateStatus();
        deps.updateSearchState();
    }
}

function buildSplitNode(parent, node) {
    if (typeof node === 'string') { buildGroup(parent, node); return; }
    const wrap = document.createElement('div');
    wrap.className = 'esplit esplit-' + node.dir;
    const a = document.createElement('div');
    a.className = 'esplit-child';
    a.style.flexBasis = (node.ratio * 100) + '%';
    buildSplitNode(a, node.a);
    const b = document.createElement('div');
    b.className = 'esplit-child';
    buildSplitNode(b, node.b);
    wrap.append(a, makeSplitDivider(node), b);
    parent.appendChild(wrap);
}

function makeSplitDivider(node) {
    const d = document.createElement('div');
    d.className = 'esplit-divider';
    d.addEventListener('mousedown', (e) => {
        const childA = d.previousElementSibling;
        const childB = d.nextElementSibling;
        if (!childA || !childB) return;
        const horiz = node.dir === 'col';
        const start = horiz ? e.clientX : e.clientY;
        const rectA = childA.getBoundingClientRect();
        const total = horiz ? (rectA.width + childB.getBoundingClientRect().width) : (rectA.height + childB.getBoundingClientRect().height);
        const startRatio = node.ratio;
        deps.setDragCursor(horiz ? 'ew' : 'ns');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const delta = (horiz ? ev.clientX : ev.clientY) - start;
            node.ratio = Math.min(0.8, Math.max(0.2, startRatio + delta / total));
            childA.style.flexBasis = (node.ratio * 100) + '%';
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            deps.setDragCursor(null);
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    return d;
}

function buildGroup(parent, gid) {
    const g = groupById(gid);
    const wrap = document.createElement('div');
    wrap.className = 'egroup';
    wrap.dataset.gid = gid;
    const strip = document.createElement('div');
    strip.className = 'etabs';
    const single = editorGroups.length === 1 && !splitRoot;
    const hide = !g || !g.docIds.length || (deps.settings.openMode === 'window' && g.docIds.length === 1 && single);
    if (hide) strip.classList.add('hidden');
    const host = document.createElement('div');
    host.className = 'ehost';
    if (g) for (const d of groupDocs(g)) strip.appendChild(buildGroupTab(g, d, strip));
    wrap.append(strip, host);
    wireHostDnd(host, gid);
    host.addEventListener('mousedown', () => {
        if (focusedGroupId !== gid) focusGroupById(gid);
    });
    parent.appendChild(wrap);
    // 标签条右侧工具区（视图切换 + 标签页操作），每个分栏组独立一份
    if (!hide) {
        const tools = buildGroupTools(gid);
        if (tools) {
            wrap.appendChild(tools);
            const spacer = document.createElement('div');
            spacer.className = 'tb-spacer';
            spacer.style.width = tools.offsetWidth + 'px';
            strip.appendChild(spacer);
        }
    }
}

const VIEW_ICONS = {
    tree: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3.2h11M1.5 7h7.6M1.5 10.8h4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>',
    table: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M1.5 5.6h11M5.3 2.2v9.6M9 2.2v9.6" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
    sql: '<svg viewBox="0 0 14 14" aria-hidden="true"><ellipse cx="7" cy="3.2" rx="4.7" ry="1.8" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2.3 3.2v7.6c0 1 2.1 1.8 4.7 1.8s4.7-.8 4.7-1.8V3.2" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2.3 7c0 1 2.1 1.8 4.7 1.8s4.7-.8 4.7-1.8" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>',
    code: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4.4 3.6 1.7 7l2.7 3.4M9.6 3.6 12.3 7l-2.7 3.4M7.9 2.4 6.1 11.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    text: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.6h5.6L11.4 4v8.4H3z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5 7.2h4M5 9.6h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    preview: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="4.8" cy="5.3" r="1.05" fill="currentColor"/><path d="M2.6 10.4 5.8 7.3l2.3 2.3L9.8 8l1.9 2.3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
    binary: '<svg viewBox="0 0 14 14" aria-hidden="true"><text x="2" y="10.6" font-size="9" font-family="JetBrains Mono, Consolas, monospace" font-weight="700" fill="currentColor">01</text></svg>',
    video: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.6" width="11" height="8.8" rx="1.4" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M5.9 5.3l3.3 1.7-3.3 1.7z" fill="currentColor" stroke="none"/></svg>',
    audio: '<svg viewBox="0 0 14 14" aria-hidden="true"><ellipse cx="5.2" cy="9.8" rx="2.2" ry="1.7" fill="currentColor" stroke="none"/><path d="M7.4 9.8V3.2c2.6.4 3.7 1.3 3.7 2.9" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>',
    render: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 11c2.8 0 3.4-7 6.2-7 1.7 0 2 1.6 3.8 1.6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="2" cy="11" r="1.1" fill="currentColor"/><circle cx="12" cy="5.6" r="1.1" fill="currentColor"/></svg>',
    patch: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.4h10M2 7h6.4M2 10.6h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M9.6 8.2l2.4 2.4-2.4 2.4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    split: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.2" width="11" height="9.6" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 2.6v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
};
const MORE_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="2.9" r="1.25" fill="currentColor"/><circle cx="7" cy="7" r="1.25" fill="currentColor"/><circle cx="7" cy="11.1" r="1.25" fill="currentColor"/></svg>';

function viewDisabledFor(doc, mode) {
    if (!doc) return true;
    if (mode === 'image') return !doc.image;
    if (mode === 'video') return !doc.video;
    if (mode === 'audio') return !doc.audio;
    if (mode === 'binary') return !doc.binary;
    if (mode === 'tree') return !doc.treeAvailable;
    if (mode === 'preview') return !(doc.format && doc.format.preview) || !!doc.large;
    if (mode === 'table') return !(doc.format && doc.format.table);
    if (mode === 'render') return !deps.isSvgDoc(doc);
    if (mode === 'patch') return !(doc.format && doc.format.patch);
    return false;
}

function buildGroupTools(gid) {
    const g = groupById(gid);
    if (!g || !g.docIds.length) return null;
    const doc = deps.docs.find((d) => d.id === g.activeId) || groupDocs(g)[0];
    if (!doc) return null;
    const tools = document.createElement('div');
    tools.className = 'tb-tools';
    const activeMode = doc.splitActive ? 'split' : doc.mode;
    for (const [mode, label] of deps.viewOptionsFor(doc.format, doc)) {
        // 不可用的视图不显示（IDEA 只列可用视图），不摆灰态占位
        if (viewDisabledFor(doc, mode)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        // SQL 是覆盖层：选中态独立于当前视图（开着才亮），底层视图按钮保持自己的选中态
        const on = mode === 'sql' ? !!doc.sqlActive : (activeMode === mode);
        btn.className = 'tb-view' + (on ? ' active' : '');
        btn.dataset.mode = mode;
        btn.dataset.tip = label;
        btn.innerHTML = VIEW_ICONS[mode] || '';
        btn.addEventListener('click', async () => {
            if (deps.file !== doc) await activateDoc(doc);
            if (mode === 'sql') {
                deps.switchMode('sql');
            } else if (doc.splitActive || deps.currentMode !== mode) {
                deps.switchMode(mode);
            }
            renderTabs();
        });
        tools.appendChild(btn);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tb-more';
    more.dataset.tip = '标签页操作';
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        showTabbarToolsMenu(r.left, r.bottom + 4);
    });
    tools.appendChild(more);
    return tools;
}

// 视图切换不一定重建标签条（底部状态栏、设置默认视图、快捷菜单等入口只调 switchMode），
// 这里按各分栏组当前文档同步视图按钮的选中态。
function syncTabViewTools() {
    for (const wrap of document.querySelectorAll('.egroup[data-gid]')) {
        const g = groupById(wrap.dataset.gid);
        const doc = g ? (deps.docs.find((d) => d.id === g.activeId) || groupDocs(g)[0]) : null;
        const activeMode = doc ? (doc.splitActive ? 'split' : doc.mode) : '';
        for (const btn of wrap.querySelectorAll('.tb-view[data-mode]')) {
            const isSql = btn.dataset.mode === 'sql';
            btn.classList.toggle('active', isSql ? !!(doc && doc.sqlActive) : btn.dataset.mode === activeMode);
        }
    }
}

function showTabbarToolsMenu(x, y) {
    if (!deps.ctxMenu) return;
    const clean = deps.docs.filter((d) => !d.dirty);
    deps.ctxMenu.open([
        {label: '新建浏览器标签页', icon: 'E721', action: () => deps.openBrowserTab('about:blank')},
        {label: '转到文件…', shortcut: 'Ctrl+Shift+N', icon: 'E721', action: () => {}},
        {sep: true},
        {label: '关闭所有标签页', action: () => closeDocsWithConfirm(deps.docs.slice(), '关闭所有标签页将丢弃未保存的修改。')},
        {label: '关闭未修改标签页', disabled: !clean.length, action: () => closeDocsWithConfirm(clean)},
        {sep: true},
        {label: '配置编辑器标签页…', icon: 'E713', action: () => deps.openSettings('editor-tabs')},
    ], x, y);
}

function focusGroupById(gid) {
    focusedGroupId = gid;
    const g = groupById(gid);
    const d = g ? deps.docs.find((x) => x.id === g.activeId) : null;
    if (d && deps.file !== d) activateDoc(d);
}

function bgTermTabIcon() {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg('terminal', 13);
    return span;
}

// 子代理详情标签页：没有扩展名可依据，用「智能体团队」同款图标
function agentViewTabIcon() {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg('agents', 13);
    return span;
}

// 支线对话标签页：双气泡图标（与子代理的协作图区分）
function sideChatTabIcon() {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg('sidechat', 13);
    return span;
}

// 群聊标签页：双人像图标
function groupChatTabIcon() {
    const span = document.createElement('span');
    span.className = 'tab-icon';
    span.innerHTML = iconSvg('group', 13);
    return span;
}

function tabTooltip(doc) {
    const lockTip = isTabReadOnlyFixed(doc) ? '\n（只读快照，不可解锁）'
        : isTabReadOnlyLocked(doc) ? '\n（本标签只读锁定，右键可解除）' : '';
    return (doc.path || doc.name) + (doc.staleOnDisk ? '\n（已在外部修改）' : '') + lockTip;
}

function tabLockTitle(doc) {
    return isTabReadOnlyFixed(doc) ? '只读快照，不可解锁' : '本标签已只读锁定';
}

// 切换标签页只读锁后同步角标，不必重建整条标签栏。
function syncTabReadOnly(doc) {
    if (!doc) return;
    const tab = document.querySelector('.etabs .tab[data-doc-id="' + doc.id + '"]');
    if (!tab) return;
    const locked = isTabReadOnlyLocked(doc);
    tab.classList.toggle('tab-readonly', locked);
    tab.dataset.tip = tabTooltip(doc);
    const existing = tab.querySelector('.tab-lock');
    if (locked && !existing) {
        const lock = document.createElement('span');
        lock.className = 'tab-lock';
        lock.dataset.tip = tabLockTitle(doc);
        lock.innerHTML = iconSvg('lock', 12);
        const close = tab.querySelector('.tab-close');
        if (close) tab.insertBefore(lock, close);
        else tab.appendChild(lock);
    } else if (!locked && existing) {
        existing.remove();
    }
}

function buildGroupTab(g, doc, strip) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (doc.id === g.activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '') + (doc.staleOnDisk ? ' stale' : '') + (isTabReadOnlyLocked(doc) ? ' tab-readonly' : '');
    tab.dataset.docId = String(doc.id);
    tab.dataset.tip = tabTooltip(doc);
    // 后台终端 / 子代理详情标签页用固定图标（非文件，没有扩展名图标）
    const icon = doc.bgTerm ? bgTermTabIcon() : doc.agentView ? agentViewTabIcon() : doc.sideChat ? sideChatTabIcon() : doc.groupChat ? groupChatTabIcon() : createFileIcon(doc.name, 'tab-icon');
    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = doc.name;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.dataset.tip = '关闭';
    close.innerHTML = iconSvg('close', 12);
    close.addEventListener('click', (e) => {
        e.stopPropagation();
        requestCloseDoc(doc);
    });
    if (isTabReadOnlyLocked(doc)) {
        const lock = document.createElement('span');
        lock.className = 'tab-lock';
        lock.dataset.tip = tabLockTitle(doc);
        lock.innerHTML = iconSvg('lock', 12);
        tab.append(icon, dot, name, lock, close);
    } else {
        tab.append(icon, dot, name, close);
    }
    tab.addEventListener('click', (e) => {
        if (e.shiftKey && deps.settings.shiftClickClose !== false) {
            e.preventDefault();
            requestCloseDoc(doc);
            return;
        }
        activateDoc(doc);
    });
    tab.addEventListener('dblclick', () => {
        if (deps.settings.dblClickClose) requestCloseDoc(doc);
    });
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateDoc(doc);
        showTabMenu(doc, e.clientX, e.clientY);
    });
    tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            requestCloseDoc(doc);
        }
    });
    // 拖动：组内排序 + 跨区拖出分栏
    tab.draggable = true;
    const clearDropGaps = () => {
        strip.querySelectorAll('.tab.drop-gap-before, .tab.drop-gap-after').forEach((t) => {
            t.classList.remove('drop-gap-before', 'drop-gap-after');
        });
    };
    tab.addEventListener('dragstart', (e) => {
        dragTabId = doc.id;
        dragTabGroupId = g.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(doc.id)); } catch (err) {}
    });
    tab.addEventListener('dragend', () => {
        dragTabId = null;
        dragTabGroupId = null;
        tab.classList.remove('dragging');
        clearDropGaps();
        hideSplitMask();
        dropZone = null;
    });
    tab.addEventListener('dragover', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id || dragTabId === doc.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        clearDropGaps();
        if (before) tab.classList.add('drop-gap-before');
        else {
            const next = tab.nextElementSibling;
            if (next && next.classList.contains('tab')) next.classList.add('drop-gap-before');
            else tab.classList.add('drop-gap-after');
        }
    });
    tab.addEventListener('drop', (e) => {
        if (dragTabId === null || dragTabGroupId !== g.id) return;
        e.preventDefault();
        e.stopPropagation();
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.x + r.width / 2;
        clearDropGaps();
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        moveTabInGroup(g.id, srcId, doc.id, before);
    });
    if (doc.id === g.activeId) setTimeout(() => {
        try { tab.scrollIntoView({block: 'nearest', inline: 'nearest'}); } catch (err) {}
    }, 0);
    return tab;
}

function wireHostDnd(host, gid) {
    host.addEventListener('dragover', (e) => {
        if (dragTabId === null) return;
        const srcG = groupById(dragTabGroupId);
        const selfSingle = srcG && srcG.id === gid && srcG.docIds.length <= 1;
        const tg = groupById(gid);
        const canSplit = !selfSingle && !!tg && tg.docIds.length > 0 && groupDepth(gid) < SPLIT_MAX_DEPTH;
        const cell = host.parentElement;
        if (!cell) return;
        const rect = cell.getBoundingClientRect();
        const relX = (e.clientX - rect.x) / rect.width;
        const relY = (e.clientY - rect.y) / rect.height;
        let zone = 'center';
        if (canSplit) {
            if (relX < 0.25) zone = 'left';
            else if (relX > 0.75) zone = 'right';
            else if (relY < 0.25) zone = 'top';
            else if (relY > 0.75) zone = 'bottom';
        }
        if (zone === 'left' || zone === 'right') {
            if (rect.width / 2 < SPLIT_MIN_W) zone = 'center';
        } else if (zone === 'top' || zone === 'bottom') {
            if (rect.height / 2 < SPLIT_MIN_H) zone = 'center';
        }
        dropZone = { gid, zone, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        showSplitMask();
    });
    host.addEventListener('dragleave', (e) => {
        if (!host.contains(e.relatedTarget)) { hideSplitMask(); dropZone = null; }
    });
    host.addEventListener('drop', (e) => {
        if (dragTabId === null) return;
        e.preventDefault();
        e.stopPropagation();
        const dz = dropZone;
        hideSplitMask();
        dropZone = null;
        const srcId = dragTabId;
        dragTabId = null;
        dragTabGroupId = null;
        if (!dz) { renderTabs(); return; }
        try {
            performDrop(dz, srcId);
        } catch (err) {
            deps.flash('分栏失败：' + (err && err.message || err), true);
            renderTabs();
        }
    });
}

function ensureSplitMask() {
    let m = document.getElementById('split-mask');
    if (!m) {
        m = document.createElement('div');
        m.id = 'split-mask';
        deps.els.editorArea.appendChild(m);
    }
    return m;
}

function showSplitMask() {
    syncAllBrowserTabs();
    if (!dropZone) return;
    const area = deps.els.editorArea.getBoundingClientRect();
    const r = dropZone.rect;
    let mx = r.x, my = r.y, mw = r.w, mh = r.h;
    if (dropZone.zone === 'left' || dropZone.zone === 'right') mw = r.w / 2;
    if (dropZone.zone === 'right') mx = r.x + r.w / 2;
    if (dropZone.zone === 'top' || dropZone.zone === 'bottom') mh = r.h / 2;
    if (dropZone.zone === 'bottom') my = r.y + r.h / 2;
    const m = ensureSplitMask();
    m.style.left = Math.round(mx - area.x) + 'px';
    m.style.top = Math.round(my - area.y) + 'px';
    m.style.width = Math.round(mw) + 'px';
    m.style.height = Math.round(mh) + 'px';
    m.style.display = 'block';
}

function hideSplitMask() {
    const m = document.getElementById('split-mask');
    if (m) m.style.display = 'none';
    syncAllBrowserTabs();
}

function performDrop(dz, srcId) {
    const doc = deps.docs.find((d) => d.id === srcId);
    if (!doc) { renderTabs(); return; }
    const srcG = groupOfDoc(doc.id);
    if (!srcG) { renderTabs(); return; }
    if (dz.zone === 'center' || (srcG.id === dz.gid && srcG.docIds.length <= 1)) {
        activateDoc(doc);
        renderTabs();
        return;
    }
    const dir = (dz.zone === 'left' || dz.zone === 'right') ? 'col' : 'row';
    const side = (dz.zone === 'left' || dz.zone === 'top') ? 'before' : 'after';
    // 从源组移除
    srcG.docIds = srcG.docIds.filter((id) => id !== doc.id);
    if (srcG.activeId === doc.id) srcG.activeId = srcG.docIds[0] || null;
    removeGroupIfEmpty(srcG.id);
    // 目标组保留剩余文档，新组获得被拖文档
    const tg = groupById(dz.gid);
    if (!tg) { activateDoc(doc); renderTabs(); return; }
    tg.docIds = tg.docIds.filter((id) => id !== doc.id);
    if (tg.activeId === doc.id) tg.activeId = tg.docIds[0] || null;
    const ng = createGroup([doc.id]);
    ng.activeId = doc.id;
    // 单组尚未成树时以该组为根直接生成两层；已有树则替换对应叶子
    const base = splitRoot || dz.gid;
    splitRoot = (typeof base === 'string')
        ? { dir, ratio: 0.5, a: side === 'before' ? ng.id : base, b: side === 'before' ? base : ng.id }
        : splitReplaceLeaf(base, dz.gid, dir, side, ng.id);
    focusedGroupId = ng.id;
    renderTabs();
    activateDoc(doc);
}

function renderBreadcrumb(path) {
    deps.els.breadcrumb.textContent = '';
    if (!path) return;
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    let display = parts;
    if (parts.length > 6) {
        display = [parts[0], '…', ...parts.slice(-4)];
    }
    display.forEach((seg, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.innerHTML = iconSvg('chevron-right', 10);
            deps.els.breadcrumb.appendChild(sep);
        }
        const s = document.createElement('span');
        s.className = 'crumb' + (i === display.length - 1 ? ' crumb-last' : '');
        s.textContent = seg;
        deps.els.breadcrumb.appendChild(s);
    });
}

function treeHistory(action) {
    if (!deps.editor || !deps.editor.dom) return;
    const active = document.activeElement;
    if (active && deps.els.editor.contains(active) && active.blur) active.blur();
    const btn = deps.editor.dom[action];
    if (btn && !btn.disabled) btn.click();
}

function textArea() {
    if (!deps.editor) return null;
    if (deps.editor.textarea) return deps.editor.textarea;
    const pane = deps.file && deps.file.pane ? deps.file.pane : deps.els.editor;
    return pane.querySelector('textarea.jsoneditor-text');
}

function doUndo() {
    if (!deps.editor || isDocReadOnly(deps.file, deps.settings)) return;
    if (deps.currentMode === 'tree') {
        const btn = deps.editor.dom && deps.editor.dom.undo;
        if (btn && !btn.disabled) { treeHistory('undo'); return; }
    } else if (deps.currentMode === 'table') {
        if (deps.file && deps.file.tableUndo && deps.file.tableUndo.length) { tableHistory('undo'); return; }
    } else if (deps.currentMode === 'code' && deps.editor.aceEditor) {
        const um = deps.editor.aceEditor.session.getUndoManager();
        if (um && um.hasUndo()) { deps.editor.aceEditor.execCommand('undo'); return; }
    } else if (deps.currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            if (document.execCommand('undo')) return;
        }
    }
    // 操作栈为空但文件仍处于修改状态：Ctrl+Z 直接退回未修改（已保存）状态
    if (deps.file && deps.file.dirty) revertDocToSaved(deps.file);
}

// revertDocToSaved：把文档内容回退到最后一次保存（或打开/新建）时的状态
function revertDocToSaved(doc) {
    if (!doc || !doc.editor) return;
    const target = doc.savedText != null ? doc.savedText : (doc.content != null ? doc.content : '');
    let value = null;
    if (deps.currentMode === 'tree') {
        try { value = doc.format.parse(target); } catch (e) { deps.flash('无法回退：已保存内容解析失败', true); return; }
    }
    doc.loading = true;
    try {
        if (deps.currentMode === 'tree') deps.editor.set(value);
        else deps.editor.setText(target);
        doc.text = target;
        doc.bases[doc.mode] = target;
        doc.dirty = false;
        if (deps.file === doc) {
            deps.setDirty(false);
            updateStatus();
            deps.updateWindowTitle();
        }
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
        if (deps.currentMode === 'table') renderCsvTableView(doc);
    } finally {
        doc.loading = false;
    }
}

function doRedo() {
    if (!deps.editor || isDocReadOnly(deps.file, deps.settings)) return;
    if (deps.currentMode === 'tree') treeHistory('redo');
    else if (deps.currentMode === 'table') tableHistory('redo');
    else if (deps.currentMode === 'code' && deps.editor.aceEditor) deps.editor.aceEditor.execCommand('redo');
    else if (deps.currentMode === 'text') {
        const ta = textArea();
        if (ta) {
            ta.focus();
            document.execCommand('redo');
        }
    }
}

function toggleFocusedNode(action) {
    const active = document.activeElement;
    if (!active || !deps.els.editor.contains(active)) return;
    const tr = active.closest('tr');
    if (!tr) return;
    const btn = tr.querySelector('button.jsoneditor-collapsed, button.jsoneditor-expanded');
    if (!btn) return;
    const collapsed = btn.classList.contains('jsoneditor-collapsed');
    if (action === 'expand' && collapsed) btn.click();
    if (action === 'collapse' && !collapsed) btn.click();
}

// ---- 状态栏「AI 写入」徽标 ----
// 由 ai-panel 的写操作事件驱动：每次落盘推一次状态，不轮询磁盘，
// 因此外部编辑器 / git 造成的改动不会点亮它。
// 显隐沿用状态栏既有做法（切换 display），自动隐藏时长与 flash() 的 5s 对齐。

function updateStatus() {
    if (deps.aiPanel && deps.aiPanel.refreshContext) {
        try { deps.aiPanel.refreshContext(); } catch (e) {}
    }
    if (!deps.file) return;
    deps.scheduleSessionSave();
    syncTabViewTools();
    const fmt = deps.file.format;
    const view = deps.file.splitActive ? deps.viewLabel('split') : deps.viewLabel(deps.file.sqlActive ? 'sql' : deps.currentMode);
    const roSuffix = !isDocReadOnly(deps.file, deps.settings) ? ''
        : isTabReadOnlyFixed(deps.file) ? ' · 只读快照'
            : isTabReadOnlyLocked(deps.file) ? ' · 本标签只读' : ' · 只读';
    deps.els.stMode.textContent = deps.formatDisplayName(deps.file) + ' · ' + view + roSuffix;
    if (deps.file.browser) {
        const url = String(deps.file.browserUrl || '');
        deps.els.stMode.textContent = '网页 · ' + (url === 'about:blank' ? '空白页' : (url.length > 60 ? url.slice(0, 60) + '…' : url));
        deps.els.stSize.textContent = '';
        deps.els.stZoom.textContent = '';
        deps.els.stMdWidth.style.display = 'none';
        deps.els.stEol.textContent = '';
        deps.els.stEnc.textContent = '';
        const stCount = document.getElementById('st-count');
        if (stCount) stCount.textContent = '';
        if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
        deps.els.stPos.textContent = '';
        return;
    }
    deps.els.stSize.textContent = deps.fmtSize(deps.file.size);
    const tableZoom = deps.currentMode === 'table' && deps.file.format && deps.file.format.table;
    const svgScale = deps.file.svgRenderScale && (deps.currentMode === 'render' || (deps.file.splitActive && deps.file.splitKind === 'svg'));
    const renderZoom = svgScale ? Math.round(deps.file.svgRenderScale * 100) + '%' : '';
    const zoom = deps.file.image && deps.currentMode === 'image' && deps.file.imageScale
        ? Math.round(deps.file.imageScale * 100) + '%'
        : renderZoom || (tableZoom ? Math.round((deps.file.tableZoom || 1) * 100) + '%' : '');
    deps.els.stZoom.textContent = zoom;
    deps.els.stZoom.dataset.tip = zoom
        ? (tableZoom ? '表格缩放比例（点击选择，Ctrl+滚轮调整）' : '图片缩放比例（点击选择，Ctrl+滚轮调整，双击图片恢复适配）')
        : '';
    const showMdWidth = !!(deps.file.format && deps.file.format.preview && deps.currentMode === 'preview' && !deps.file.large);
    deps.els.stMdWidth.style.display = showMdWidth ? '' : 'none';
    deps.els.stMdWidth.textContent = showMdWidth ? '宽度 · ' + deps.mdPreviewWidthLabel(deps.settings.mdPreviewWidth) : '';
    deps.updateWordCount();
    deps.updateWritingStats();
    deps.applyWritingMode();
    if (deps.file.binary) {
        deps.els.stEol.textContent = '';
        deps.els.stEnc.textContent = '';
        deps.els.stEol.style.display = 'none';
        deps.els.stEnc.style.display = 'none';
        deps.scheduleCursorPosition();
        return;
    }
    deps.els.stEol.style.display = '';
    deps.els.stEnc.style.display = '';
    const eolSetting = fmt ? deps.getFormatSettings(fmt.id).eol : 'follow';
    deps.els.stEol.textContent = (eolSetting === 'follow' ? deps.file.eol : eolSetting).toUpperCase();
    const enc = (deps.file.enc || 'utf-8').toUpperCase();
    deps.els.stEnc.textContent = enc + (deps.file.hasBom && enc === 'UTF-8' ? ' BOM' : '');
    deps.scheduleCursorPosition();
    if (typeof deps.scheduleStructureRefresh === 'function') deps.scheduleStructureRefresh(deps.file);
}


function snapshotActiveDoc() {
    if (!deps.file || !deps.editor) return;
    deps.file.text = deps.editor.getText();
    deps.file.mode = deps.currentMode;
    deps.file.dirty = deps.dirty;
    if (deps.file.splitActive && deps.file.htmlFrame) deps.file.htmlFrame.srcdoc = '';
}

function markDocDirty(doc) {
    if (!doc || !doc.editor) return;
    const text = doc.editor.getText();
    doc.text = text;
    const base = doc.bases[doc.mode];
    const next = doc.untitled ? true : (base == null ? true : text !== base);
    if (deps.file === doc) {
        deps.setDirty(next);
    } else {
        doc.dirty = next;
        deps.updateTabDirty(doc);
        deps.updateBackendDirty();
    }
    if (typeof deps.scheduleStructureRefresh === 'function') {
        doc.structureRev = (doc.structureRev || 0) + 1;
        deps.scheduleStructureRefresh(doc);
    }
    if (doc.splitActive) scheduleSplitPreview(doc);
    scheduleGitGutter(doc);
}

// 补丁视图的宿主上下文：把主界面的能力（打开文件、重载、提示）注入进去，
// 补丁视图本身不直接依赖 main.js 的全局状态。
let patchViewHostCtx = null;

function patchRootPath() {
    if (deps.explorer && typeof deps.explorer.getRoot === 'function') return deps.explorer.getRoot() || '';
    return deps.workspaceFolder || '';
}

function patchAbsPath(rel) {
    const root = patchRootPath().replace(/[\\/]+$/, '');
    if (!root || !rel) return rel || '';
    return root + '/' + String(rel).replace(/\\/g, '/');
}

async function reloadAfterPatch(files) {
    // 不做整树全量刷新（清空重建会闪）；逐文件走轻量差量通知，
    // 120ms 防抖会把同一次补丁应用的多个文件合并成一次局部刷新。
    const explorer = deps.explorer;
    if (explorer && typeof explorer.notifyFileChange === 'function') {
        for (const rel of files || []) explorer.notifyFileChange(patchAbsPath(rel));
    }
    for (const rel of files || []) {
        const doc = deps.findDocByPath(patchAbsPath(rel));
        if (!doc) continue;
        if (doc.dirty) {
            deps.flash(doc.name + ' 已被补丁修改，但编辑器里有未保存内容，未自动重载', true);
            continue;
        }
        if (doc === deps.file) {
            patchViewHostCtx.suppressNotify = true;
            try { await deps.reloadActive({quiet: true}); } catch (e) {}
            patchViewHostCtx.suppressNotify = false;
        } else {
            doc.staleOnDisk = true;
        }
    }
}

function patchViewContext() {
    if (patchViewHostCtx) return patchViewHostCtx;
    patchViewHostCtx = {
        backend: deps.backend,
        suppressNotify: false,
        getRoot: patchRootPath,
        chooseFolder: (dir) => deps.backend.OpenFolderDialog(dir || ''),
        openPath: (rel) => {
            const abs = patchAbsPath(rel);
            if (abs) deps.openPath(abs);
        },
        notifyChanged: (files) => { reloadAfterPatch(files); },
        flash: (msg, isErr) => deps.flash(msg, isErr),
        openConfirmDialog: (message, action, okLabel, title, variant) => deps.openConfirmDialog(message, action, okLabel, title, variant),
    };
    return patchViewHostCtx;
}

// 补丁在代码视图里除 token 着色外，给整行铺淡底色（Ace marker，fullLine）。
// 超过 5000 行只保留 token 着色，避免 marker 过多拖慢滚动。
function refreshPatchMarkers(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || !doc.format || !doc.format.patch) return;
    const session = ace.session;
    if (!session) return;
    for (const id of (doc._patchMarkers || [])) {
        try { session.removeMarker(id); } catch (e) {}
    }
    doc._patchMarkers = [];
    const total = session.getLength();
    if (total > 5000) return;
    const aceLib = window.ace;
    if (!aceLib || typeof aceLib.require !== 'function') return;
    let Range = null;
    try { Range = aceLib.require('ace/range').Range; } catch (e) { return; }
    if (!Range) return;
    for (let row = 0; row < total; row += 1) {
        const text = session.getLine(row) || '';
        if (text.startsWith('+++') || text.startsWith('---')) continue;
        let cls = '';
        if (text.startsWith('+')) cls = 'dl-diff-add-line';
        else if (text.startsWith('-')) cls = 'dl-diff-del-line';
        if (!cls) continue;
        try {
            doc._patchMarkers.push(session.addMarker(new Range(row, 0, row, 1), cls, 'fullLine'));
        } catch (e) {
            break;
        }
    }
}


function createDocEditor(doc) {
    if (doc.editor) return;
    // 浏览器 / 后台终端视图没有 doc.editor，用 doc.pane 判断是否已建过；
    // 否则每次激活都会再建一套面板，旧面板就留在编辑器里叠着。
    if (doc.browser) {
        if (doc.pane) return;
        createBrowserView(doc);
        return;
    }
    if (doc.agentView) {
        if (doc.pane) return;
        deps.createAgentView(doc);
        return;
    }
    // 支线对话标签页：完整会话渲染在内容区（面板保持显示主对话）
    if (doc.sideChat) {
        if (doc.pane) return;
        deps.createSideChatView(doc);
        return;
    }
    // 群聊标签页：多智能体圆桌（消息 + 看板），数据在 ai-groups 独立存储
    if (doc.groupChat) {
        if (doc.pane) return;
        deps.createGroupChatView(doc);
        return;
    }
    if (doc.bgTerm) {
        if (doc.pane) return;
        deps.createBgTermView(doc);
        return;
    }
    const fmt = doc.format;
    const fs = deps.getFormatSettings(fmt.id);
    const showJsonErrors = fmt.id === 'json' && /\.json$/i.test(doc.name || '');
    const patchRequested = !!fmt.patch && (doc.mode === 'patch' || !doc.mode);
    const tableRequested = !!fmt.table && doc.mode === 'table';
    const previewRequested = !!fmt.preview && doc.mode === 'preview';
    const splitRequested = doc.mode === 'split' && !!deps.splitKindFor(doc);
    const imageRequested = !!fmt.image && doc.mode === 'image';
    const videoRequested = !!fmt.video && doc.mode === 'video';
    const audioRequested = !!fmt.audio && doc.mode === 'audio';
    const binaryMode = !!fmt.image || !!fmt.video || !!fmt.audio || fmt.id === 'bytes';
    let startMode = doc.mode === 'text' ? 'text' : (!doc.treeAvailable ? 'code' : (doc.mode === 'code' ? 'code' : 'tree'));
    if (tableRequested || patchRequested) startMode = 'text';
    if (previewRequested || splitRequested) startMode = 'code';
    let initialText = null;
    let initialValue = null;
    if (startMode === 'code' || startMode === 'text') {
        initialText = doc.content || '';
    } else {
        try {
            initialValue = fmt.parse(doc.content || '');
        } catch (e) {
            startMode = 'code';
            initialText = doc.content || '';
            doc.treeAvailable = false;
            doc.parseError = e;
        }
    }
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active';
    deps.els.editor.appendChild(pane);
    deps.installReadOnlyGuards(pane, doc);
    pane.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const fold = target.closest('.jsoneditor-value.value-fold');
        if (fold) {
            const row = fold.closest('tr.jsoneditor-expandable');
            const button = row ? row.querySelector('button.jsoneditor-collapsed') : null;
            if (button) {
                e.preventDefault();
                e.stopPropagation();
                button.click();
                queueMicrotask(humanizeCounts);
                return;
            }
        }
        if (target.closest('button.jsoneditor-collapsed, button.jsoneditor-expanded')) {
            queueMicrotask(humanizeCounts);
        }
    }, true);
    doc.loading = true;
    const ed = new JSONEditor(pane, {
        mode: startMode,
        modes: fmt.table ? ['tree', 'text'] : (doc.treeAvailable ? ['tree', 'code', 'text'] : ['code', 'text']),
        mainMenuBar: true,
        navigationBar: !fmt.rawOnly,
        statusBar: false,
        showErrorTable: showJsonErrors,
        maxVisibleChilds: deps.TREE_MAX_CHILDREN,
        language: 'zh-CN',
        languages: deps.editorLocale,
        indentation: fs.indent === 'tab' ? '\t' : Number(fs.indent),
        onChange() {
            if (doc.loading) return;
            markDocDirty(doc);
        },
        onModeChange(mode) {
            if (!doc.editor) return;
            if (doc.splitActive && mode !== 'code') exitSplitView(doc);
            doc.mode = mode;
            if (deps.file === doc) {
                deps.currentMode = mode;
                applyAceMode();
                updateStatus();
                deps.updateSearchState();
            }
            setTimeout(() => {
                if (!doc.editor || doc.mode !== mode) return;
                doc.text = doc.editor.getText();
                if (!doc.dirty) doc.bases[mode] = doc.text;
                deps.applyReadOnlyToDoc(doc);
                scheduleGitGutter(doc, 300);
            }, 0);
        },
        onError(err) {
            if (deps.file === doc) deps.flash(err.message, true);
        },
    });
    doc.editor = ed;
    doc.pane = pane;
    if (ed.aceEditor) {
        hookCodeFoldRanges(ed.aceEditor);
        hookMultiCursor(ed.aceEditor);
        ed.aceEditor.on('changeSelection', deps.scheduleWordCount);
        ed.aceEditor.on('input', deps.scheduleWordCount);
        // 写作模式：光标变化驱动打字机滚动与段落聚焦（内部自判生效条件）
        ed.aceEditor.on('changeSelection', () => deps.scheduleWritingCaret(ed.aceEditor));
        ed.aceEditor.on('input', () => deps.scheduleWritingCaret(ed.aceEditor));
    }
    if (deps.settings.treeExpandDefault === 'collapse' && startMode === 'tree' && doc.treeAvailable && !doc.large) {
        setTimeout(() => {
            try { if (doc.editor) doc.editor.collapseAll(); } catch (e) {}
        }, 50);
    }
    if (startMode === 'code' || startMode === 'text') {
        ed.setText(initialText != null ? initialText : '');
    } else {
        ed.set(initialValue);
    }
    if (isDocReadOnly(doc, deps.settings) && ed.aceEditor) {
        ed.aceEditor.setReadOnly(true);
    }
    if (ed.aceEditor) {
        try {
            ed.aceEditor.session.setUseWrapMode(!!deps.settings.codeWrap);
            ed.aceEditor.setDisplayIndentGuides(!!deps.settings.codeGuides);
            ed.aceEditor.setHighlightIndentGuides(!!deps.settings.codeGuides);
        } catch (e) {}
    }
    setupTreeContextMenu(doc);
    doc.mode = splitRequested ? 'split' : previewRequested ? 'preview' : tableRequested ? 'table' : imageRequested ? 'image' : videoRequested ? 'video' : audioRequested ? 'audio' : binaryMode ? 'binary' : startMode;
    // 补丁视图是覆盖层：底层编辑器仍按 text 起始，但 doc.mode 必须记成 patch，
    // 否则首次打开时状态栏显示补丁、视图按钮却选中文本。
    if (patchRequested) doc.mode = 'patch';
    doc.text = ed.getText();
    // 打开/恢复/重载属于程序化全文替换：清掉码字观察基线，下一次观察以当前内容重新起算
    delete doc._writingLast;
    delete doc._writingBase;
    if (fmt.table) createCsvTableView(doc);
    if (fmt.preview) createMarkdownPreview(doc);
    if (fmt.image) createImageView(doc);
    if (fmt.video) createVideoView(doc);
    if (fmt.audio) createAudioView(doc);
    if (patchRequested) showPatchView(doc, patchViewContext());
    if (tableRequested) showCsvTableView(doc);
    if (previewRequested) showMarkdownPreview(doc);
    if (imageRequested) showImageView(doc);
    if (videoRequested) showVideoView(doc);
    if (audioRequested) showAudioView(doc);
    if (!doc.dirty) doc.bases[doc.mode] = doc.text;
    deps.applyReadOnlyToDoc(doc);
    doc.content = null;
    doc.loading = false;
    if (fmt.patch) refreshPatchMarkers(doc);
    scheduleGitGutter(doc, 200);
}


function createDoc(data) {
    if (data.binary) {        return {
            id: ++deps.docSeq,
            path: data.path,
            name: data.name,
            size: data.size,
            hexShown: data.hexShown || data.size,
            eol: data.eol || 'lf',
            hasBom: false,
            large: false,
            enc: 'binary',
            content: data.content,
            format: data.image ? formats.image : (data.video ? formats.video : (data.audio ? formats.audio : formats.bytes)),
            image: !!data.image,
            video: !!data.video,
            audio: !!data.audio,
            treeAvailable: false,
            parseError: null,
            // 媒体文档首屏就是它自己的视图（规则单一来源见 core/formats.js）
            mode: defaultMediaMode(data) || 'binary',
            text: null,
            rawText: null,
            dirty: false,
            untitled: false,
            binary: true,
            bases: {tree: null, code: null},
            savedText: data.content,
            diskMtime: data.mtime || '',
            readOnlyLocked: !!data.readOnly,
            readOnlyFixed: !!data.readOnlyFixed,
        };
    }
    const preview = detectFormat(data.name, '');
    const fsPreview = deps.getFormatSettings(preview.id);
    const format = detectFormat(data.name, data.content, {indent: fsPreview.indent});
    const fs = deps.getFormatSettings(format.id);
    let treeAvailable = !(data.large || format.rawOnly);
    let parseError = null;
    if (treeAvailable && !String(data.content || '').trim()) {
        treeAvailable = false;
    } else if (treeAvailable) {
        try {
            format.parse(data.content);
        } catch (e) {
            treeAvailable = false;
            parseError = e;
        }
    }
    const ext = String(data.name || '').split('.').pop().toLowerCase();
    // CMakeLists.txt / Makefile / .gitignore 等已知文件名按代码视图打开（带语法高亮），不算纯文本
    const plainTextView = format.id === 'text' && deps.plainTextExtensions.has(ext)
        && !isKnownCodeFileName(data.name) && !data.large;
    const preferredMode = plainTextView ? 'text' : format.preview
        ? (['split', 'preview', 'code', 'text'].includes(fs.view) ? fs.view : 'preview')
        : format.table
            ? (['table', 'tree', 'text'].includes(fs.view) ? fs.view : 'table')
            : (fs.view === 'code' || fs.view === 'text' ? fs.view : 'tree');
    return {
        id: ++deps.docSeq,
        path: data.path,
        name: data.name,
        size: data.size,
        eol: data.eol,
        hasBom: data.hasBom,
        large: data.large,
        enc: data.enc,
        content: data.content,
        format,
        treeAvailable,
        parseError,
        mode: format.patch ? 'patch' : (plainTextView ? 'text' : format.preview ? (data.large ? 'code' : preferredMode) : (treeAvailable ? preferredMode : 'code')),
        text: null,
        rawText: treeAvailable ? data.content : null,
        dirty: false,
        untitled: false,
        binary: false,
        bases: {tree: null, code: null, text: null, table: null, preview: null},
        savedText: data.content,
        bookmarks: new Set(),
        diskMtime: data.mtime || '',
        // 标签页只读锁：只作用于本 doc；全局锁在 settings.readOnlyMode（判定统一走 core/readonly.js）
        // readOnlyFixed = 固定只读（审阅快照），不可解锁
        readOnlyLocked: !!data.readOnly,
        readOnlyFixed: !!data.readOnlyFixed,
        // 只读审阅文档：虚拟 .diff，走 patch 视图但不做预检、不允许应用
        patchReview: !!data.patchReview,
        reviewNotes: Array.isArray(data.reviewNotes) ? data.reviewNotes : [],
    };
}

function setFilename(name, path) {
    deps.els.filenameText.textContent = name || '';
    deps.els.filename.dataset.tip = path || name || '';
    const icon = deps.els.filenameIcon;
    icon.textContent = '';
    icon.className = 'title-icon';
    delete icon.dataset.fi;
    if (!name || name === '未打开文件') return;
    const spec = fileIconSpec(name);
    icon.innerHTML = spec.svg;
    icon.classList.add(spec.className);
    icon.dataset.fi = spec.id;
}

function updateDocChrome() {
    if (!deps.file) return;
    setFilename(deps.file.name, deps.file.path);
    renderBreadcrumb(deps.file.path);
    showBanner(deps.file, deps.file.parseError);
    deps.els.welcome.classList.add('hidden');
    deps.els.editor.classList.remove('hidden');
    deps.updateWindowTitle();
    updateStatus();
    deps.updateSearchState();
    renderTabs();
    if (deps.aiPanel) deps.aiPanel.refreshDockFill();
    // 有内容被打开 / 切到前台：宿主据此解开编辑区收起态。必须放在 refreshDockFill 之后——
    // 一旦有 activeFile，面板就不再 ai-dock-fill 占满，此时若编辑区还收着就是「面板不满、
    // 内容区不可见」的空白状态。收起从来不是固定锁，看内容就展开。
    if (deps.onDocVisible) deps.onDocVisible(deps.file);
    syncAllBrowserTabs();
    deps.refreshStructureSources();
}

function showWelcome() {
    syncAllBrowserTabs();
    if (!deps.docs.length) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
    }
    deps.cancelAutoSave();
    if (deps.editor) {
        deps.editor.destroy();
        deps.editor = null;
    }
    deps.file = null;
    deps.dirty = false;
    deps.currentMode = 'tree';
    deps.els.editor.classList.add('hidden');
    deps.els.welcome.classList.remove('hidden');
    setFilename('未打开文件', '');
    deps.els.filename.classList.remove('dirty');
    deps.els.breadcrumb.textContent = '';
    deps.els.stDirty.textContent = '';
    deps.els.stMessage.textContent = '';
    deps.els.stMode.textContent = '';
    deps.els.stSize.textContent = '';
    deps.els.stEol.textContent = '';
    deps.els.stEnc.textContent = '';
    deps.els.stEol.style.display = '';
    deps.els.stEnc.style.display = '';
    deps.els.banner.classList.add('hidden');
    deps.closeFootPopover();
    deps.closeDialogs();
    if (deps.els.stWriting) deps.els.stWriting.style.display = 'none';
    deps.applyWritingMode();
    deps.updateSearchState();
    renderTabs();
    deps.updateBackendDirty();
    deps.updateWindowTitle();
    deps.syncExplorerActive();
    if (deps.structurePanel) deps.structurePanel.setDoc(null);
    if (deps.aiPanel) deps.aiPanel.refreshDockFill();
    deps.refreshStructureSources();
}

let activateToken = 0;
let lastTabSwitchLog = {id: null, at: 0};

async function activateDoc(doc) {
    if (!doc) return;
    if (doc === deps.file) {
        const g0 = groupOfDoc(doc.id);
        if (g0) { g0.activeId = doc.id; focusedGroupId = g0.id; }
        return;
    }
    // 切换标签时先暂停上一个标签的视频/音频：面板只是被隐藏，不会自动停音频
    pauseVideoInDoc(deps.file);
    pauseAudioInDoc(deps.file);
    let g = groupOfDoc(doc.id);
    if (!g) {
        g = focusedGroup() || createGroup();
        if (!g.docIds.includes(doc.id)) g.docIds.push(doc.id);
    }
    g.activeId = doc.id;
    focusedGroupId = g.id;
    const token = ++activateToken;
    deps.cancelAutoSave();
    if (deps.settings.autoSave && deps.file && deps.dirty && deps.file.path && !deps.file.large) {
        await deps.save({auto: true});
        if (token !== activateToken) return;
    }
    snapshotActiveDoc();
    deps.file = doc;
    deps.dirty = !!doc.dirty;
    deps.currentMode = deps.normalizeLegacySqlMode(doc);
    deps.els.welcome.classList.add('hidden');
    deps.els.editor.classList.remove('hidden');
    if (!deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"]')) renderEditorLayout();
    for (const d of groupDocs(g)) {
        if (d.pane) d.pane.classList.remove('active');
    }
    if (!doc.editor) createDocEditor(doc);
    renderBookmarks(doc);
    const host = deps.els.editor.querySelector('.egroup[data-gid="' + g.id + '"] .ehost');
    if (host && doc.pane && doc.pane.parentElement !== host) host.appendChild(doc.pane);
    doc.pane.classList.add('active');
    deps.editor = doc.editor;
    updateDocChrome();
    deps.setDirty(doc.dirty);
    applyAceMode();
    if (doc.splitActive || doc.mode === 'split') enterSplitView(doc);
    humanizeCounts();
    if (deps.editor && deps.editor.aceEditor) {
        setTimeout(() => {
            if (deps.editor === doc.editor && deps.editor && deps.editor.aceEditor) {
                deps.editor.aceEditor.resize();
                if (deps.file === doc) applyPendingDocView(doc);
            }
        }, 0);
    }
    deps.syncExplorerActive();
    if (deps.structurePanel) deps.structurePanel.setDoc(doc);
    // 操作留痕：标签切换，同一标签 2s 内去重（避免连点噪音）。
    const now = Date.now();
    if (lastTabSwitchLog.id !== doc.id || now - lastTabSwitchLog.at > 2000) {
        lastTabSwitchLog = {id: doc.id, at: now};
        deps.activityLog.log('tab.switch', doc.name, {});
    }
    if (doc.staleOnDisk && !doc.dirty) {
        doc.staleOnDisk = false;
        deps.reloadActive({quiet: true});
    }
}

// ---------- 外部修改检测（写盘前冲突 + 读盘自动刷新） ----------
const externalDocTimers = new Map();

function handleExternalDocChanges(payload) {
    if (!payload || !deps.backend.GetFileStat) return;
    const root = String(payload.root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!root) return;
    const changed = new Set();
    if (payload.overflow) {
        for (const doc of deps.docs) if (doc.path && !doc.browser) changed.add(doc);
    } else {
        for (const rel of payload.paths || []) {
            const full = root + '/' + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
            for (const doc of deps.docs) {
                if (!doc.path || doc.browser) continue;
                if (doc.path.replace(/\\/g, '/').toLowerCase() === full) changed.add(doc);
            }
        }
    }
    for (const doc of changed) {
        const prev = externalDocTimers.get(doc.id);
        if (prev) clearTimeout(prev);
        externalDocTimers.set(doc.id, setTimeout(() => {
            externalDocTimers.delete(doc.id);
            checkDocExternalChange(doc).catch(() => {});
        }, 350));
    }
}

// 磁盘 mtime 与打开/上次保存时不同：干净文档自动重载，脏文档标记 staleOnDisk（保存时弹冲突）
async function checkDocExternalChange(doc) {
    if (!doc || !doc.path || doc.browser || !deps.backend.GetFileStat) return;
    if (!doc.diskMtime) return;
    let st = null;
    try {
        st = await deps.backend.GetFileStat(doc.path);
    } catch (e) {
        return;
    }
    if (!st || !st.exists || st.mtime === doc.diskMtime) return;
    if (doc.dirty) {
        doc.staleOnDisk = true;
        renderTabs();
        return;
    }
    if (doc === deps.file) {
        await deps.reloadActive({quiet: true});
        deps.flash('文件已在外部修改，已自动重新加载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        renderTabs();
    }
}

async function handleAIWorkspaceFileChanged(path) {
    // 文件树不做整树全量刷新：那会清空整棵树、丢掉展开态、逐级重载并抢滚动位置，
    // 连续编辑时看起来就是「一直闪」。改为轻量差量通知（纯内容修改零重绘）。
    const explorer = deps.explorer;
    if (explorer && typeof explorer.notifyFileChange === 'function') explorer.notifyFileChange(path);
    const doc = deps.findDocByPath(path);
    if (!doc) return;
    if (doc.dirty) {
        deps.flash('AI 已修改 ' + doc.name + '，但编辑器中有未保存修改，未自动重载', true);
        return;
    }
    if (doc === deps.file) {
        const ok = await deps.reloadActive({quiet: true});
        if (ok) deps.flash('AI 已修改并重载 ' + doc.name);
    } else {
        doc.staleOnDisk = true;
        deps.flash('AI 已修改 ' + doc.name + '，切换到该标签时自动重载');
    }
}

function requestCloseDoc(doc) {
    if (!doc) return;
    if (doc === deps.file) flushCsvCellEditor();
    if (doc.dirty) {
        deps.openConfirmDialog('“' + doc.name + '”有未保存的修改，关闭标签后将丢弃。', () => closeDocNow(doc), '丢弃并关闭', '关闭标签', 'danger');
    } else {
        closeDocNow(doc);
    }
}

function closeDocNow(doc, remember = true) {
    const idx = deps.docs.indexOf(doc);
    if (idx < 0) return;
    // 操作留痕：脏标签关闭 = 放弃修改（保存后的关闭到这里 dirty 已清零）。
    if (doc.dirty) deps.activityLog.log('tab.closeDirty', doc.name, {discarded: true});
    else deps.activityLog.log('tab.close', doc.name, {});
    disposeSqlDoc(doc);
    disposePatchView(doc);
    // 视频视图：先断源再摘节点，否则解码器与文件句柄要等 GC 才释放
    releaseVideo(doc);
    releaseAudio(doc);
    const wasActive = doc === deps.file;
    if (doc.path && remember) {
        deps.closedTabs.push({path: doc.path, name: doc.name});
        if (deps.closedTabs.length > 12) deps.closedTabs.shift();
    }
    if (doc.browser && deps.backend.BrowserClose) {
        deps.backend.BrowserClose(doc.id).catch(() => {});
    }
    // 后台终端标签页：只断开输出订阅，作业继续在后台运行
    if (doc.bgTerm && doc.bgTermUnsub) {
        doc.bgTermUnsub();
        doc.bgTermUnsub = null;
    }
    // 子代理详情标签页：卸载视图挂载点（子代理本身不受影响，仍在跑）
    if (doc.agentView && doc.agentViewUnmount) {
        doc.agentViewUnmount();
        doc.agentViewUnmount = null;
    }
    if (doc.sideChat && doc.sideChatUnmount) {
        doc.sideChatUnmount();
        doc.sideChatUnmount = null;
    }
    // 群聊标签页：断开运行时订阅（讨论本身继续在后台，重开标签页恢复）
    if (doc.groupChat && doc.groupChatUnmount) {
        doc.groupChatUnmount();
        doc.groupChatUnmount = null;
    }
    deps.docs.splice(idx, 1);
    if (doc.editor) {
        doc.editor.destroy();
        doc.editor = null;
    }
    if (doc.pane) {
        doc.pane.remove();
        doc.pane = null;
    }
    const g = groupOfDoc(doc.id);
    if (g) {
        g.docIds = g.docIds.filter((id) => id !== doc.id);
        if (g.activeId === doc.id) g.activeId = g.docIds[0] || null;
        removeGroupIfEmpty(g.id);
    }
    if (deps.docs.length === 0) {
        editorGroups = [];
        splitRoot = null;
        focusedGroupId = null;
        deps.editor = null;
        showWelcome();
        // 用户主动关掉最后一个标签：允许写入空快照
        deps.saveSessionNow({allowEmpty: true});
        return;
    }
    deps.scheduleSessionSave({allowEmpty: true});
    if (wasActive) {
        deps.editor = null;
        deps.file = null;
        deps.dirty = false;
        let next = null;
        if (g && g.docIds.length) {
            const at = Math.min(idx, g.docIds.length - 1);
            next = deps.docs.find((d) => d.id === g.docIds[at]) || deps.docs.find((d) => d.id === g.docIds[0]);
        }
        if (!next) {
            const fg = focusedGroup();
            next = fg ? deps.docs.find((d) => d.id === fg.activeId) : null;
        }
        if (!next) next = deps.docs[Math.min(idx, deps.docs.length - 1)] || deps.docs[0];
        renderTabs();
        activateDoc(next);
    } else {
        renderTabs();
        deps.updateBackendDirty();
    }
}

function showPathInFolder(path) {
    if (!path) return;
    deps.backend.ShowInFolder(path).catch((e) => deps.flash('打开文件位置失败：' + e, true));
}

// 用系统默认关联程序打开（标签页 / 文件树右键共用）：不经过命令行，空格与中文路径都安全。
function openWithDefaultApp(path) {
    if (!path) return;
    if (!deps.backend.OpenWithDefaultApp) {
        deps.flash('当前版本不支持用默认应用打开', true);
        return;
    }
    Promise.resolve(deps.backend.OpenWithDefaultApp(path))
        .catch((e) => deps.flash('用默认应用打开失败：' + e, true));
}

function closeDocsWithConfirm(list, message) {
    const targets = (list || []).filter((doc) => deps.docs.includes(doc));
    if (!targets.length) return;
    const run = () => {
        for (const doc of targets.slice()) closeDocNow(doc);
    };
    if (targets.some((doc) => doc.dirty)) {
        deps.openConfirmDialog(message || '有未保存的修改，关闭后将丢弃。', run, '丢弃并关闭', '关闭标签', 'danger');
    } else {
        run();
    }
}

function reopenClosedTab() {
    const entry = deps.closedTabs.pop();
    if (!entry) return;
    deps.activityLog.log('tab.reopen', entry.name, {});
    deps.openPath(entry.path);
}


    function setFocusedGroupId(v) { focusedGroupId = v; }
    function setSplitRoot(v) { splitRoot = v; }

    return {activateDoc, setFocusedGroupId, setSplitRoot, addDocToFocusedGroup, applyAceMode, applyCsvTableZoom, applyImageZoom, browserViewportLabel, closeDocNow, closeDocsWithConfirm, closeSqlView, createDoc, createDocEditor, createGroup, dismissBanner, doRedo, doUndo, enterAudioView, enterBinaryView, enterCsvTable, enterImageView, enterMarkdownPreview, enterSplitView, enterSqlView, enterSvgRender, enterTextView, enterVideoView, exitSplitView, expandAllWithGuard, flushCsvCellEditor, get focusedGroupId() { return focusedGroupId; }, groupDocs, groupOfDoc, handleAIWorkspaceFileChanged, handleExternalDocChanges, hideAudioView, hideBanner, hideSvgRender, hideVideoView, hookCodeFoldRanges, hookMultiCursor, humanizeCounts, initCodeFoldHover, jumpBookmark, leaveCsvTable, leaveMarkdownPreview, markDocDirty, mdSyncScrollFromAce, moveTabInGroup, openWithDefaultApp, patchViewContext, refreshPatchMarkers, rememberDocView, renderBookmarks, renderBreadcrumb, renderCsvTableView, renderEditorLayout, renderMarkdownPreview, renderTabs, reopenClosedTab, releaseAudio, releaseVideo, requestCloseDoc, revertDocToSaved, scheduleGitGutter, setBrowserViewport, setFilename, showBanner, showImageMenu, showMdPreviewMenu, showPathInFolder, showSvgMenu, get splitRoot() { return splitRoot; }, syncAllBrowserTabs, syncBrowserTab, syncTabReadOnly, textArea, toggleBookmark, toggleFocusedNode, updateBrowserTitle, updateDocChrome, updateStatus, zoomCsvTable, zoomImageBy, zoomSvgRenderBy};
}
