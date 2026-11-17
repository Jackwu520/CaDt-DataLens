// bridge-memo-view.js：快捷便签面板的虚拟标签页（每窗口一个，ipynb 式分块）。
// 本模块管「开标签 + 渲染 + 交互 + 粘贴图 + 作用域切换」；所有数据变更统一经
// run() → memo-store.mutate（缓存 + 防抖 CAS 保存 + 广播），AI 工具
// （memoApi）走同一套 store，保证用户与 AI 的编辑互相可见。
import {iconSvg} from '../core/icons.js';
import {dataUrlToFile} from '../core/image-clipboard.js';
import {createInput} from '../core/form-controls.js';
import {createImageLightbox} from '../shell/image-lightbox.js';
import {
    MEMO_LIMITS,
    addBlock,
    addItem,
    attachImage,
    cycleStatus,
    formatMemoForAI,
    moveItemToBlock,
    removeById,
    removeImageById,
    updateById,
} from './memo-model.js';
import {createMemoStore} from './memo-store.js';

export function createBridgeMemoView(deps) {

const SCOPE_STORAGE_KEY = 'cadt-memo-scope';

const store = createMemoStore({
    // deps.backend / deps.flash 是组合根的 getter 属性（每次访问求值，不拍快照）
    backend: deps.backend,
    flash: deps.flash,
    workspaceRoot: () => deps.workspaceFolder || '',
    // pending 翻转 → 组合根更新应用关窗脏标记（防抖窗口内关窗走确认流程，不静默丢）
    onPendingChange: deps.onPendingChange,
});

// 图片 data URL 缓存：key = scope + '|' + 相对路径，重渲染不发重复请求。
const imageDataUrls = new Map();

// 当前作用域：每窗口记住上次用哪个（重启面板回到原作用域）。
function currentScope() {
    try {
        const v = localStorage.getItem(SCOPE_STORAGE_KEY);
        if (v === 'workspace' || v === 'global') return v;
    } catch (e) { /* localStorage 不可用时用默认 */ }
    return 'workspace';
}
function setCurrentScope(scope) {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch (e) { /* 尽力而为 */ }
}

// ===== 视图实例表 =====
const views = new Set();
let lightbox = null; // 每窗口共用一个灯箱，宿主为内容区
let lastMenuX = 0;
let lastMenuY = 0;

// ===== doc 工厂（虚拟文档，守卫要求创建点在 bridge 里）=====
function openMemoTab() {
    const existing = deps.docs.find((d) => d.memo);
    if (existing) {
        deps.activateDoc(existing);
        return existing;
    }
    const doc = {
        id: 'memo-panel',
        path: null,
        name: '快捷便签',
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: {id: 'memo', name: '快捷便签', extensions: [], aceMode: 'text', rawOnly: true},
        memo: 'panel',
        mode: 'memo',
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
    };
    deps.docs.push(doc);
    deps.addDocToFocusedGroup(doc);
    deps.activateDoc(doc);
    return doc;
}

// ===== 挂载（createDocEditor 分支调用）=====
function createMemoView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active memo-pane';
    deps.els.editor.appendChild(pane);
    const root = document.createElement('div');
    root.className = 'memo-root';
    pane.appendChild(root);
    doc.pane = pane;
    doc.memoRoot = root;

    const view = {
        doc,
        root,
        scope: currentScope(),
        disposed: false,
        focusedItem: null, // 粘贴目标：最后点过的条目 id
    };
    views.add(view);

    const unsubscribe = store.onChange((scope) => {
        if (scope === view.scope && !view.disposed) render(view);
    });
    const onPaste = (e) => { handlePaste(view, e); };
    root.addEventListener('paste', onPaste);

    render(view);

    doc.memoUnmount = () => {
        view.disposed = true;
        unsubscribe();
        root.removeEventListener('paste', onPaste);
        views.delete(view);
        // 关面板前把未落盘的修改冲掉（flush 会清掉挂着的防抖定时器）
        store.flush(view.scope).then((res) => {
            if (!res.ok && deps.flash) deps.flash('快捷便签 保存失败：' + res.error, true);
        }).catch(() => {});
    };
}

