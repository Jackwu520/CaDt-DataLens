// editor-doc-extras.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// 文档周边杂项域：横幅、JSON 折叠预览、行书签、视图状态记忆、
// Git 行级标记、树视图右键菜单。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集，另接核心函数
// groupDocs / groupOfDoc / updateStatus / closeDocsWithConfirm / requestCloseDoc /
// showPathInFolder / reopenClosedTab / renderMarkdownPreview / syncTabViewTools 的转发箭头。
export function createEditorDocExtras(deps) {

function hideBanner() {
    deps.els.banner.classList.add('hidden');
}

function dismissBanner() {
    if (deps.file) deps.file.bannerDismissed = true;
    hideBanner();
}

function showBanner(data, parseError) {
    if (!data || data.bannerDismissed || !deps.settings.showBanners) {
        hideBanner();
        return;
    }
    if (data.binary) {
        if (data.image && data.mode === 'image') {
            hideBanner();
            return;
        }
        const shown = data.hexShown || data.size;
        const truncated = shown < data.size;
        deps.els.bannerText.textContent = '二进制文件 · ' + data.name + '（' + deps.fmtSize(data.size) + '）：下方从第 0 字节开始，以十六进制字节数据只读展示' +
            (truncated ? '，仅显示前 ' + deps.fmtSize(shown) : '') + '。';
        deps.els.banner.classList.remove('hidden');
    } else if (data.large) {
        deps.els.bannerText.textContent = '大文件（' + deps.fmtSize(data.size) + '）：已切换为只读代码模式，不可编辑保存。';
        deps.els.banner.classList.remove('hidden');
    } else if (parseError) {
        deps.els.bannerText.textContent = data.format.name + ' 解析失败：' + parseError.message + '。已用代码模式打开，可手动修复后保存。';
        deps.els.banner.classList.remove('hidden');
    } else {
        hideBanner();
    }
}

function foldDomCount(el) {
    const raw = el.textContent.trim();
    const exact = raw.match(/^[[{]\s*(\d+)\s*[\]}]$/);
    if (exact) return Number(exact[1]);
    const loose = raw.match(/[[{]\s*(\d+)/);
    if (loose) return Number(loose[1]);
    if (el.dataset.count != null) return Number(el.dataset.count);
    return null;
}

function foldValueAtPath(root, path) {
    let value = root;
    for (const segment of path) {
        if (value == null) return undefined;
        if (Array.isArray(value)) value = value[Number(segment)];
        else if (typeof value === 'object') value = value[segment];
        else return undefined;
    }
    return value;
}

function foldRowPaths(tbody) {
    const paths = new Map();
    const stack = [];
    for (const tr of tbody.children) {
        if (!tr || tr.tagName !== 'TR') continue;
        const table = tr.querySelector('table.jsoneditor-values');
        const keyEl = table ? table.querySelector('.jsoneditor-field, .jsoneditor-readonly') : null;
        if (!keyEl) continue;
        const key = keyEl.textContent.trim();
        if (!key) continue;
        const margin = table ? parseInt(table.style.marginLeft || '0', 10) : 0;
        const depth = Math.max(0, Math.round(margin / 24));
        if (depth === 0) {
            stack.length = 0;
            stack[0] = null;
        } else {
            stack.length = depth;
            stack[depth] = key;
        }
        paths.set(tr, stack.slice(1, depth + 1));
    }
    return paths;
}

function foldPrimitive(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return '[...]';
    if (typeof value === 'object') return '{...}';
    return String(value);
}

function clipFoldText(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max) + (text.startsWith('"') ? '"' : '');
}

function foldObjectSpec(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (!keys.length) return {kind: 'empty'};
    const keyText = clipFoldText(JSON.stringify(keys[0]), 36);
    return {
        kind: 'object',
        keyText,
        valueText: clipFoldText(foldPrimitive(value[keys[0]]), 30),
    };
}

function foldSpan(parent, text, className) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
}

function renderFoldPreview(el, sig, build) {
    if (el.dataset.foldSig === sig && el.querySelector('.jsoneditor-fold-preview')) return;
    el.textContent = '';
    const wrap = document.createElement('span');
    wrap.className = 'jsoneditor-fold-preview';
    build(wrap);
    el.appendChild(wrap);
    el.dataset.foldSig = sig;
}

function humanizeCounts() {
    if (!deps.editor || deps.currentMode !== 'tree') return;
    const root = deps.file && deps.file.pane ? deps.file.pane : deps.els.editor;
    const nodes = root.querySelectorAll('div.jsoneditor-value.jsoneditor-object, div.jsoneditor-value.jsoneditor-array');
    const pathMaps = new WeakMap();
    let rootValue;
    let rootLoaded = false;
    const rootData = () => {
        if (!rootLoaded) {
            try {
                rootValue = deps.editor.get();
            } catch (e) {
                rootValue = undefined;
            }
            rootLoaded = true;
        }
        return rootValue;
    };
    nodes.forEach((el) => {
        const isObject = el.classList.contains('jsoneditor-object');
        const collapsed = !!el.closest('tr.jsoneditor-collapsed');
        const row = el.closest('tr.jsoneditor-expandable');
        let path = null;
        if (row && row.parentElement) {
            if (!pathMaps.has(row.parentElement)) pathMaps.set(row.parentElement, foldRowPaths(row.parentElement));
            const map = pathMaps.get(row.parentElement);
            if (map.has(row)) path = map.get(row);
        }
        const value = path ? foldValueAtPath(rootData(), path) : undefined;
        let count = foldDomCount(el);
        if (isObject && value && typeof value === 'object' && !Array.isArray(value)) count = Object.keys(value).length;
        else if (!isObject && Array.isArray(value)) count = value.length;
        if (!Number.isFinite(count)) return;
        el.dataset.count = String(count);
        if (collapsed) {
            if (isObject) {
                const spec = foldObjectSpec(value);
                if (spec && spec.kind === 'empty') {
                    renderFoldPreview(el, 'o:empty', (wrap) => foldSpan(wrap, '{}', 'jsoneditor-fold-text'));
                } else if (spec) {
                    renderFoldPreview(el, 'o:' + JSON.stringify(spec), (wrap) => {
                        foldSpan(wrap, '{', 'jsoneditor-fold-text');
                        foldSpan(wrap, spec.keyText, 'jsoneditor-fold-text');
                        foldSpan(wrap, ': ', 'jsoneditor-fold-text');
                        foldSpan(wrap, spec.valueText, 'jsoneditor-fold-text');
                        foldSpan(wrap, '...', 'jsoneditor-fold-text');
                        foldSpan(wrap, '}', 'jsoneditor-fold-text');
                    });
                } else {
                    renderFoldPreview(el, 'of:' + count, (wrap) => {
                        foldSpan(wrap, '{' + count + ' 项}', 'jsoneditor-fold-text');
                    });
                }
            } else if (count === 0) {
                renderFoldPreview(el, 'a:0', (wrap) => foldSpan(wrap, '[]', 'jsoneditor-fold-text'));
            } else {
                renderFoldPreview(el, 'a:' + count, (wrap) => {
                    foldSpan(wrap, '[ ', 'jsoneditor-fold-text');
                    foldSpan(wrap, count + ' 个元素', 'jsoneditor-fold-text');
                    foldSpan(wrap, '... ]', 'jsoneditor-fold-text');
                });
            }
            el.removeAttribute('title');
        } else {
            const text = deps.settings.treeCounts ? count + ' 项' : '';
            if (el.textContent !== text || el.querySelector('.jsoneditor-fold-preview')) el.textContent = text;
            el.dataset.foldSig = 'e:' + count + ':' + (deps.settings.treeCounts ? '1' : '0');
        }
        el.classList.toggle('value-fold', collapsed);
        el.classList.toggle('value-count', !collapsed && !!deps.settings.treeCounts);
    });
}

let countQueued = false;
const countObserver = new MutationObserver(() => {
    if (countQueued) return;
    countQueued = true;
    queueMicrotask(() => {
        countQueued = false;
        humanizeCounts();
    });
});
countObserver.observe(deps.els.editor, {childList: true, subtree: true, characterData: true});

// ---- 行书签：F11 切换光标行书签，F2/Shift+F2 循环跳转，gutter 紫色标记 ----

function bookmarkRowsForDoc(doc) {
    if (!doc || !doc.editor || !doc.editor.aceEditor) return [];
    try {
        return [...(doc.bookmarks || [])].sort((a, b) => a - b);
    } catch (e) {
        return [];
    }
}

function renderBookmarks(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    if (doc.bmApplied) {
        for (const [row, cls] of doc.bmApplied) {
            try { ace.session.removeGutterDecoration(row, cls); } catch (e) {}
        }
    }
    const list = [];
    const rows = bookmarkRowsForDoc(doc);
    let lineCount = 0;
    try { lineCount = ace.session.getLength(); } catch (e) { lineCount = 0; }
    for (const row of rows) {
        if (!(row >= 0) || row >= lineCount) continue;
        try {
            ace.session.addGutterDecoration(row, 'bm-gutter');
            list.push([row, 'bm-gutter']);
        } catch (e) {}
    }
    doc.bmApplied = list;
}

function toggleBookmark() {
    const ace = deps.file && deps.file.editor && deps.file.editor.aceEditor;
    if (!ace) {
        deps.flash('书签仅在代码/文本视图可用', true);
        return;
    }
    if (!deps.file.bookmarks) deps.file.bookmarks = new Set();
    const row = ace.getCursorPosition().row;
    if (deps.file.bookmarks.has(row)) {
        deps.file.bookmarks.delete(row);
        deps.flash('已移除书签：' + (row + 1) + ' 行');
    } else {
        deps.file.bookmarks.add(row);
        deps.flash('已添加书签：' + (row + 1) + ' 行');
    }
    renderBookmarks(deps.file);
}

function jumpBookmark(delta) {
    const ace = deps.file && deps.file.editor && deps.file.editor.aceEditor;
    if (!ace) {
        deps.flash('书签仅在代码/文本视图可用', true);
        return;
    }
    const rows = bookmarkRowsForDoc(deps.file);
    if (!rows.length) {
        deps.flash('当前文件还没有书签（F11 添加）', true);
        return;
    }
    const cur = ace.getCursorPosition().row;
    let target = null;
    if (delta > 0) target = rows.find((r) => r > cur);
    else {
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i] < cur) { target = rows[i]; break; }
        }
        if (target == null) target = rows[rows.length - 1];
    }
    if (target == null) target = rows[0];
    deps.jumpToPosition(target + 1, 1);
}

