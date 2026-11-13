// global-search.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。
import {fileIconSpec} from './fileicons.js';

export function createGlobalSearch(deps) {

const globalSearch = {
    open: false,
    seq: 0,
    timer: 0,
    hits: [],
    index: -1,
    root: '',
    previousFocus: null,
    // 「搜索 AI 会话」扩展：默认不勾选；勾选后按 详细 / 简要 两档检索未归档会话
    aiEnabled: false,
    aiMode: 'brief',
    aiControlsBound: false,
};

// AI 会话搜索的控件行与样式：自带注入（不动 index.html / style.css），
// 复用 gs- 系布局变量，勾选后才可用模式切换（简要 / 详细）。
function ensureAISearchControls() {
    if (globalSearch.aiControlsBound) return;
    const panel = deps.els.gsInput ? deps.els.gsInput.closest('#gs-panel') : null;
    const searchRow = deps.els.gsInput ? deps.els.gsInput.parentElement : null;
    if (!panel || !searchRow) return;
    if (!document.getElementById('gs-ai-style')) {
        const style = document.createElement('style');
        style.id = 'gs-ai-style';
        style.textContent = [
            '.gs-ai-row { display: flex; align-items: center; gap: 8px; padding: 4px 10px 0; font-size: 11px; opacity: .85; }',
            '.gs-ai-row label { display: flex; align-items: center; gap: 4px; cursor: pointer; }',
            '.gs-ai-mode { margin-left: auto; font-size: 11px; padding: 1px 4px; border: 1px solid var(--border, rgba(128,128,128,.4)); background: transparent; color: inherit; border-radius: 4px; }',
            '.gs-ai-mode:disabled { opacity: .45; }',
            '.gs-group { padding: 6px 10px 2px; font-size: 10px; letter-spacing: .04em; opacity: .55; border-top: 1px solid var(--border, rgba(128,128,128,.25)); margin-top: 4px; }',
            '.gs-badge { flex: none; font-size: 9px; font-weight: 600; padding: 1px 4px; border-radius: 4px; background: var(--accent, #4c8dff); color: #fff; margin-right: 2px; }',
            '.gs-role { flex: none; font-size: 10px; opacity: .6; margin-left: 6px; }',
        ].join('\n');
        document.head.appendChild(style);
    }
    const row = document.createElement('div');
    row.className = 'gs-ai-row';
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'gs-ai-enabled';
    box.checked = globalSearch.aiEnabled;
    box.addEventListener('change', () => {
        globalSearch.aiEnabled = box.checked;
        if (modeSel) modeSel.disabled = !box.checked;
        scheduleGlobalSearch();
    });
    label.append(box, document.createTextNode('搜索 AI 会话'));
    const modeSel = document.createElement('select');
    modeSel.className = 'gs-ai-mode';
    modeSel.id = 'gs-ai-mode';
    modeSel.disabled = !globalSearch.aiEnabled;
    for (const [value, text] of [['brief', '简要（用户消息 + 每轮总结）'], ['full', '详细（全部消息）']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (value === globalSearch.aiMode) option.selected = true;
        modeSel.appendChild(option);
    }
    modeSel.addEventListener('change', () => {
        globalSearch.aiMode = modeSel.value === 'full' ? 'full' : 'brief';
        scheduleGlobalSearch();
    });
    row.append(label, modeSel);
    searchRow.parentElement.insertBefore(row, searchRow.nextSibling);
    globalSearch.aiControlsBound = true;
}

function globalSearchRoot() {
    if (deps.workspaceFolder) return deps.workspaceFolder;
    if (deps.file && deps.file.path) {
        const s = String(deps.file.path).replace(/\\/g, '/');
        const i = s.lastIndexOf('/');
        if (i > 0) return s.slice(0, i);
    }
    return '';
}

function openGlobalSearch() {
    if (globalSearch.open) {
        deps.els.gsInput.focus();
        deps.els.gsInput.select();
        return;
    }
    const root = globalSearchRoot();
    globalSearch.open = true;
    globalSearch.root = root;
    globalSearch.previousFocus = document.activeElement;
    globalSearch.hits = [];
    globalSearch.index = -1;
    deps.els.gsRoot.textContent = root;
    deps.els.gsInput.value = '';
    deps.els.gsCount.textContent = '';
    // 没打开工作区时仍可进面板：勾选「搜索 AI 会话」后可检索会话历史
    showGlobalSearchEmpty(root
        ? '输入内容，在打开的工作区中搜索文本'
        : '未打开工作区——可勾选「搜索 AI 会话」在 AI 会话历史里搜索');
    ensureAISearchControls();
    deps.els.gsMask.classList.remove('hidden');
    deps.els.gsInput.focus();
}

function closeGlobalSearch() {
    if (!globalSearch.open) return;
    globalSearch.open = false;
    clearTimeout(globalSearch.timer);
    globalSearch.seq++;
    deps.els.gsMask.classList.add('hidden');
    const prev = globalSearch.previousFocus;
    globalSearch.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
    } else {
        deps.focusFindEditor();
    }
}

function showGlobalSearchEmpty(text) {
    deps.els.gsList.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'gs-empty';
    empty.textContent = text;
    deps.els.gsList.appendChild(empty);
}

function scheduleGlobalSearch() {
    clearTimeout(globalSearch.timer);
    globalSearch.timer = setTimeout(runGlobalSearch, 180);
}

async function runGlobalSearch() {
    if (!globalSearch.open) return;
    const query = deps.els.gsInput.value;
    const seq = ++globalSearch.seq;
    globalSearch.hits = [];
    globalSearch.index = -1;
    if (!query.trim()) {
        deps.els.gsCount.textContent = '';
        showGlobalSearchEmpty(globalSearch.root
            ? '输入内容，在打开的工作区中搜索文本'
            : '未打开工作区——可勾选「搜索 AI 会话」在 AI 会话历史里搜索');
        return;
    }
    deps.els.gsCount.textContent = '搜索中…';
    const root = globalSearch.root;
    const aiEnabled = globalSearch.aiEnabled && !!deps.backend.AISessionSearchScoped;
    // 工作区与会话检索并行发起；无工作区时只搜会话
    const workspaceTask = root
        ? deps.backend.SearchWorkspace(root, query, false, 400).catch((e) => ({error: e}))
        : Promise.resolve({hits: []});
    const sessionTask = aiEnabled
        ? deps.backend.AISessionSearchScoped(query, 30, globalSearch.aiMode !== 'full').catch((e) => ({error: e}))
        : Promise.resolve(null);
    const [res, sessionRes] = await Promise.all([workspaceTask, sessionTask]);
    if (!globalSearch.open || seq !== globalSearch.seq) return;
    if (res && res.error) {
        deps.els.gsCount.textContent = '搜索失败';
        showGlobalSearchEmpty('搜索失败：' + res.error);
        return;
    }
    renderGlobalSearchResults(res || {hits: []}, sessionRes);
}

function globalSearchRow(hit, index) {
    const row = document.createElement('div');
    row.className = 'gs-row';
    row.dataset.i = String(index);
    row.setAttribute('role', 'option');
    const main = document.createElement('div');
    main.className = 'gs-main';
    if (hit.aiSession) {
        // AI 会话命中：徽标 + 会话标题 + 角色 + 摘要（snippet 的 \x01/\x02 转高亮）
        const icon = document.createElement('span');
        icon.className = 'gs-file-icon';
        icon.innerHTML = '<span class="gs-badge">AI</span>';
        const line1 = document.createElement('div');
        line1.className = 'gs-line1';
        const name = document.createElement('span');
        name.className = 'gs-name';
        name.textContent = hit.title || '（无标题会话）';
        name.title = hit.title || '';
        const dir = document.createElement('span');
        dir.className = 'gs-dir';
        dir.textContent = hit.kind === 'title' ? '会话标题' : '';
        const role = document.createElement('span');
        role.className = 'gs-role';
        role.textContent = hit.kind === 'title' ? '' : (hit.role === 'user' ? '用户消息' : (hit.role === 'assistant' ? 'AI 回复' : (hit.role || '')));
        line1.append(name, dir, role);
        const line2 = document.createElement('div');
        line2.className = 'gs-line2';
        const preview = document.createElement('span');
        preview.className = 'gs-preview';
        if (hit.kind === 'title') {
            preview.textContent = '打开该会话';
        } else {
            appendSnippetWithMarks(preview, hit.snippet || '');
        }
        line2.append(preview);
        main.append(line1, line2);
        row.append(icon, main);
        row.addEventListener('click', () => {
            globalSearch.index = index;
            updateGlobalSearchSelection();
            openGlobalSearchHit(hit);
        });
        return row;
    }
    const icon = document.createElement('span');
    icon.className = 'gs-file-icon';
    try {
        const spec = fileIconSpec(hit.name);
        icon.innerHTML = spec.svg;
        icon.classList.add(spec.className);
    } catch (e) {}
    const line1 = document.createElement('div');
    line1.className = 'gs-line1';
    const name = document.createElement('span');
    name.className = 'gs-name';
    name.textContent = hit.name || '';
    const dir = document.createElement('span');
    dir.className = 'gs-dir';
    dir.textContent = hit.dir || '';
    line1.append(name, dir);
    const line2 = document.createElement('div');
    line2.className = 'gs-line2';
    const ln = document.createElement('span');
    ln.className = 'gs-ln';
    ln.textContent = String(hit.line || '');
    const preview = document.createElement('span');
    preview.className = 'gs-preview';
    const text = String(hit.preview == null ? '' : hit.preview);
    const start = Math.max(0, Math.min(Number(hit.matchStart) || 0, text.length));
    const end = Math.max(start, Math.min(Number(hit.matchEnd) || 0, text.length));
    if (start > 0) preview.appendChild(document.createTextNode(text.slice(0, start)));
    if (end > start) {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(start, end);
        preview.appendChild(mark);
    }
    if (end < text.length) preview.appendChild(document.createTextNode(text.slice(end)));
    line2.append(ln, preview);
    main.append(line1, line2);
    row.append(icon, main);
    row.addEventListener('click', () => {
        globalSearch.index = index;
        updateGlobalSearchSelection();
        openGlobalSearchHit(hit);
    });
    return row;
}

// makeSearchSnippet 用 \x01 / \x02 包住命中片段，这里转成 <mark>。
function appendSnippetWithMarks(preview, snippet) {
    const parts = String(snippet).split(/[\x01\x02]/);
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        if (i % 2 === 1) {
            const mark = document.createElement('mark');
            mark.textContent = parts[i];
            preview.appendChild(mark);
        } else {
            preview.appendChild(document.createTextNode(parts[i]));
        }
    }
}