// ===== 变更通路：UI 与 AI 共用 store.mutate =====
function run(view, fn) {
    return store.mutate(view.scope, fn);
}

// ===== 渲染 =====
function render(view) {
    if (view.disposed || !view.root.isConnected) return;
    const root = view.root;
    root.textContent = '';
    root.appendChild(buildTopBar(view));

    if (view.scope === 'workspace' && !(deps.workspaceFolder || '')) {
        root.appendChild(hintBox('没有打开的工作区——工作区快捷便签 需要先打开一个文件夹；全局快捷便签 可直接使用。'));
        return;
    }

    const doc = store.cached(view.scope);
    if (!doc) {
        root.appendChild(hintBox('正在加载…'));
        loadAndRender(view);
        return;
    }

    const body = document.createElement('div');
    body.className = 'memo-body';
    if (!doc.blocks.length) {
        body.appendChild(hintBox('还没有分组。新建一个块开始记录，或直接粘贴图片。'));
    }
    doc.blocks.forEach((block) => body.appendChild(buildBlock(view, block)));
    root.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'memo-footer';
    footer.appendChild(actionButton('+ 新建块', async () => {
        const res = await run(view, (doc2) => addBlock(doc2, ''));
        if (res.ok) requestAnimationFrame(() => startBlockTitleEdit(view, res.id));
    }));
    root.appendChild(footer);
}

function hintBox(text) {
    const empty = document.createElement('div');
    empty.className = 'memo-empty';
    empty.textContent = text;
    return empty;
}

function loadAndRender(view) {
    store.load(view.scope).then((res) => {
        if (view.disposed) return;
        if (res.error) {
            view.root.textContent = '';
            view.root.appendChild(hintBox('加载失败：' + res.error));
            return;
        }
        if (view.scope === currentScope()) render(view);
    }).catch(() => {});
}

function buildTopBar(view) {
    const bar = document.createElement('div');
    bar.className = 'memo-top';

    const seg = document.createElement('div');
    seg.className = 'memo-seg';
    seg.setAttribute('role', 'tablist');
    [['workspace', '工作区'], ['global', '全局']].forEach(([key, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'memo-seg-btn' + (view.scope === key ? ' active' : '');
        btn.textContent = label;
        btn.setAttribute('aria-selected', view.scope === key ? 'true' : 'false');
        btn.addEventListener('click', () => switchScope(view, key));
        seg.appendChild(btn);
    });
    bar.appendChild(seg);

    const doc = store.cached(view.scope);
    if (doc) {
        const t = totalsOfDoc(doc);
        if (t.items) {
            const summary = document.createElement('div');
            summary.className = 'memo-summary';
            summary.textContent = t.done + '/' + t.items + (t.doing ? ' · 进行中 ' + t.doing : '');
            bar.appendChild(summary);
        }
    }

    const spacer = document.createElement('div');
    spacer.className = 'memo-top-spacer';
    bar.appendChild(spacer);
    return bar;
}

function switchScope(view, next) {
    if (view.scope === next) return;
    // 切走前先提交正在输入的行内编辑，再冲掉未保存的修改（flush 内部清定时器并立即保存；冲突已在 store 侧重载广播）
    if (view.activeCommit) view.activeCommit();
    store.flush(view.scope).then((res) => {
        if (res && !res.ok && deps.flash) deps.flash('快捷便签 保存失败：' + res.error, true);
        view.scope = next;
        setCurrentScope(next);
        render(view);
    }).catch(() => {
        view.scope = next;
        setCurrentScope(next);
        render(view);
    });
}

function buildBlock(view, block) {
    const box = document.createElement('div');
    box.className = 'memo-block' + (block.collapsed ? ' collapsed' : '');
    box.dataset.blockId = block.id;

    const head = document.createElement('div');
    head.className = 'qt-block-head';

    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'qt-chev';
    chev.setAttribute('aria-expanded', block.collapsed ? 'false' : 'true');
    chev.innerHTML = iconSvg('chevron-right', 12) || '▸';
    chev.addEventListener('click', () => {
        run(view, (doc) => updateById(doc, block.id, {collapsed: !block.collapsed}));
    });
    head.appendChild(chev);

    const title = document.createElement('div');
    title.className = 'qt-block-title';
    title.textContent = block.title;
    title.addEventListener('dblclick', () => startBlockTitleEdit(view, block.id));
    head.appendChild(title);

    const count = document.createElement('span');
    count.className = 'qt-block-count';
    count.textContent = String(block.items.length);
    head.appendChild(count);

    const actions = document.createElement('span');
    actions.className = 'qt-block-actions';
    actions.appendChild(actionButton('＋', () => appendEditableItem(view, block.id), '添加条目'));
    actions.appendChild(actionButton('⋯', (x, y) => openBlockMenu(view, block.id, x, y), '块操作'));
    head.appendChild(actions);

    head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openBlockMenu(view, block.id, e.clientX, e.clientY);
    });

    box.appendChild(head);

    if (!block.collapsed) {
        const items = document.createElement('div');
        items.className = 'qt-block-items';
        block.items.forEach((item) => items.appendChild(buildItem(view, block, item)));
        box.appendChild(items);
    }
    return box;
}

