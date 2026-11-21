// structure-panel.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// 结构面板：语言结构解析（Worker + 缓存）、面板初始化与大纲渲染、
// 来源切换、会话结构导出菜单。
//
// deps 由 main.js 显式传入（getter 延迟求值）；原裸标识符引用已重写为 deps.X，
// 对象简写位展开为 key: deps.X。
import {iconSvg} from '../core/icons.js';

export function createStructurePanelController(deps) {

function structureTextForDoc(doc) {
    if (!doc || doc.binary) return '';
    if (doc === deps.file && doc.editor) {
        if (deps.currentMode === 'render') {
            return doc._svgSrcText || doc.rawText || doc.text || '';
        }
        if (deps.currentMode === 'tree' && doc.format && !doc.format.rawOnly) {
            return doc.rawText != null ? doc.rawText : (doc.text || '');
        }
        if (deps.currentMode === 'table' && doc.pane) {
            const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
            if (textarea) return textarea.value;
        }
        return doc.editor.getText() || '';
    }
    return doc.rawText != null ? doc.rawText : (doc.text || doc.content || '');
}

async function jumpToStructureNode(node) {
    if (!deps.file || !node || deps.file.binary) return;
    const line = Math.max(1, Number(node.line) || 1);
    const column = Math.max(1, Number(node.column) || 1);
    await deps.selectLineInDoc(deps.file, line, column);
    if (deps.structurePanel) deps.structurePanel.setCursor(line);
}

function getStructureWorker() {
    if (deps.structureWorkerBroken) return null;
    if (deps.structureWorker) return deps.structureWorker;
    try {
        deps.structureWorker = new Worker(new URL('./structure-worker.js', import.meta.url), {type: 'module'});
        deps.structureWorker.onmessage = (event) => {
            const data = event.data || {};
            const pending = deps.structureWorkerPending.get(data.id);
            if (!pending) return;
            deps.structureWorkerPending.delete(data.id);
            if (data.ok) {
                pending.resolve(data.result);
            } else {
                pending.reject(new Error(data.error || '结构解析失败'));
            }
        };
        deps.structureWorker.onerror = () => {
            deps.structureWorkerBroken = true;
            deps.structureWorker = null;
            for (const pending of deps.structureWorkerPending.values()) {
                pending.reject(new Error('结构解析 Worker 不可用'));
            }
            deps.structureWorkerPending.clear();
        };
    } catch (e) {
        deps.structureWorkerBroken = true;
        deps.structureWorker = null;
    }
    return deps.structureWorker;
}

function rememberStructureResult(key, parsed) {
    deps.structureCache.set(key, parsed);
    while (deps.structureCache.size > deps.STRUCTURE_CACHE_LIMIT) {
        deps.structureCache.delete(deps.structureCache.keys().next().value);
    }
    return parsed;
}

// 同一文档同一修订只解析一次；解析在 Worker 里做，切标签命中缓存
function parseStructureCached(name, text, doc) {
    const key = (doc && doc.id ? doc.id : '') + ':' + ((doc && doc.structureRev) || 0) + ':' + text.length;
    const cached = deps.structureCache.get(key);
    if (cached) return Promise.resolve(cached);
    const worker = getStructureWorker();
    if (!worker) return Promise.resolve(rememberStructureResult(key, deps.parseStructure(name, text)));
    return new Promise((resolve) => {
        const id = ++deps.structureWorkerSeq;
        deps.structureWorkerPending.set(id, {
            resolve: (parsed) => resolve(rememberStructureResult(key, parsed)),
            reject: () => {
                const workerNow = deps.structureWorker;
                deps.structureWorkerBroken = true;
                deps.structureWorker = null;
                try {
                    if (workerNow) workerNow.terminate();
                } catch (e) {}
                resolve(rememberStructureResult(key, deps.parseStructure(name, text)));
            },
        });
        worker.postMessage({id, name, text});
    });
}

function scheduleStructureRefresh(doc) {
    if (!deps.structurePanel || !deps.settings.showSidebar || deps.currentSidebarView() !== 'structure') return;
    if (doc && deps.file && doc !== deps.file) return;
    clearTimeout(deps.structureRefreshTimer);
    deps.structureRefreshTimer = setTimeout(() => {
        deps.structureRefreshTimer = 0;
        if (!deps.structurePanel || !deps.settings.showSidebar || deps.currentSidebarView() !== 'structure') return;
        deps.structurePanel.refresh();
    }, 500);
}

function initStructurePanel() {
    if (!deps.els.structureBody) return;
    deps.structurePanel = deps.createStructurePanel({
        body: deps.els.structureBody,
        refreshBtn: deps.els.structureRefresh,
        collapseBtn: deps.els.structureCollapse,
        getText: (doc) => structureTextForDoc(doc),
        getCursorLine: () => {
            try {
                return deps.file && deps.file.editor && deps.file.editor.aceEditor
                    ? deps.file.editor.aceEditor.getCursorPosition().row + 1 : 0;
            } catch (e) {
                return 0;
            }
        },
        onJump: (node) => jumpToStructureNode(node),
        parseAsync: (name, text, doc) => parseStructureCached(name, text, doc),
        onSessionJump: (index) => {
            if (deps.aiPanel && typeof deps.aiPanel.bridgeJumpToMessage === 'function') deps.aiPanel.bridgeJumpToMessage(index);
        },
    });
    if (deps.els.structureExport) {
        deps.els.structureExport.innerHTML = iconSvg('structured-dir');
        deps.els.structureExport.addEventListener('click', () => showStructureExportMenu());
    }
    if (deps.els.structureSource) {
        deps.els.structureSource.innerHTML = deps.iconSvg('file', 14);
        deps.els.structureSource.addEventListener('click', toggleStructureSource);
    }
    // 会话结构模式下「刷新」要重新向 AI 面板取一次快照（面板内部的 refresh 只重渲染已有数据）
    if (deps.els.structureRefresh) {
        deps.els.structureRefresh.addEventListener('click', () => {
            if (deps.structurePanel && deps.structurePanel.getSource() === 'session') refreshStructureSources();
        });
    }
    deps.structurePanel.setSource(deps.settings.structureSource);
    deps.structurePanel.setDoc(deps.file);
    deps.applySidebarUI();
    refreshStructureSources();
}

// ---- 结构面板的两个来源：文件结构 / 会话结构（用户消息定位条） ----
// 内容区只有文件            → 只显示文件结构
// 内容区只有 AI 助手        → 只显示当前会话的结构（全屏，或停靠且没打开文件时 AI 占满内容区）
// 两者都在                  → 默认文件结构，面板头部图标可在两者间切换（偏好存 settings）
function structureSources() {
    const aiOpen = !!(deps.aiPanel && deps.aiPanel.isOpen && deps.aiPanel.isOpen());
    const aiMode = deps.aiPanel && deps.aiPanel.getMode ? deps.aiPanel.getMode() : '';
    // 悬浮窗在另一个窗口里，本窗口内容区没有 AI，也就没有可定位的会话结构
    const aiVisible = aiOpen && aiMode !== 'float';
    const hasFile = !!deps.file;
    const aiOnly = aiVisible && (aiMode === 'fullscreen' || !hasFile);
    return {file: hasFile && !aiOnly, session: aiVisible};
}

function structureOutlineSnapshot() {
    try {
        if (deps.aiPanel && typeof deps.aiPanel.bridgeSessionOutline === 'function') return deps.aiPanel.bridgeSessionOutline();
    } catch (e) {}
    return null;
}

function syncStructureChrome(effective, sources) {
    const sessionMode = effective === 'session';
    if (deps.els.structureTitle) deps.els.structureTitle.textContent = sessionMode ? '会话结构' : '结构';
    if (deps.els.structureSource) {
        const both = sources.file && sources.session;
        deps.els.structureSource.classList.toggle('hidden', !both);
        deps.els.structureSource.classList.toggle('active', sessionMode);
        deps.els.structureSource.innerHTML = deps.iconSvg(sessionMode ? 'feedback' : 'file', 14);
        deps.els.structureSource.setAttribute('aria-pressed', String(sessionMode));
        deps.els.structureSource.dataset.tip = sessionMode
            ? '当前：会话结构（点击切到文件结构）'
            : '当前：文件结构（点击切到会话结构）';
    }
    // 复制/导出与「全部折叠」只对文件结构有意义
    if (deps.els.structureExport) deps.els.structureExport.classList.toggle('hidden', sessionMode);
    if (deps.els.structureCollapse) deps.els.structureCollapse.classList.toggle('hidden', sessionMode);
    if (deps.els.structureRefresh) deps.els.structureRefresh.dataset.tip = sessionMode ? '刷新会话结构' : '刷新结构';
}

function refreshStructureSources() {
    if (!deps.structurePanel) return '';
    const src = structureSources();
    const effective = deps.structurePanel.setSources(src);
    deps.structurePanel.setSessionOutline(src.session ? structureOutlineSnapshot() : null);
    syncStructureChrome(effective, src);
    return effective;
}

function toggleStructureSource() {
    if (!deps.structurePanel) return;
    const next = deps.structurePanel.getSource() === 'session' ? 'file' : 'session';
    deps.settings.structureSource = next;
    try { localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings)); } catch (e) {}
    const effective = deps.structurePanel.setSource(next);
    syncStructureChrome(effective, structureSources());
}