// ---- 视图状态：光标/滚动/折叠/书签随会话保存 ----

function captureDocView(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return null;
    const view = {};
    try {
        const pos = ace.getCursorPosition();
        view.cursor = [pos.row, pos.column];
    } catch (e) {}
    try { view.scrollTop = Math.max(0, Math.round(ace.session.getScrollTop() || 0)); } catch (e) {}
    try {
        const folds = typeof ace.session.getAllFolds === 'function' ? ace.session.getAllFolds() : [];
        const ranges = [];
        for (const fold of folds || []) {
            const start = fold && fold.start ? fold.start.row : -1;
            const end = fold && fold.end ? fold.end.row : -1;
            if (start >= 0 && end > start) ranges.push([start, end]);
            if (ranges.length >= 500) break;
        }
        if (ranges.length) view.folds = ranges;
    } catch (e) {}
    const marks = bookmarkRowsForDoc(doc);
    if (marks.length) view.bookmarks = marks.slice(0, 500);
    if (!view.cursor && !view.scrollTop && !view.folds && !view.bookmarks) return null;
    return view;
}

function applyDocView(doc, view) {
    if (!doc || !view) return false;
    if (Array.isArray(view.bookmarks)) {
        doc.bookmarks = new Set(view.bookmarks.filter((n) => Number.isInteger(n) && n >= 0));
    }
    const ace = doc.editor && doc.editor.aceEditor;
    if (!ace) return false;
    renderBookmarks(doc);
    try {
        const Range = ace.Range || (ace.require && ace.require('ace/range').Range) ||
            (window.ace && window.ace.require ? window.ace.require('ace/range').Range : null);
        if (Range && Array.isArray(view.folds)) {
            const lineCount = ace.session.getLength();
            for (const pair of view.folds) {
                const start = Number(pair && pair[0]);
                const end = Number(pair && pair[1]);
                if (!(start >= 0) || !(end > start) || start >= lineCount) continue;
                // 占位符 "..."：恢复的折叠与手动折叠观感一致（此前 '' 配合旧的预览改写，现在会 invisible）
                try { ace.session.addFold('...', new Range(start, 0, Math.min(end, lineCount - 1), Infinity)); } catch (e) {}
            }
        }
    } catch (e) {}
    try {
        if (Array.isArray(view.cursor)) {
            const lineCount = Math.max(1, ace.session.getLength());
            const row = Math.max(0, Math.min(lineCount - 1, Number(view.cursor[0]) || 0));
            const col = Math.max(0, Number(view.cursor[1]) || 0);
            ace.clearSelection();
            ace.moveCursorTo(row, col);
        }
    } catch (e) {}
    try {
        if (Number.isFinite(view.scrollTop)) ace.session.setScrollTop(view.scrollTop);
    } catch (e) {}
    return true;
}