function buildItem(view, block, item) {
    const row = document.createElement('div');
    row.className = 'qt-item st-' + item.status;
    row.dataset.itemId = item.id;

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'qt-dot';
    dot.setAttribute('data-tip', '切换状态');
    dot.addEventListener('click', () => {
        run(view, (doc) => updateById(doc, item.id, {status: cycleStatus(item.status)}));
    });
    row.appendChild(dot);

    const text = document.createElement('div');
    text.className = 'qt-item-text' + (item.text ? '' : ' empty');
    text.textContent = item.text || '输入便签…';
    text.addEventListener('click', () => startItemTextEdit(view, item.id));
    row.appendChild(text);

    if (item.images.length) {
        const thumbs = document.createElement('div');
        thumbs.className = 'qt-item-thumbs';
        item.images.forEach((rel) => thumbs.appendChild(buildThumb(view, item, rel)));
        row.appendChild(thumbs);
    }

    const actions = document.createElement('span');
    actions.className = 'qt-item-actions';
    actions.appendChild(actionButton('⋯', (x, y) => openItemMenu(view, item.id, x, y), '条目操作'));
    row.appendChild(actions);

    row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openItemMenu(view, item.id, e.clientX, e.clientY);
    });
    row.addEventListener('mousedown', () => { view.focusedItem = item.id; });
    return row;
}

function imageKey(scope, rel) { return scope + '|' + rel; }

function buildThumb(view, item, rel) {
    const box = document.createElement('span');
    box.className = 'qt-thumb';
    box.dataset.rel = rel;
    const img = document.createElement('img');
    img.alt = '贴图';
    img.addEventListener('click', () => openThumbLightbox(view, item, rel));
    box.appendChild(img);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'qt-thumb-del';
    del.setAttribute('data-tip', '移除贴图');
    del.textContent = '×';
    del.addEventListener('click', () => {
        run(view, (doc) => removeImageById(doc, item.id, rel));
    });
    box.appendChild(del);

    const cached = imageDataUrls.get(imageKey(view.scope, rel));
    if (cached) {
        img.src = cached;
    } else {
        resolveImage(view, rel).then((url) => {
            if (!url || view.disposed) return;
            const found = view.root.querySelector('.qt-thumb[data-rel="' + cssEscape(rel) + '"] img');
            if (found) found.src = url;
        }).catch(() => {});
    }
    return box;
}