function renderGlobalSearchResults(res, sessionRes) {
    const hits = Array.isArray(res.hits) ? res.hits.slice() : [];
    const sessionHits = sessionRes && Array.isArray(sessionRes.hits) ? sessionRes.hits : [];
    // 会话命中挂在每个 hit 上供打开逻辑分流
    for (const hit of sessionHits) {
        hits.push(Object.assign({aiSession: true}, hit));
    }
    globalSearch.hits = hits;
    globalSearch.index = hits.length ? 0 : -1;
    deps.els.gsList.textContent = '';
    if (!hits.length) {
        deps.els.gsCount.textContent = '0 个结果';
        showGlobalSearchEmpty('未找到匹配内容');
        return;
    }
    const fragment = document.createDocumentFragment();
    hits.forEach((hit, i) => {
        // AI 会话组头：紧跟在工作区结果之后
        if (hit.aiSession && (i === 0 || !hits[i - 1].aiSession)) {
            const header = document.createElement('div');
            header.className = 'gs-group';
            header.textContent = 'AI 会话（未归档，简要=用户消息+每轮总结）';
            fragment.appendChild(header);
        }
        fragment.appendChild(globalSearchRow(hit, i));
    });
    deps.els.gsList.appendChild(fragment);
    const fileCount = hits.length - sessionHits.length;
    const countText = [];
    if (fileCount) countText.push(fileCount + ' 个文件结果');
    if (sessionHits.length) countText.push(sessionHits.length + ' 个会话结果');
    let suffix = '';
    if (res.truncated) suffix += '（工作区结果已截断）';
    if (sessionRes && sessionRes.truncated) suffix += '（会话结果达预算上限，可能不全）';
    deps.els.gsCount.textContent = countText.join(' · ') + suffix;
    updateGlobalSearchSelection();
}