function applyPendingDocView(doc) {
    if (!doc || !doc.path) return;
    const key = deps.sessionPathKey(doc.path);
    const view = deps.pendingDocViews.get(key);
    if (!view) return;
    deps.pendingDocViews.delete(key);
    applyDocView(doc, view);
}

function rememberDocView(doc) {
    if (!doc || !doc.path) return;
    const key = deps.sessionPathKey(doc.path);
    const view = captureDocView(doc) || deps.knownDocViews.get(key);
    if (view) deps.knownDocViews.set(key, view);
}

// ---- Git 行级标记：代码视图行号左侧色条（JetBrains 风格） ----
// 绿=新增、蓝=修改、灰点=此处上方有删除的行。数据来自 git diff HEAD（未保存内容不参与）。

const GIT_GUTTER_ADD = 'git-gutter-add';
const GIT_GUTTER_MOD = 'git-gutter-mod';
const GIT_GUTTER_DEL = 'git-gutter-del';

function renderGitGutter(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace) return;
    if (doc.gitGutterApplied) {
        for (const [row, cls] of doc.gitGutterApplied) {
            try { ace.session.removeGutterDecoration(row, cls); } catch (e) {}
        }
    }
    const list = [];
    const marks = doc.gitGutterData;
    if (marks) {
        let lineCount = 0;
        try { lineCount = ace.session.getLength(); } catch (e) { lineCount = 0; }
        const put = (row, cls) => {
            if (!(row >= 0) || row >= lineCount) return;
            try {
                ace.session.addGutterDecoration(row, cls);
                list.push([row, cls]);
            } catch (e) {}
        };
        for (const row of marks.added) put(row, GIT_GUTTER_ADD);
        for (const row of marks.modified) put(row, GIT_GUTTER_MOD);
        for (const row of marks.delBefore) put(row, GIT_GUTTER_DEL);
    }
    doc.gitGutterApplied = list;
}