async function resolveImage(view, rel) {
    const key = imageKey(view.scope, rel);
    if (imageDataUrls.has(key)) return imageDataUrls.get(key);
    const rootDir = await memoRootDir(view.scope);
    if (!rootDir) return '';
    const abs = rootDir.replace(/[\\/]+$/, '') + '/' + rel.replace(/[\\/]+/g, '/');
    const url = await deps.backend.ReadImageAsDataURL(abs);
    if (url) imageDataUrls.set(key, url);
    return url || '';
}

// memoRootDir 作用域根目录（贴图绝对路径 = 根 + 相对引用）：
// 工作区 = <ws>/.cadt/memo；全局 = <应用数据>/memo（AIAppDir 绑定取应用数据根）。
async function memoRootDir(scope) {
    if (scope === 'workspace') {
        const ws = deps.workspaceFolder || '';
        return ws ? ws.replace(/[\\/]+$/, '') + '/.cadt/memo' : '';
    }
    try {
        const appDir = await deps.backend.AIAppDir();
        return appDir ? appDir.replace(/[\\/]+$/, '') + '/memo' : '';
    } catch (e) {
        return '';
    }
}

function actionButton(label, onClick, tip) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qt-btn';
    btn.textContent = label;
    if (tip) btn.setAttribute('data-tip', tip);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(e.clientX, e.clientY);
    });
    return btn;
}

// ===== 行内编辑 =====
function startBlockTitleEdit(view, blockId) {
    const doc = store.cached(view.scope);
    const block = doc && doc.blocks.find((b) => b.id === blockId);
    const head = view.root.querySelector('.memo-block[data-block-id="' + cssEscape(blockId) + '"] .qt-block-head');
    if (!block || !head) return;
    const titleEl = head.querySelector('.qt-block-title');
    if (!titleEl) return;
    startInlineEdit(view, titleEl, block.title, MEMO_LIMITS.blockTitleMax, (value) => {
        run(view, (doc2) => updateById(doc2, blockId, {text: value}));
    });
}

function startItemTextEdit(view, itemId) {
    const doc = store.cached(view.scope);
    const item = doc && findItemIn(doc, itemId);
    const textEl = view.root.querySelector('.qt-item[data-item-id="' + cssEscape(itemId) + '"] .qt-item-text');
    if (!item || !textEl) return;
    view.focusedItem = itemId;
    startInlineEdit(view, textEl, item.text, MEMO_LIMITS.textMax, (value) => {
        run(view, (doc2) => {
            const target = findItemIn(doc2, itemId);
            // 新建行提交时仍为空：直接删掉，不留占位垃圾
            if (target && !target.text && !value.trim() && target.createdAt === target.updatedAt) {
                return removeById(doc2, itemId);
            }
            return updateById(doc2, itemId, {text: value});
        });
    });
}

// startInlineEdit 把展示元素换成 dlg-input 行内编辑：Enter/blur 提交、Esc 还原。
function startInlineEdit(view, displayEl, initial, maxLen, onCommit) {
    if (displayEl.dataset.editing === '1') return;
    displayEl.dataset.editing = '1';
    const original = String(initial == null ? '' : initial);
    const editor = createInput({value: original});
    editor.element.className = 'dlg-input qt-inline-edit';
    if (maxLen) editor.element.setAttribute('maxlength', String(maxLen));
    displayEl.textContent = '';
    displayEl.appendChild(editor.element);
    editor.element.focus();
    editor.element.select();
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        view.activeCommit = null;
        const value = editor.control.value;
        displayEl.dataset.editing = '';
        if (commit && value !== original) onCommit(value);
        render(view); // 回到数据态展示；变更通路里的广播渲染与之幂等
    };
    editor.element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
        }
    });
    editor.element.addEventListener('blur', () => finish(true));
    editor.element.addEventListener('click', (e) => e.stopPropagation());
    // 关面板/切作用域时行内编辑来不及 blur：登记提交闭包，卸载前强制提交（自动保存不丢字）
    view.activeCommit = () => finish(true);
}

function findItemIn(doc, itemId) {
    for (const block of doc.blocks) {
        const item = block.items.find((it) => it.id === itemId);
        if (item) return item;
    }
    return null;
}