function updateGlobalSearchSelection() {
    const rows = deps.els.gsList.querySelectorAll('.gs-row');
    for (let i = 0; i < rows.length; i++) {
        const selected = i === globalSearch.index;
        rows[i].classList.toggle('selected', selected);
        rows[i].setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) rows[i].scrollIntoView({block: 'nearest'});
    }
}

function moveGlobalSearchSelection(delta) {
    const total = globalSearch.hits.length;
    if (!total) return;
    globalSearch.index = ((globalSearch.index + delta) % total + total) % total;
    updateGlobalSearchSelection();
}

async function selectMatchInDoc(doc, line, column = 1, length = 1) {
    if (!doc || doc.binary || !doc.editor) return;
    if (doc !== deps.file) await deps.activateDoc(doc);
    const mode = doc.format && doc.format.table ? 'text' : 'code';
    if (deps.currentMode !== mode) deps.switchMode(mode);
    if (mode === 'code') {
        const ready = await deps.waitUntil(() => doc.editor && doc.editor.aceEditor);
        if (!ready) return;
        const ace = doc.editor.aceEditor;
        const lineNo = Math.max(1, Math.min(Number(line) || 1, ace.session.getLength()));
        const col = Math.max(0, (Number(column) || 1) - 1);
        const len = Math.max(1, Number(length) || 1);
        ace.gotoLine(lineNo, col, false);
        ace.selection.setSelectionRange({
            start: {row: lineNo - 1, column: col},
            end: {row: lineNo - 1, column: col + len},
        }, false);
        ace.scrollToLine(lineNo, true, true, () => {});
        ace.focus();
        return;
    }
    const ready = await deps.waitUntil(() => doc.pane && doc.pane.querySelector('textarea.jsoneditor-text'));
    if (!ready) return;
    const textarea = doc.pane.querySelector('textarea.jsoneditor-text');
    const lines = textarea.value.split('\n');
    const index = Math.max(0, Math.min((Number(line) || 1) - 1, lines.length - 1));
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i].length + 1;
    const lineStart = start;
    start += Math.max(0, (Number(column) || 1) - 1);
    const end = Math.min(start + Math.max(1, Number(length) || 1), lineStart + lines[index].length);
    textarea.focus();
    textarea.setSelectionRange(start, Math.max(start, end));
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, index * lineHeight - textarea.clientHeight / 2);
}