function clearGitGutterData(doc) {
    doc.gitGutterData = null;
    renderGitGutter(doc);
}

// scheduleGitGutter 按需取 git diff 并刷新标记；900ms 防抖，状态机见 refreshGitStatus。
function scheduleGitGutter(doc, delay) {
    if (!doc || !doc.path || doc.large || !deps.gitStateCache.available || !deps.gitStateCache.dir) return;
    const key = doc.path.replace(/\\/g, '/');
    const st = deps.gitStateCache.map.get(key);
    if (!st || st === 'untracked') {
        // 无变更或未跟踪：清掉旧标记即可，不用对比
        if (doc.gitGutterData) clearGitGutterData(doc);
        return;
    }
    clearTimeout(doc.gitGutterTimer);
    doc.gitGutterTimer = setTimeout(async () => {
        doc.gitGutterTimer = 0;
        if (!deps.docs.includes(doc) || !doc.path || doc.large || !doc.editor) return;
        if (!deps.gitStateCache.available || !deps.gitStateCache.dir) return;
        if (!deps.backend.GitLineMarksFor) return;
        let text = '';
        try { text = doc.editor.getText(); } catch (e) { return; }
        try {
            // 直接对比 HEAD 与编辑器当前内容：未保存的输入也实时参与
            doc.gitGutterData = await deps.backend.GitLineMarksFor(deps.gitStateCache.dir, doc.path, text);
        } catch (e) {
            doc.gitGutterData = null;
        }
        renderGitGutter(doc);
    }, delay || 900);
}

// ---------- 树视图右键菜单：展开 / 折叠当前节点、全部展开 / 收起、复制树 ----------

// 全部展开会一次性渲染整棵树（jsoneditor 无虚拟滚动）：大文件几万节点时会卡几秒，
// 展开后界面也长时间卡顿。超过阈值先确认，并提示可右键逐层展开。
const TREE_EXPAND_WARN_NODES = 12000;