// appendEditableItem 新建一条空条目并立即进入编辑（提交空则删行，见 startItemTextEdit）。
function appendEditableItem(view, blockId) {
    store.mutate(view.scope, (doc) => addItem(doc, blockId, '', {allowEmpty: true})).then((res) => {
        if (res.ok) requestAnimationFrame(() => startItemTextEdit(view, res.id));
        else deps.flash(res.error, true);
    }).catch(() => {});
}

function totalsOfDoc(doc) {
    let items = 0, done = 0, doing = 0;
    for (const block of doc.blocks) {
        for (const item of block.items) {
            items++;
            if (item.status === 'completed') done++;
            else if (item.status === 'in_progress') doing++;
        }
    }
    return {items, done, doing};
}

function openThumbLightbox(view, item, rel) {
    resolveImage(view, rel).then((url) => {
        if (!url) { deps.flash('贴图读取失败：' + rel, true); return; }
        if (!lightbox) lightbox = createImageLightbox(deps.els.editor);
        lightbox.open(null, url, (item.text || '贴图') + ' · ' + rel.split('/').pop());
    }).catch((e) => deps.flash('贴图读取失败：' + ((e && e.message) || e), true));
}

// ===== 菜单 =====
function openBlockMenu(view, blockId, x, y) {
    lastMenuX = x; lastMenuY = y;
    const doc = store.cached(view.scope);
    const block = doc && doc.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const idx = doc.blocks.findIndex((b) => b.id === blockId);
    deps.ctxMenu.open([
        {label: '添加条目', action: () => appendEditableItem(view, blockId)},
        {label: '重命名', action: () => startBlockTitleEdit(view, blockId)},
        {label: block.collapsed ? '展开' : '折叠', action: () => {
            run(view, (doc2) => updateById(doc2, blockId, {collapsed: !block.collapsed}));
        }},
        {label: '上移', disabled: idx <= 0, action: () => {
            run(view, (doc2) => updateById(doc2, blockId, {index: idx - 1}));
        }},
        {label: '下移', disabled: idx < 0 || idx >= doc.blocks.length - 1, action: () => {
            run(view, (doc2) => updateById(doc2, blockId, {index: idx + 2}));
        }},
        {sep: true},
        {label: '删除块', action: () => {
            // 二级确认：块删除连带全部条目
            deps.ctxMenu.open([{
                label: '确认删除「' + block.title + '」（含 ' + block.items.length + ' 项）',
                action: () => run(view, (doc2) => removeById(doc2, blockId)).then((res) => {
                    if (!res.ok) deps.flash(res.error, true);
                }),
            }], lastMenuX, lastMenuY);
        }},
    ], x, y);
}

function openItemMenu(view, itemId, x, y) {
    lastMenuX = x; lastMenuY = y;
    const doc = store.cached(view.scope);
    if (!doc) return;
    let hostBlock = null, idx = -1;
    for (const block of doc.blocks) {
        const i = block.items.findIndex((it) => it.id === itemId);
        if (i >= 0) { hostBlock = block; idx = i; break; }
    }
    if (!hostBlock) return;
    const otherBlocks = doc.blocks.filter((b) => b.id !== hostBlock.id);
    deps.ctxMenu.open([
        {label: '编辑', action: () => startItemTextEdit(view, itemId)},
        {label: '粘贴图片', action: () => pasteImageInto(view, itemId)},
        {sep: true},
        {label: '上移', disabled: idx <= 0, action: () => {
            run(view, (doc2) => updateById(doc2, itemId, {index: idx - 1}));
        }},
        {label: '下移', disabled: idx < 0 || idx >= hostBlock.items.length - 1, action: () => {
            run(view, (doc2) => updateById(doc2, itemId, {index: idx + 2}));
        }},
        {label: '移到其他块…', disabled: !otherBlocks.length, action: () => {
            deps.ctxMenu.open(otherBlocks.map((b) => ({
                label: b.title,
                action: () => run(view, (doc2) => moveItemToBlock(doc2, itemId, b.id)).then((res) => {
                    if (!res.ok) deps.flash(res.error, true);
                }),
            })), x, y);
        }},
        {sep: true},
        {label: '删除条目', action: () => {
            run(view, (doc2) => removeById(doc2, itemId)).then((res) => {
                if (!res.ok) deps.flash(res.error, true);
            });
        }},
    ], x, y);
}