async function openGlobalSearchHit(hit) {
    if (!hit) return;
    // AI 会话命中：交给宿主接线（打开 AI 面板 → 切会话 → 定位到消息）
    if (hit.aiSession) {
        if (typeof deps.openAISessionHit !== 'function') {
            deps.flash('当前版本不支持跳转 AI 会话');
            return;
        }
        closeGlobalSearch();
        try {
            await deps.openAISessionHit(hit);
        } catch (e) {
            deps.flash('打开会话失败：' + ((e && e.message) || e), true);
        }
        return;
    }
    if (!hit || !hit.path) return;
    closeGlobalSearch();
    try {
        await deps.openPaths([hit.path]);
        const doc = deps.findDocByPath(hit.path);
        if (doc) await selectMatchInDoc(doc, hit.line, hit.column, hit.length);
    } catch (e) {
        deps.flash('打开失败：' + e, true);
    }
}

function handleGlobalSearchKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeGlobalSearch();
        return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveGlobalSearchSelection(e.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (globalSearch.hits.length) openGlobalSearchHit(globalSearch.hits[globalSearch.index]);
    }
}

function bindGlobalSearch() {
    deps.els.gsInput.addEventListener('input', scheduleGlobalSearch);
    deps.els.gsInput.addEventListener('keydown', handleGlobalSearchKey);
    deps.els.gsMask.addEventListener('mousedown', (e) => {
        if (e.target === deps.els.gsMask) closeGlobalSearch();
    });
}
bindGlobalSearch();


    return {isGlobalSearchOpen: () => globalSearch.open, openGlobalSearch};
}