function estimateJsonNodes(value, budget) {
    let count = 0;
    const stack = [value];
    while (stack.length) {
        const cur = stack.pop();
        count++;
        if (count > budget) return count;
        if (cur && typeof cur === 'object') {
            if (Array.isArray(cur)) {
                for (const item of cur) stack.push(item);
            } else {
                for (const key in cur) {
                    if (Object.prototype.hasOwnProperty.call(cur, key)) stack.push(cur[key]);
                }
            }
        }
    }
    return count;
}

function expandAllWithGuard(doc) {
    const ed = doc && doc.editor;
    if (!ed) return;
    let nodes = 0;
    try { nodes = estimateJsonNodes(ed.get(), 200000); } catch (e) { nodes = 0; }
    const run = () => { try { ed.expandAll(); } catch (err) {} };
    if (!nodes || nodes <= TREE_EXPAND_WARN_NODES) {
        run();
        return;
    }
    deps.openConfirmDialog(
        '「' + (doc.name || '当前文件') + '」约含 ' + nodes.toLocaleString() + ' 个节点，全部展开需要一次性渲染整棵树，会卡顿数秒，展开后浏览 / 编辑也会明显变慢。可改用树视图右键「展开该节点」逐层展开。仍要全部展开吗？',
        run, '全部展开', '全部展开');
}

// jsoneditor 每个节点渲染成两层：外层「状态行」（直系 td 含 contextmenu 按钮，
// 子节点嵌在内嵌 values 表里）+ 内层「字段行」（直系第一个 td 就是本节点的
// 展开/收起按钮）。右键可能落在这两层任意元素上，这里统一解析出本节点按钮。

function jsonTreeNodeToggle(target) {
    const tr = target && target.closest ? target.closest('tr') : null;
    if (!tr || !tr.closest('.jsoneditor-tree')) return null;
    const fieldRow = tr.querySelector(':scope > td > table.jsoneditor-values > tbody > tr')
        || tr;
    const btn = fieldRow.querySelector(':scope > td > button.jsoneditor-expanded, :scope > td > button.jsoneditor-collapsed');
    return btn
        ? {btn, expanded: btn.classList.contains('jsoneditor-expanded')}
        : null;
}

function openTreeContextMenu(e, doc) {
    if (!deps.ctxMenu || !doc || !doc.editor) return;
    const node = jsonTreeNodeToggle(e.target);
    const ed = doc.editor;
    deps.ctxMenu.open([
        {label: '展开该节点', icon: 'chevron-down', disabled: !node || node.expanded, action: () => node.btn.click()},
        {label: '折叠该节点', icon: 'chevron-up', disabled: !node || !node.expanded, action: () => node.btn.click()},
        {sep: true},
        {label: '全部展开', shortcut: 'Ctrl+Shift+=', action: () => expandAllWithGuard(doc)},
        {label: '全部收起', shortcut: 'Ctrl+Shift+-', action: () => { try { ed.collapseAll(); } catch (err) {} }},
        {sep: true},
        {label: '复制树', action: () => { try { deps.copyText(ed.getText(), '树内容'); } catch (err) {} }},
    ], e.clientX, e.clientY);
}

function setupTreeContextMenu(doc) {
    if (!doc || !doc.editor || !doc.editor.container || doc.editor.container.dataset.treeCtxBound) return;
    const container = doc.editor.container;
    container.dataset.treeCtxBound = '1';
    container.addEventListener('contextmenu', (e) => {
        if (!e.target || !e.target.closest || !e.target.closest('.jsoneditor-tree')) return;
        e.preventDefault();
        e.stopPropagation();
        openTreeContextMenu(e, doc);
    });
}

    return {
        hideBanner, dismissBanner, showBanner,
        foldDomCount, foldValueAtPath, foldRowPaths, foldPrimitive, clipFoldText, foldObjectSpec, foldSpan, renderFoldPreview, humanizeCounts,
        bookmarkRowsForDoc, renderBookmarks, toggleBookmark, jumpBookmark,
        captureDocView, applyDocView, applyPendingDocView, rememberDocView,
        renderGitGutter, clearGitGutterData, scheduleGitGutter,
        estimateJsonNodes, expandAllWithGuard, jsonTreeNodeToggle, openTreeContextMenu, setupTreeContextMenu,
    };
}