// 结构面板的结构化复制 / 导出：文本格式与「结构化目录」一致
function structureTreeText(format) {
    try {
        return deps.structurePanel && typeof deps.structurePanel.structureText === 'function'
            ? String(deps.structurePanel.structureText(format, deps.settings.structureExportLineNums) || '') : '';
    } catch (e) {
        return '';
    }
}

function showStructureExportMenu() {
    if (!deps.ctxMenu) return;
    const has = !!structureTreeText();
    const copyItems = [
        {label: '树形结构', action: () => deps.copyStructureTree('tree')},
        {label: '缩进列表', action: () => deps.copyStructureTree('indent')},
        {label: 'Markdown 列表', action: () => deps.copyStructureTree('markdown')},
        {label: 'Mermaid 大纲', action: () => deps.copyStructureTree('mermaid')},
    ];
    const exportItems = [
        {label: '树形结构', action: () => deps.exportStructureTree('tree')},
        {label: '缩进列表', action: () => deps.exportStructureTree('indent')},
        {label: 'Markdown 列表', action: () => deps.exportStructureTree('markdown')},
        {label: 'Mermaid 大纲', action: () => deps.exportStructureTree('mermaid')},
    ];
    const r = deps.els.structureExport.getBoundingClientRect();
    deps.ctxMenu.open([
        {label: '复制为', icon: 'copy', disabled: !has, submenu: copyItems},
        {label: '导出为…', icon: 'save', disabled: !has, submenu: exportItems},
        {sep: true},
        {label: '附带行号', checked: deps.settings.structureExportLineNums, action: toggleStructureExportLineNums},
    ], r.left, r.bottom + 4);
}

function toggleStructureExportLineNums() {
    deps.settings.structureExportLineNums = !deps.settings.structureExportLineNums;
    try { localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings)); } catch (e) {}
    showStructureExportMenu();
}

    return {
        structureTextForDoc,
        jumpToStructureNode,
        getStructureWorker,
        rememberStructureResult,
        parseStructureCached,
        scheduleStructureRefresh,
        initStructurePanel,
        structureSources,
        structureOutlineSnapshot,
        syncStructureChrome,
        refreshStructureSources,
        toggleStructureSource,
        structureTreeText,
        showStructureExportMenu,
        toggleStructureExportLineNums,
    };
}