// ===== 粘贴图 =====
async function handlePaste(view, e) {
    const clipboard = e.clipboardData;
    if (!clipboard || !clipboard.items) return;
    const files = [];
    for (const item of clipboard.items) {
        if (item && item.kind === 'file') {
            const file = item.getAsFile();
            if (file && file.type && file.type.startsWith('image/')) files.push(file);
        }
    }
    if (!files.length) return; // 纯文本粘贴走浏览器默认（编辑框内）
    e.preventDefault();
    for (const file of files) await attachImageFile(view, resolveFocusedItemId(view), file);
}

// resolveFocusedItemId 粘贴目标：最后点过的条目 → 最后一个未折叠块的末条。
function resolveFocusedItemId(view) {
    const doc = store.cached(view.scope);
    if (!doc) return null;
    if (view.focusedItem && findItemIn(doc, view.focusedItem)) return view.focusedItem;
    const candidates = doc.blocks.filter((b) => !b.collapsed);
    const block = candidates.length ? candidates[candidates.length - 1] : null;
    if (!block || !block.items.length) return null;
    return block.items[block.items.length - 1].id;
}

async function attachImageFile(view, itemId, file) {
    let payload;
    try {
        payload = await deps.prepareImagePayload(file, {name: file.name || '粘贴的图片'});
    } catch (e) {
        deps.flash('图片读取失败：' + ((e && e.message) || e), true);
        return;
    }
    if (!payload) { deps.flash('图片读取失败', true); return; }
    await attachImagePayload(view, itemId, payload);
}

function payloadToDataUrl(payload) {
    return 'data:' + payload.mime + ';base64,' + payload.data;
}

async function attachImagePayload(view, itemId, payload) {
    let rel;
    try {
        rel = await store.saveImage(view.scope, payloadToDataUrl(payload));
    } catch (e) {
        deps.flash('贴图保存失败：' + ((e && e.message) || e), true);
        return;
    }
    const doc = store.cached(view.scope);
    let targetId = itemId;
    if (!targetId || !findItemIn(doc, targetId)) {
        // 没有可挂的条目：建一条占位条目再挂图
        const added = await store.mutate(view.scope, (doc2) => addItem(doc2, '', '（贴图便签）'));
        if (!added.ok) { deps.flash(added.error, true); return; }
        targetId = added.id;
    }
    const res = await store.mutate(view.scope, (doc2) => attachImage(doc2, targetId, rel));
    if (!res.ok) deps.flash(res.error, true);
}

// pasteImageInto 右键菜单粘贴：菜单点击不触发 paste 事件，请后端回读系统剪贴板。
async function pasteImageInto(view, itemId) {
    if (!deps.backend.GetClipboardImage) { deps.flash('当前环境不支持读取剪贴板图片', true); return; }
    let dataUrl = '';
    try {
        dataUrl = await deps.backend.GetClipboardImage();
    } catch (e) {
        deps.flash('读取剪贴板失败：' + ((e && e.message) || e), true);
        return;
    }
    if (!dataUrl) { deps.flash('剪贴板里没有图片', true); return; }
    const file = dataUrlToFile(dataUrl, '粘贴的图片');
    if (!file) { deps.flash('剪贴板图片无法解析', true); return; }
    await attachImageFile(view, itemId || resolveFocusedItemId(view), file);
}

// ===== 对外 API（main.js 转发给 AI 面板 / 活动栏 / 工作区切换）=====

function countsText(doc) {
    const t = totalsOfDoc(doc);
    return t.items
        ? ('当前：' + t.done + '/' + t.items + ' 完成' + (t.doing ? '，' + t.doing + ' 项进行中' : '') + '。')
        : '当前：还没有条目。';
}

// memoApi：AI 工具（memo 动作）的执行通道。改完即防抖保存并广播刷新。
const memoApi = {
    normalizeScope(scope) { return scope === 'global' ? 'global' : 'workspace'; },
    async list(scope) {
        const s = this.normalizeScope(scope);
        const res = await store.load(s);
        if (res.error) throw new Error(res.error);
        return formatMemoForAI(res.doc, s === 'global' ? '全局快捷便签' : '工作区快捷便签');
    },
    async add(scope, kind, blockId, text) {
        const s = this.normalizeScope(scope);
        if (kind === 'block') {
            const res = await store.mutate(s, (doc) => addBlock(doc, text));
            if (!res.ok) throw new Error(res.error);
            return '已新建分组，id：' + res.id + '。' + countsText(res.doc);
        }
        if (kind !== 'item') throw new Error('kind 只支持 item（条目）或 block（分组）');
        const res = await store.mutate(s, (doc) => addItem(doc, blockId || '', text));
        if (!res.ok) throw new Error(res.error);
        return '已添加条目，id：' + res.id + '（所在块 ' + res.blockId + '）。' + countsText(res.doc);
    },
    async update(scope, id, patch) {
        const s = this.normalizeScope(scope);
        const res = await store.mutate(s, (doc) => updateById(doc, id, patch || {}));
        if (!res.ok) throw new Error(res.error);
        return '已更新 ' + id + (res.kind === 'block' ? '（块，text 即标题）' : '（条目）') + '。' + countsText(res.doc);
    },
    async remove(scope, id) {
        const s = this.normalizeScope(scope);
        const res = await store.mutate(s, (doc) => removeById(doc, id));
        if (!res.ok) throw new Error(res.error);
        return '已删除 ' + id + (res.removedItems > 1 ? '（连带 ' + res.removedItems + ' 条条目）' : '') + '。' + countsText(res.doc);
    },
    open(scope) {
        openMemoTab();
        if (scope === 'global' || scope === 'workspace') {
            const view = findOpenView();
            if (view && view.scope !== scope) switchScope(view, scope);
        }
        return '已打开快捷便签面板';
    },
    // flushAll / hasPending：关窗确认流程与关窗脏标记用（见 main.js 的 confirm-close 与 anyDirty 接线）
    flushAll: () => store.flushAll(),
    hasPending: () => store.hasPending(),
};

function findOpenView() {
    for (const view of views) {
        if (!view.disposed) return view;
    }
    return null;
}

// memoOnWorkspaceEvent：workspace-changed 事件过滤——变更路径含 memo.json 才
// 重读（其他窗口/外部改动），内容没变时 store 内部静默。
function memoOnWorkspaceEvent(payload) {
    const paths = payload && Array.isArray(payload.paths) ? payload.paths : [];
    if (!paths.length) return;
    const hit = paths.some((p) => {
        const norm = String(p).replace(/[\\/]+/g, '/').toLowerCase();
        return norm.endsWith('/.cadt/memo/memo.json');
    });
    if (hit) store.reloadExternal('workspace').catch(() => {});
}

// memoOnWindowFocus：全局作用域没有文件 watch，窗口拿回焦点时静默对账一次。
function memoOnWindowFocus() {
    const view = findOpenView();
    if (!view || view.scope !== 'global') return;
    store.reloadExternal('global').catch(() => {});
}

// memoWorkspaceChanged：工作区切换/关闭——丢弃工作区缓存并重渲染（防串工作区）。
function memoWorkspaceChanged() {
    store.forgetWorkspace();
    const view = findOpenView();
    if (view && view.scope === 'workspace') render(view);
}

function cssEscape(value) {
    return (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

return {
    openMemoTab,
    createMemoView,
    memoApi,
    memoOnWorkspaceEvent,
    memoOnWindowFocus,
    memoWorkspaceChanged,
};
}
