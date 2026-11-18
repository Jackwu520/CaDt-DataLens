// bridge-memo-view.js：快捷便签面板的虚拟标签页（每窗口一个，ipynb 式分块）。
// 本模块管「开标签 + 渲染 + 交互 + 粘贴图 + 作用域切换」；所有数据变更统一经
// run() → memo-store.mutate（缓存 + 防抖 CAS 保存 + 广播），AI 工具
// （memoApi）走同一套 store，保证用户与 AI 的编辑互相可见。
import {iconSvg} from '../core/icons.js';
import {copyImageUrlToClipboard, dataUrlToFile} from '../core/image-clipboard.js';
import {createInput, createTextarea} from '../core/form-controls.js';
import {createImageLightbox} from '../shell/image-lightbox.js';
import {memoDocxBase64} from './memo-docx.js';
import {
    MEMO_LIMITS,
    addBlock,
    addItem,
    attachImage,
    collectImageRefs,
    cycleStatus,
    exportMemoMarkdown,
    formatMemoForAI,
    moveItemToBlock,
    removeById,
    removeImageById,
    shouldFoldMemoItem,
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
    // 贴图 GC 定位：用缓存捕获的 workspace 解析作用域根（换过工作区也删对文件）
    resolveRoot: memoRootDirFor,
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

// 超长条目默认折叠：手动展开过的条目 id 记这里，重渲染不弹回（内存即可，重启恢复默认折叠）。
const itemFoldExpanded = new Set();

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
        focusedItem: null,  // 粘贴目标：最后点过的条目 id
        lastEditItem: null, // 智能插入锚点：最近一次编辑过的条目 id
    };
    views.add(view);

    const unsubscribe = store.onChange((scope) => {
        if (scope === view.scope && !view.disposed) render(view);
    });
    const onPaste = (e) => { handlePaste(view, e); };
    root.addEventListener('paste', onPaste);
    // 右键拦截：块/条目自己的 contextmenu 处理器会打开便签菜单，但事件仍会冒泡到
    // mainPane 的通用处理器，弹出编辑器的「撤销/折叠/书签…」菜单覆盖掉便签菜单
    // （那个灰掉的「折叠」就是编辑器的 disabled 项）。这里统一掐断冒泡；空白处右键
    // 给一个「新建块」兜底菜单，保证便签面板右键永远是便签自己的菜单。
    const onContextMenu = (e) => {
        e.stopPropagation();
        // 块/条目处理器已经 preventDefault + 开菜单，这里只处理没被它们接住的空白区
        if (e.defaultPrevented) return;
        e.preventDefault();
        deps.ctxMenu.open([
            {label: '新建块', icon: 'E710', action: () => {
                commitActive(view);
                run(view, (doc2) => addBlock(doc2, '')).then((res) => {
                    if (res.ok) requestAnimationFrame(() => startBlockTitleEdit(view, res.id));
                    else deps.flash(res.error, true);
                }).catch(() => {});
            }},
            {label: '新建文本条目', icon: 'E710', action: () => quickAdd(view, 'text')},
            {label: '新建 Markdown 条目', icon: 'E710', action: () => quickAdd(view, 'md')},
        ], e.clientX, e.clientY);
    };
    root.addEventListener('contextmenu', onContextMenu);

    render(view);

    doc.memoUnmount = () => {
        view.disposed = true;
        unsubscribe();
        root.removeEventListener('paste', onPaste);
        root.removeEventListener('contextmenu', onContextMenu);
        views.delete(view);
        if (view.watchingGlobal && deps.backend && deps.backend.MemoUnwatch) {
            Promise.resolve(deps.backend.MemoUnwatch('global', '')).catch(() => {});
        }
        // 关面板前把未落盘的修改冲掉；成功才让出写权（失败保持锁，避免半成品交接）
        store.flush(view.scope).then((res) => {
            if (res && !res.ok) {
                if (deps.flash) deps.flash('快捷便签 保存失败：' + res.error, true);
                return;
            }
            return store.releaseLease(view.scope).then((rel) => {
                if (rel && !rel.ok && deps.flash) deps.flash('快捷便签 让出写权失败：' + rel.error, true);
            });
        }).catch(() => {});
    };
}

// pagehide 兜底：页面被销毁前尽力 flush + 释放；进程退出时内核还会兜底。
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => {
        store.flushAll().then(() => store.releaseAll()).catch(() => {});
    });
}

// ===== 变更通路：UI 与 AI 共用 store.mutate =====
function run(view, fn) {
    return store.mutate(view.scope, fn);
}

// commitActive 提交正在进行的行内编辑（草稿入库 + 空行清理）。防误触按钮用
// mousedown+preventDefault 拦下了 blur，需要提交时手动调这里。
function commitActive(view) {
    if (view.activeCommit) view.activeCommit();
}

// onButton 统一按钮事件：mousedown 即响应并 preventDefault——左键不再抢走行内编辑的
// 焦点（blur 提交会把整个面板重渲染，click 目标被换掉就成了死区：折叠/＋/⋯ 点不动）。
function onButton(btn, onClick, tip) {
    if (tip) btn.setAttribute('data-tip', tip);
    btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 不抢焦点：正在编辑的 textarea 保持焦点，由处理函数决定何时提交
        e.stopPropagation();
        onClick(e.clientX, e.clientY);
    });
    return btn;
}

// ===== 渲染 =====
function render(view) {
    if (view.disposed || !view.root.isConnected) return;
    const root = view.root;
    // 全量重建会换掉 .memo-body 滚动容器，导致任何改动后跳回顶部。
    // 重建前记下滚动位置，重建后原地还原（切作用域/首次加载时 body 不存在，记 0）。
    const prevBody = root.querySelector('.memo-body');
    const scrollTop = prevBody ? prevBody.scrollTop : 0;
    root.textContent = '';
    syncMemoWatch(view);
    const lease = store.state(view.scope);
    root.classList.toggle('memo-readonly', !!lease.readOnly);
    root.appendChild(buildTopBar(view));
    if (lease.readOnly) root.appendChild(readOnlyBanner(lease.owner));

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
    // 还原滚动位置（内容变短时浏览器会自动 clamp 到新的最大滚动量）
    if (scrollTop) body.scrollTop = scrollTop;

    const footer = document.createElement('div');
    footer.className = 'memo-footer';
    const newBlock = document.createElement('button');
    newBlock.type = 'button';
    newBlock.className = 'memo-new-block';
    newBlock.innerHTML = iconSvg('plus', 12) + '<span>新建块</span>';
    onButton(newBlock, () => {
        commitActive(view);
        run(view, (doc2) => addBlock(doc2, '')).then((res) => {
            if (res.ok) requestAnimationFrame(() => startBlockTitleEdit(view, res.id));
            else deps.flash(res.error, true);
        }).catch(() => {});
    });
    footer.appendChild(newBlock);
    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'memo-new-block';
    jumpBtn.innerHTML = iconSvg('search', 12) + '<span>跳转</span>';
    onButton(jumpBtn, (x, y) => openJumpMenu(view, x, y));
    footer.appendChild(jumpBtn);
    root.appendChild(footer);
}

function hintBox(text) {
    const empty = document.createElement('div');
    empty.className = 'memo-empty';
    empty.textContent = text;
    return empty;
}

function loadAndRender(view) {
    store.load(view.scope, {acquire: true}).then((res) => {
        if (view.disposed) return;
        if (res.error) {
            view.root.textContent = '';
            view.root.appendChild(hintBox('加载失败：' + res.error));
            return;
        }
        if (view.scope === currentScope()) render(view);
    }).catch(() => {});
}

function readOnlyBanner(owner) {
    const box = document.createElement('div');
    box.className = 'memo-readonly-banner';
    const pid = owner && owner.pid;
    box.textContent = '只读：快捷便签正在另一窗口编辑' + (pid ? '（PID ' + pid + '）' : '') +
        '。关闭那边的面板后可在此编辑。';
    return box;
}

// syncMemoWatch：全局作用域补目录 watch；工作区已有 workspace-changed，不重复监听。
function syncMemoWatch(view) {
    if (!view || view.disposed || !deps.backend) return;
    const want = view.scope === 'global';
    if (view.watchingGlobal === want) return;
    view.watchingGlobal = want;
    if (want) {
        if (deps.backend.MemoWatch) {
            Promise.resolve(deps.backend.MemoWatch('global', '')).catch(() => {
                // 目录还不存在（首次使用）等：下次 render 再试
                view.watchingGlobal = false;
            });
        } else {
            view.watchingGlobal = false;
        }
    } else if (deps.backend.MemoUnwatch) {
        Promise.resolve(deps.backend.MemoUnwatch('global', '')).catch(() => {});
    }
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
        onButton(btn, () => switchScope(view, key));
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

    // 快捷操作行（对齐 PyCharm ipynb 尾部快捷区，放在顶栏最右）：
    // 新条目的落点智能判断——正在编辑某条目时插到它后面，否则加到最后一个块的末尾。
    const quick = document.createElement('div');
    quick.className = 'memo-quick';
    [['text', '文本'], ['md', 'Markdown'], ['block', '新分组']].forEach(([kind, label], i) => {
        if (i) {
            const divider = document.createElement('span');
            divider.className = 'memo-quick-sep';
            quick.appendChild(divider);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'memo-quick-btn';
        btn.textContent = label;
        onButton(btn, () => quickAdd(view, kind));
        quick.appendChild(btn);
    });
    bar.appendChild(quick);

    // 导出：当前作用域 → Markdown（图片复制到旁侧 img/）/ HTML（单文件图片内嵌）
    // + 市场插件注册的导出器（Word/PDF 等，重依赖生成逻辑在插件侧）
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'memo-quick-btn memo-export-btn';
    exportBtn.textContent = '导出';
    onButton(exportBtn, (x, y) => {
        const pluginItems = getPluginDocConverters().map((c) => ({
            label: c.label,
            icon: 'E896',
            action: () => runDocConverter(view, c),
        }));
        deps.ctxMenu.open([
            {label: '导出 Markdown（图片复制到旁侧 img/）', icon: 'E896', action: () => exportMemo(view, 'md')},
            {label: '导出 HTML（单文件，图片内嵌）', icon: 'E896', action: () => exportMemo(view, 'html')},
            {label: '导出 Word（.doc，图片存旁侧）', icon: 'E896', action: () => exportMemo(view, 'doc')},
            {label: '导出 Word（.docx 原生，图片内嵌）', icon: 'E896', action: () => exportMemo(view, 'docx')},
            ...(pluginItems.length ? [{sep: true}, ...pluginItems] : []),
        ], x, y);
    });
    bar.appendChild(exportBtn);
    return bar;
}

// quickAdd 顶栏快捷新建：kind = 'text' | 'md' | 'block'。
function quickAdd(view, kind) {
    commitActive(view); // 先提交正在编辑的草稿（智能插入锚点取的是这条）
    const target = smartInsertTarget(view);
    if (kind === 'block') {
        run(view, (doc) => addBlock(doc, '')).then((res) => {
            if (res.ok) requestAnimationFrame(() => startBlockTitleEdit(view, res.id));
            else deps.flash(res.error, true);
        }).catch(() => {});
        return;
    }
    store.mutate(view.scope, (doc) =>
        addItem(doc, target ? target.blockId : '', '', {allowEmpty: true, kind, afterId: target ? target.afterId : ''})
    ).then((res) => {
        if (res.ok) requestAnimationFrame(() => startItemTextEdit(view, res.id));
        else deps.flash(res.error, true);
    }).catch(() => {});
}

// smartInsertTarget 新条目落点：最近编辑过的条目仍在时插到它后面（同一块），
// 否则最后一个块的末尾（没有块则由 addItem 自动建「便签」块兜底）。
function smartInsertTarget(view) {
    const doc = store.cached(view.scope);
    if (!doc) return null;
    if (view.lastEditItem) {
        for (const block of doc.blocks) {
            if (block.items.some((it) => it.id === view.lastEditItem)) {
                return {blockId: block.id, afterId: view.lastEditItem};
            }
        }
    }
    const last = doc.blocks.length ? doc.blocks[doc.blocks.length - 1] : null;
    return last ? {blockId: last.id, afterId: ''} : null;
}

function switchScope(view, next) {
    if (view.scope === next) return;
    // 切走前先提交正在输入的行内编辑，再冲掉未保存的修改（flush 内部清定时器并立即保存；
    // 冲突已在 store 侧重载广播）。冲盘失败时不切、保持写权，避免把半成品让出去。
    if (view.activeCommit) view.activeCommit();
    const old = view.scope;
    store.flush(old).then((res) => {
        if (res && !res.ok) {
            if (deps.flash) deps.flash('快捷便签 保存失败：' + res.error, true);
            return;
        }
        return store.releaseLease(old).then((rel) => {
            if (rel && !rel.ok && deps.flash) deps.flash('快捷便签 让出写权失败：' + rel.error, true);
            view.scope = next;
            setCurrentScope(next);
            if (store.cached(next)) {
                // 已缓存的作用域可能是上次的只读副本：先尝试接管再渲染。
                store.retryAcquire(next).then(() => render(view)).catch(() => render(view));
            } else {
                render(view);
            }
        });
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
    head.className = 'memo-block-head';

    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'memo-chev';
    chev.setAttribute('aria-expanded', block.collapsed ? 'false' : 'true');
    chev.innerHTML = iconSvg('chevron-right', 12) || '▸';
    onButton(chev, () => {
        commitActive(view);
        run(view, (doc) => {
            const b = doc.blocks.find((x) => x.id === block.id);
            return updateById(doc, block.id, {collapsed: !(b ? b.collapsed : block.collapsed)});
        });
    });
    head.appendChild(chev);

    const title = document.createElement('div');
    title.className = 'memo-block-title';
    title.textContent = block.title;
    title.addEventListener('dblclick', () => startBlockTitleEdit(view, block.id));
    head.appendChild(title);

    const count = document.createElement('span');
    count.className = 'memo-block-count';
    count.textContent = String(block.items.length);
    head.appendChild(count);

    const actions = document.createElement('span');
    actions.className = 'memo-block-actions';
    actions.appendChild(actionButton('＋', () => appendEditableItem(view, block.id), '添加条目'));
    actions.appendChild(actionButton('⋯', (x, y) => openBlockMenu(view, block.id, x, y), '块操作'));
    head.appendChild(actions);

    head.addEventListener('contextmenu', (e) => {
        // 标题正在行内编辑时放行原生菜单（撤销/剪切/复制/粘贴/全选原生可用）
        if (e.target.closest('.memo-inline-edit')) return;
        e.preventDefault();
        openBlockMenu(view, block.id, e.clientX, e.clientY);
    });

    box.appendChild(head);

    if (!block.collapsed) {
        const items = document.createElement('div');
        items.className = 'memo-block-items';
        block.items.forEach((item) => items.appendChild(buildItem(view, block, item)));
        box.appendChild(items);
    }
    return box;
}

function buildItem(view, block, item) {
    const row = document.createElement('div');
    row.className = 'memo-item st-' + item.status;
    row.dataset.itemId = item.id;

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'memo-dot';
    dot.setAttribute('data-tip', '切换状态');
    onButton(dot, () => {
        commitActive(view);
        run(view, (doc) => {
            const it = findItemIn(doc, item.id);
            return updateById(doc, item.id, {status: cycleStatus(it ? it.status : item.status)});
        });
    });
    row.appendChild(dot);

    const text = document.createElement('div');
    text.className = 'memo-item-text' + (item.text ? '' : ' empty');
    if (item.kind === 'md' && item.text) {
        // Markdown 条目：失焦即渲染，点击回到源码编辑（renderMarkdownHtml 已过 DOMPurify）
        text.classList.add('memo-md');
        text.innerHTML = '<div class="ai-md">' + deps.renderMarkdownHtml(item.text, {}) + '</div>';
        loadInlineImages(view, text, 'data-ai-src');
    } else if (item.text && item.text.indexOf('](img/') >= 0) {
        // 文本条目带贴图占位符：整段转义后把占位符换成内联图（原始 HTML 不执行）
        text.innerHTML = renderTextWithImages(item.text);
        loadInlineImages(view, text, 'data-memo-img');
    } else {
        text.textContent = item.text || (item.kind === 'md' ? '输入 Markdown…' : '输入便签…');
    }
    text.addEventListener('click', (e) => {
        // 点内联贴图（文本占位符渲染 / md 渲染图）→ 放大预览；点文字 → 编辑源码
        const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
        if (img) {
            const rel = img.getAttribute('data-memo-img') || img.getAttribute('data-ai-src') || '';
            if (rel.indexOf('img/') === 0) {
                e.stopPropagation();
                openThumbLightbox(view, item, rel);
                return;
            }
        }
        startItemTextEdit(view, item.id);
    });
    row.appendChild(text);

    // 超长条目默认折叠：渲染高度超过 1 个视窗（memo-body 可视高度）时，先只显示一屏 + 渐隐，
    // 点「展开全文」看完整内容。展开状态按条目 id 记忆，重渲染不弹回。
    const body = view.root && view.root.querySelector('.memo-body');
    const viewportH = (body && body.clientHeight) || window.innerHeight || 600;
    if (shouldFoldMemoItem(item.text, viewportH)) {
        const foldKey = item.id;
        text.classList.add('memo-item-foldable');
        // 折叠高度比可视区略小，给浮在底部的「展开全文」按钮留出空间，避免按钮被挤出屏幕。
        text.style.setProperty('--memo-fold-h', Math.max(120, viewportH - 48) + 'px');
        text.classList.toggle('folded', !itemFoldExpanded.has(foldKey));
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'memo-item-fold-btn';
        const syncToggle = () => {
            const folded = text.classList.contains('folded');
            toggle.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style="transform:rotate(' + (folded ? '0' : '180') + 'deg)"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + (folded ? '展开全文' : '收起') + '</span>';
        };
        syncToggle();
        toggle.addEventListener('click', (e) => {
            e.stopPropagation(); // 别触发 text 的编辑
            const nowFolded = text.classList.contains('folded');
            if (nowFolded) itemFoldExpanded.add(foldKey);
            else itemFoldExpanded.delete(foldKey);
            text.classList.toggle('folded', !nowFolded);
            syncToggle();
        });
        row.appendChild(toggle);
    }

    if (item.images.length) {
        const thumbs = document.createElement('div');
        thumbs.className = 'memo-item-thumbs';
        item.images.forEach((rel) => thumbs.appendChild(buildThumb(view, item, rel)));
        row.appendChild(thumbs);
    }

    const actions = document.createElement('span');
    actions.className = 'memo-item-actions';
    actions.appendChild(actionButton('⋯', (x, y) => openItemMenu(view, item.id, x, y), '条目操作'));
    row.appendChild(actions);

    row.addEventListener('contextmenu', (e) => {
        // 便签文本正在行内编辑时放行原生菜单（撤销/剪切/复制/粘贴/全选原生可用）
        if (e.target.closest('.memo-inline-edit')) return;
        e.preventDefault();
        openItemMenu(view, item.id, e.clientX, e.clientY);
    });
    row.addEventListener('mousedown', () => { view.focusedItem = item.id; });
    return row;
}

function imageKey(scope, rel) { return scope + '|' + rel; }

function buildThumb(view, item, rel) {
    const box = document.createElement('span');
    box.className = 'memo-thumb';
    box.dataset.rel = rel;
    const img = document.createElement('img');
    img.alt = '贴图';
    img.addEventListener('click', () => openThumbLightbox(view, item, rel));
    box.appendChild(img);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'memo-thumb-del';
    del.setAttribute('data-tip', '移除贴图');
    del.textContent = '×';
    onButton(del, () => {
        commitActive(view);
        run(view, (doc) => removeImageById(doc, item.id, rel));
    });
    box.appendChild(del);
    // 贴图右键菜单：复制 / 另存为
    box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation(); // 别让条目菜单抢开
        openThumbMenu(view, item, rel, e.clientX, e.clientY);
    });

    const cached = imageDataUrls.get(imageKey(view.scope, rel));
    if (cached) {
        img.src = cached;
    } else {
        resolveImage(view, rel).then((url) => {
            if (!url || view.disposed) return;
            const found = view.root.querySelector('.memo-thumb[data-rel="' + cssEscape(rel) + '"] img');
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

function escapeHtml(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// renderTextWithImages 文本条目的轻量渲染：整段转义（原始 HTML 不执行）后，
// 把贴图占位符替换成内联 <img>（data-memo-img 标记，随后异步换 data URL）。换行交给 pre-wrap。
function renderTextWithImages(content) {
    return escapeHtml(content).replace(/!\[([^\]\n]*)\]\((img\/[^)\s]+)\)/g, (m, alt, rel) =>
        '<img class="memo-inline-img" alt="' + alt + '" data-memo-img="' + rel + '">');
}

// loadInlineImages 把容器里带标记的 <img> 异步换成 data URL（data URL 缓存共用）。
// attr：文本条目占位符用 data-memo-img；md 条目走共享渲染器的 data-ai-src（相对 img/ 路径）。
function loadInlineImages(view, scopeEl, attr) {
    scopeEl.querySelectorAll('img[' + attr + ']').forEach((img) => {
        const rel = img.getAttribute(attr) || '';
        if (!rel || rel.indexOf('img/') !== 0) return;
        resolveImage(view, rel).then((url) => {
            if (url) img.src = url;
        }).catch(() => {});
    });
}

// memoRootDir 作用域根目录（贴图绝对路径 = 根 + 相对引用）：
// 工作区 = <ws>/.cadt/memo；全局 = <应用数据>/memo（AIAppDir 绑定取应用数据根）。
async function memoRootDir(scope) {
    return memoRootDirFor(scope, deps.workspaceFolder || '');
}

// memoRootDirFor 用显式 workspace（贴图 GC 必须用缓存捕获的旧根，换过工作区才不会删错地方）。
async function memoRootDirFor(scope, workspace) {
    if (scope === 'workspace') {
        return workspace ? workspace.replace(/[\\/]+$/, '') + '/.cadt/memo' : '';
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
    btn.className = 'memo-btn';
    btn.textContent = label;
    return onButton(btn, onClick, tip);
}

// ===== 行内编辑 =====
function startBlockTitleEdit(view, blockId) {
    const doc = store.cached(view.scope);
    const block = doc && doc.blocks.find((b) => b.id === blockId);
    const head = view.root.querySelector('.memo-block[data-block-id="' + cssEscape(blockId) + '"] .memo-block-head');
    if (!block || !head) return;
    const titleEl = head.querySelector('.memo-block-title');
    if (!titleEl) return;
    startInlineEdit(view, titleEl, block.title, MEMO_LIMITS.blockTitleMax, (value) => {
        run(view, (doc2) => updateById(doc2, blockId, {text: value}));
    });
}

function startItemTextEdit(view, itemId) {
    const doc = store.cached(view.scope);
    const item = doc && findItemIn(doc, itemId);
    const textEl = view.root.querySelector('.memo-item[data-item-id="' + cssEscape(itemId) + '"] .memo-item-text');
    if (!item || !textEl) return;
    view.focusedItem = itemId;
    view.lastEditItem = itemId;
    startInlineEdit(view, textEl, item.text, MEMO_LIMITS.textMax, (value) => {
        run(view, (doc2) => {
            const target = findItemIn(doc2, itemId);
            // 新建行提交时仍为空：直接删掉，不留占位垃圾
            if (target && !target.text && !value.trim() && target.createdAt === target.updatedAt) {
                return removeById(doc2, itemId);
            }
            return updateById(doc2, itemId, {text: value});
        });
    }, {multiLine: true, alwaysCommit: true});
}

// startInlineEdit 把展示元素换成行内编辑。
// opts.multiLine：便签正文用多行 textarea——Enter 换行、Ctrl+Enter 提交、Esc 还原、blur 提交，
// 输入时自动撑高；块标题仍走单行 input（Enter/blur 提交）。
// opts.alwaysCommit：值未变也回调（新建空行靠它走「提交空则删行」的清理，不留占位垃圾）。
function startInlineEdit(view, displayEl, initial, maxLen, onCommit, opts) {
    if (displayEl.dataset.editing === '1') return;
    const options = opts || {};
    displayEl.dataset.editing = '1';
    const original = String(initial == null ? '' : initial);
    const editor = options.multiLine
        ? createTextarea({value: original, rows: 1})
        : createInput({value: original});
    editor.element.className = options.multiLine
        ? 'dlg-input memo-inline-edit memo-inline-area'
        : 'dlg-input memo-inline-edit';
    if (maxLen) editor.element.setAttribute('maxlength', String(maxLen));
    displayEl.textContent = '';
    displayEl.appendChild(editor.element);
    // 多行时随内容自动撑高：height 先归 auto 再取 scrollHeight（含边框 2px 补偿），
    // 限高交给 CSS max-height + overflow-y auto——超限时出现原生滚动条而不是静默裁切。
    // 输入事件的测量延迟到 rAF：同步读 scrollHeight 可能在布局生效前拿到旧值。
    const autogrow = () => {
        if (!options.multiLine) return;
        editor.element.style.height = 'auto';
        editor.element.style.height = (editor.element.scrollHeight + 2) + 'px';
    };
    const scheduleGrow = () => {
        if (!options.multiLine) return;
        requestAnimationFrame(autogrow);
    };
    editor.element.focus();
    if (options.multiLine) {
        // 便签正文编辑：光标落末尾接着写，不整段选中（标题编辑才全选，方便整体替换）
        const end = editor.element.value.length;
        editor.element.setSelectionRange(end, end);
    } else {
        editor.element.select();
    }
    scheduleGrow();
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        view.activeCommit = null;
        const value = editor.control.value;
        displayEl.dataset.editing = '';
        if (commit && (options.alwaysCommit || value !== original)) onCommit(value);
        render(view); // 回到数据态展示；变更通路里的广播渲染与之幂等
    };
    editor.element.addEventListener('input', scheduleGrow);
    editor.element.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
            return;
        }
        if (e.key === 'Enter' && (options.multiLine ? (e.ctrlKey || e.metaKey) : !e.shiftKey)) {
            // 单行：Enter 提交；多行：Enter 换行（默认行为）、Ctrl+Enter 提交
            e.preventDefault();
            e.stopPropagation();
            finish(true);
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
        const label = item.text || '贴图';
        const short = label.length > 24 ? label.slice(0, 24) + '…' : label;
        lightbox.open(null, url, short + ' · ' + rel.split('/').pop());
    }).catch((e) => deps.flash('贴图读取失败：' + ((e && e.message) || e), true));
}

// openThumbMenu 贴图右键：复制到系统剪贴板 / 另存为（SaveFileDialog + SaveDataURL）。
function openThumbMenu(view, item, rel, x, y) {
    deps.ctxMenu.open([
        {label: '复制图片', icon: 'E8C8', action: async () => {
            const url = await resolveImage(view, rel);
            if (!url) { deps.flash('贴图读取失败：' + rel, true); return; }
            const ok = await copyImageUrlToClipboard(url);
            if (ok) deps.flash('已复制图片到剪贴板');
            else deps.flash('复制失败：当前环境不支持写图片剪贴板', true);
        }},
        {label: '另存为…', icon: 'E74E', action: async () => {
            const url = await resolveImage(view, rel);
            if (!url) { deps.flash('贴图读取失败：' + rel, true); return; }
            if (!deps.backend.SaveFileDialog) { deps.flash('当前环境不支持保存对话框', true); return; }
            let path = '';
            try {
                path = await deps.backend.SaveFileDialog(rel.split('/').pop() || '贴图.png');
            } catch (e) {
                return; // 用户取消对话框时 Wails 会 reject，静默退出
            }
            if (!path) return; // 用户取消
            try {
                await deps.backend.SaveDataURL(path, url);
                deps.flash('已保存：' + path);
            } catch (e) {
                deps.flash('保存失败：' + ((e && e.message) || e), true);
            }
        }},
    ], x, y);
}

// ===== 菜单 =====
function openBlockMenu(view, blockId, x, y) {
    const doc = store.cached(view.scope);
    const block = doc && doc.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const idx = doc.blocks.findIndex((b) => b.id === blockId);
    deps.ctxMenu.open([
        {label: '添加条目', icon: 'E710', action: () => appendEditableItem(view, blockId)},
        {label: '重命名', icon: 'E8AC', action: () => startBlockTitleEdit(view, blockId)},
        {label: '复制定位点', icon: 'E8C8', title: '复制给 AI / CLI 的定位串', action: () =>
            deps.copyText(memoLocator(view.scope, 'block', blockId), '定位点')},
        {label: block.collapsed ? '展开' : '折叠', icon: block.collapsed ? 'E70D' : 'E70E', action: () => {
            run(view, (doc2) => updateById(doc2, blockId, {collapsed: !block.collapsed}));
        }},
        {sep: true},
        {label: '上移', icon: 'E70E', disabled: idx <= 0, action: () => {
            run(view, (doc2) => updateById(doc2, blockId, {index: idx - 1}));
        }},
        {label: '下移', icon: 'E70D', disabled: idx < 0 || idx >= doc.blocks.length - 1, action: () => {
            // moveInArray 是先 splice(from,1) 再 splice(to,0)：下移一格的目标位置就是 idx+1
            run(view, (doc2) => updateById(doc2, blockId, {index: idx + 1}));
        }},
        {sep: true},
        {label: '删除块', icon: 'E74D', action: () => {
            // 块删除连带全部条目：居中确认框（danger 红色按钮）
            deps.openConfirmDialog(
                '删除块「' + block.title + '」？将连带删除其中 ' + block.items.length + ' 条条目，不可恢复。',
                () => run(view, (doc2) => removeById(doc2, blockId)).then((res) => {
                    if (!res.ok) deps.flash(res.error, true);
                }),
                '删除', '删除块', 'danger');
        }},
    ], x, y);
}

function openItemMenu(view, itemId, x, y) {
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
        {label: '编辑', icon: 'E8AC', action: () => startItemTextEdit(view, itemId)},
        {label: '粘贴图片', icon: 'E77F', action: () => pasteImageInto(view, itemId)},
        {label: '复制定位点', icon: 'E8C8', title: '复制给 AI / CLI 的定位串', action: () =>
            deps.copyText(memoLocator(view.scope, 'item', itemId), '定位点')},
        {sep: true},
        {label: '上移', icon: 'E70E', disabled: idx <= 0, action: () => {
            run(view, (doc2) => updateById(doc2, itemId, {index: idx - 1}));
        }},
        {label: '下移', icon: 'E70D', disabled: idx < 0 || idx >= hostBlock.items.length - 1, action: () => {
            // 同块下移：moveInArray 语义是「移除后再插到该位置」，目标即 idx+1
            run(view, (doc2) => updateById(doc2, itemId, {index: idx + 1}));
        }},
        {label: '移到其他块…', icon: 'E8B7', disabled: !otherBlocks.length, action: () => {
            deps.ctxMenu.open(otherBlocks.map((b) => ({
                label: b.title,
                action: () => run(view, (doc2) => moveItemToBlock(doc2, itemId, b.id)).then((res) => {
                    if (!res.ok) deps.flash(res.error, true);
                }),
            })), x, y);
        }},
        {sep: true},
        {label: '删除条目', icon: 'E74D', action: () => {
            // 居中确认框：文案带条目内容摘要（长文本截断）
            const snippet = item.text
                ? (item.text.length > 30 ? item.text.slice(0, 30) + '…' : item.text)
                : '（空）';
            deps.openConfirmDialog('删除条目「' + snippet + '」？', () => {
                run(view, (doc2) => removeById(doc2, itemId)).then((res) => {
                    if (!res.ok) deps.flash(res.error, true);
                });
            }, '删除', '删除条目', 'danger');
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
    // 正在编辑的正文里粘贴：占位符插到光标处（图片位置记录在正文流里，渲染/导出按它走）；
    // 非编辑态粘贴：挂到目标条目的缩略图（原行为）。
    const editor = e.target.closest('textarea.memo-inline-edit');
    if (editor) {
        for (const file of files) await insertInlinePlaceholder(view, editor, file);
        return;
    }
    for (const file of files) await attachImageFile(view, resolveFocusedItemId(view), file);
}

// insertInlinePlaceholder 贴图落盘后在光标处插入 Markdown 占位符，光标停在占位符之后。
async function insertInlinePlaceholder(view, editor, file) {
    let payload;
    try {
        payload = await deps.prepareImagePayload(file, {name: file.name || '粘贴的图片'});
    } catch (err) {
        deps.flash('图片读取失败：' + ((err && err.message) || err), true);
        return;
    }
    if (!payload) { deps.flash('图片读取失败', true); return; }
    let rel;
    try {
        rel = await store.saveImage(view.scope, payloadToDataUrl(payload));
    } catch (err) {
        deps.flash('贴图保存失败：' + ((err && err.message) || err), true);
        return;
    }
    const ph = '![' + rel.split('/').pop() + '](' + rel + ')';
    const start = editor.selectionStart == null ? editor.value.length : editor.selectionStart;
    const end = editor.selectionEnd == null ? start : editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + ph + editor.value.slice(end);
    const caret = start + ph.length;
    editor.setSelectionRange(caret, caret);
    editor.dispatchEvent(new Event('input')); // 触发 autogrow
    editor.focus();
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

// ===== 导出 =====
function parentDirOf(p) {
    return String(p).replace(/[\\/][^\\/]+$/, '');
}

function baseNameOf(p) {
    return String(p).split(/[\\/]/).pop() || p;
}

async function saveTextFile(path, content) {
    await deps.backend.SaveFileChecked(path, content, '\n', false, 'utf-8', '');
}

// exportMemo 导出当前作用域：先冲盘保证数据最新，再按格式走 md / html 流程。
async function exportMemo(view, format) {
    commitActive(view);
    await store.flush(view.scope).catch(() => {}); // 尽力冲盘：导出的就是已落盘内容
    const doc = store.cached(view.scope);
    if (!doc || !doc.blocks.length) { deps.flash('当前便签是空的，没有可导出的内容', true); return; }
    if (!deps.backend.SaveFileDialog || !deps.backend.SaveFileChecked) { deps.flash('当前环境不支持保存文件', true); return; }
    const scopeLabel = view.scope === 'global' ? '全局' : '工作区';
    let path = '';
    try {
        path = await deps.backend.SaveFileDialog('便签-' + scopeLabel + '.' + format);
    } catch (e) {
        return; // 用户取消对话框时 Wails 会 reject，静默退出
    }
    if (!path) return; // 用户取消
    if (format === 'md') await exportMemoMarkdownFile(view, doc, scopeLabel, path);
    else if (format === 'doc') await exportMemoWordFile(view, doc, scopeLabel, path);
    else if (format === 'docx') await exportMemoDocxFile(view, doc, scopeLabel, path);
    else await exportMemoHtmlFile(view, doc, scopeLabel, path);
}

// exportMemoMarkdownFile 导出 .md 并把引用的贴图复制到 <导出目录>/img/（相对引用直接可用）。
async function exportMemoMarkdownFile(view, doc, scopeLabel, path) {
    const out = exportMemoMarkdown(doc, scopeLabel);
    await saveTextFile(path, out.content);
    if (out.images.length && deps.backend.CopyFileTo) {
        const rootDir = await memoRootDirFor(view.scope, store.rootFor(view.scope));
        if (rootDir) {
            const imgDir = parentDirOf(path) + '/img';
            try { await deps.backend.AIEnsureDir(imgDir); } catch (e) { /* 目录已存在等情况忽略 */ }
            for (const rel of out.images) {
                const src = rootDir.replace(/[\\/]+$/, '') + '/' + rel.replace(/[\\/]+/g, '/');
                try {
                    await deps.backend.CopyFileTo(src, imgDir + '/' + baseNameOf(rel));
                } catch (e) {
                    // 尽力而为：单张失败不阻断导出，正文引用仍在
                }
            }
        }
    }
    deps.flash('已导出 Markdown：' + path);
}

// buildMemoHtml 便签 → 完整 HTML 文档。urls 传 Map（rel→dataURL）= 单文件内嵌形态；
// 传 null = 相对引用形态（img/xxx.png 原样保留，供 doc 转换器写旁侧文件后使用）。
function buildMemoHtml(doc, scopeLabel, urls) {
    const src = (rel) => (urls && urls.has(rel)) ? urls.get(rel) : rel;
    const sections = doc.blocks.map((block, bi) => {
        const parts = ['<section><h2>' + escapeHtml((bi + 1) + '. ' + block.title) + '</h2>'];
        const list = [];
        for (const item of block.items) {
            if (item.kind === 'md') continue;
            // 字面勾选符 + 内联着色：Word 的 HTML 导入不理会 ::before/类选择器，.doc 靠它显示勾选态
            const mark = item.status === 'completed'
                ? '<span class="mark" style="color:#2e7d32;font-weight:bold">☑</span>'
                : item.status === 'in_progress'
                    ? '<span class="mark" style="color:#bf6a02;font-weight:bold">◐</span>'
                    : '<span class="mark" style="color:#aab2bd">☐</span>';
            let body = escapeHtml(item.text || '').replace(/!\[([^\]\n]*)\]\((img\/[^)\s]+)\)/g, (m, alt, rel) =>
                (!urls || urls.has(rel)) ? '<img alt="' + alt + '" src="' + src(rel) + '">' : '');
            for (const rel of item.images) {
                if ((urls && !urls.has(rel)) || body.indexOf('"' + src(rel) + '"') >= 0) continue;
                body += '<img alt="贴图" src="' + src(rel) + '">';
            }
            const strike = item.status === 'completed'
                ? ' style="color:#999;text-decoration:line-through"'
                : '';
            list.push('<li class="' + cls + '"><span' + strike + '>' + (mark + ' ' + (body || '&nbsp;')) + '</span></li>');
        }
        if (list.length) parts.push('<ul>' + list.join('') + '</ul>');
        for (const item of block.items) {
            if (item.kind !== 'md' || !item.text) continue;
            parts.push('<div class="md">' + injectMd(item.text) + '</div>');
        }
        parts.push('</section>');
        return parts.join('\n');
    });
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
        '<title>快捷便签 · ' + escapeHtml(scopeLabel) + '</title>\n<style>\n' +
        'body{font:14px/1.75 "Segoe UI","Microsoft YaHei",-apple-system,sans-serif;max-width:860px;margin:28px auto;padding:0 20px;color:#333;background:#fff}\n' +
        'h1{font-size:22px;color:#1f3864;border-bottom:2px solid #2b579a;padding-bottom:10px;margin:0 0 6px}\n' +
        '.meta{color:#8a8a8a;font-size:12px;margin:0 0 18px}\n' +
        'section{background:#fff;border:1px solid #e3e8f0;border-radius:10px;padding:14px 18px;margin:16px 0;box-shadow:0 1px 3px rgba(16,32,64,.06)}\n' +
        'h2{font-size:16px;color:#2b579a;border-bottom:1px solid #e3e8f0;padding-bottom:6px;margin:4px 0 12px}\n' +
        'ul{list-style:none;padding-left:6px;margin:0}\n' +
        'li{padding:5px 2px;white-space:pre-wrap;word-break:break-word}\n' +
        'li .mark{font-weight:bold;margin-right:4px}\n' +
        'li.done span{color:#999;text-decoration:line-through}\n' +
        'img{max-width:320px;max-height:220px;border-radius:6px;border:1px solid #dde3ec;vertical-align:middle;margin:4px 6px 2px 0}\n' +
        '.md{padding:2px 0}\n' +
        '.md h1,.md h2,.md h3{color:#2b579a}\n' +
        '.md pre{background:#f6f8fa;border:1px solid #e3e8f0;padding:8px 10px;border-radius:6px;overflow:auto}\n' +
        '.md code{background:#f6f8fa;padding:1px 4px;border-radius:3px}\n' +
        '.md blockquote{border-left:3px solid #2b579a;margin:6px 0;padding:2px 10px;color:#555}\n' +
        '.md table{border-collapse:collapse}\n' +
        '.md th,.md td{border:1px solid #dde3ec;padding:4px 8px}\n' +
        '</style>\n</head>\n<body>\n' +
        '<h1>快捷便签 · ' + escapeHtml(scopeLabel) + '</h1>\n' +
        '<p class="meta">导出时间：' + escapeHtml(new Date().toLocaleString()) + '</p>\n' +
        sections.join('\n') + '\n</body>\n</html>\n';

    function injectMd(text) {
        let html = deps.renderMarkdownHtml(text, {});
        if (urls) {
            for (const [rel, url] of urls) html = html.split('"' + rel + '"').join('"' + url + '"');
        }
        return html;
    }
}

// exportMemoWordFile 内置 Word（.doc）导出：Word 兼容 HTML（相对引用形态）存 .doc +
// 贴图复制到文档旁侧 img/（Word 的 HTML 导入对 data URI 支持不稳）。零依赖，
// 与 md 导出共用同一套旁侧图复制流程；重格式（真 .docx）见市场插件 export-word。
async function exportMemoWordFile(view, doc, scopeLabel, path) {
    await saveTextFile(path, buildMemoHtml(doc, scopeLabel, null));
    if (deps.backend.CopyFileTo) {
        const rootDir = await memoRootDirFor(view.scope, store.rootFor(view.scope));
        if (rootDir) {
            const imgDir = parentDirOf(path) + '/img';
            try { await deps.backend.AIEnsureDir(imgDir); } catch (e) { /* 目录已存在等情况忽略 */ }
            for (const rel of collectImageRefs(doc)) {
                const src = rootDir.replace(/[\\/]+$/, '') + '/' + rel.replace(/[\\/]+/g, '/');
                try {
                    await deps.backend.CopyFileTo(src, imgDir + '/' + baseNameOf(rel));
                } catch (e) {
                    // 尽力而为：单张失败不阻断导出，正文引用仍在
                }
            }
        }
    }
    deps.flash('已导出 Word(.doc)：' + path);
}

// exportMemoDocxFile 内置 Word 原生 .docx 导出（memo-docx.js：OOXML 直排 + store-mode
// ZIP，零第三方依赖）。图片内嵌 data URL；重格式如 PDF 走市场插件（registerDocConverter）。
async function exportMemoDocxFile(view, doc, scopeLabel, path) {
    const images = [];
    for (const rel of collectImageRefs(doc)) {
        const url = await resolveImage(view, rel).catch(() => '');
        const at = url.indexOf('base64,');
        if (!url || at < 0) continue;
        images.push({
            name: rel.split('/').pop() || rel,
            mime: url.slice(5, url.indexOf(';')) || 'image/png',
            base64: url.slice(at + 7),
        });
    }
    const base64 = memoDocxBase64(buildMemoHtml(doc, scopeLabel, null), images);
    try {
        await deps.backend.SaveDataURL(path, 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + base64);
    } catch (e) {
        deps.flash('导出失败：' + ((e && e.message) || e), true);
        return;
    }
    deps.flash('已导出 Word(.docx)：' + path);
}

// exportMemoHtmlFile 单文件 HTML：图片全部内嵌为 data URL，无外部依赖可直接分发。
async function exportMemoHtmlFile(view, doc, scopeLabel, path) {
    const urls = new Map();
    for (const rel of collectImageRefs(doc)) {
        const url = await resolveImage(view, rel).catch(() => '');
        if (url) urls.set(rel, url);
    }
    await saveTextFile(path, buildMemoHtml(doc, scopeLabel, urls));
    deps.flash('已导出 HTML：' + path);
}

// runDocConverter 组装导出上下文并调用插件注册的文档转换器（cadt.registerDocConverter）。
// html 用相对引用形态（img/…，转换器写完旁侧图片文件即可用），images 字节就绪一并给出；
// 插件失败不影响核心导出；用户取消对话框由插件自行退出。
async function runDocConverter(view, converter) {
    commitActive(view);
    await store.flush(view.scope).catch(() => {});
    const doc = store.cached(view.scope);
    if (!doc) { deps.flash('当前便签未加载', true); return; }
    const scopeLabel = view.scope === 'global' ? '全局' : '工作区';
    const suggestedName = '便签-' + scopeLabel;
    const images = [];
    for (const rel of collectImageRefs(doc)) {
        const url = await resolveImage(view, rel).catch(() => '');
        const at = url.indexOf('base64,');
        if (!url || at < 0) continue;
        images.push({
            name: rel.split('/').pop() || rel,
            mime: url.slice(5, url.indexOf(';')) || 'image/png',
            base64: url.slice(at + 7),
        });
    }
    const ctx = {
        source: 'memo',
        title: '快捷便签 · ' + scopeLabel,
        suggestedName,
        html: buildMemoHtml(doc, scopeLabel, null),
        images,
        chooseSavePath: async (defaultName) => {
            if (!deps.backend.SaveFileDialog) throw new Error('当前环境不支持保存对话框');
            const p = await deps.backend.SaveFileDialog(String(defaultName || ''));
            return p || '';
        },
        writeTextFile: async (p, content) => {
            await deps.backend.SaveFileChecked(p, String(content == null ? '' : content), '\n', false, 'utf-8', '');
        },
        writeBinaryFile: async (p, base64, mime) => {
            await deps.backend.SaveDataURL(p, 'data:' + (mime || 'application/octet-stream') + ';base64,' + String(base64 || ''));
        },
        flash: (message, isErr) => deps.flash(String(message == null ? '' : message), !!isErr),
    };
    try {
        await converter.convert(ctx);
    } catch (e) {
        deps.flash('插件导出失败：' + ((e && e.message) || e), true);
    }
}

// ===== 对外 API（main.js 转发给 AI 面板 / 活动栏 / 工作区切换）=====

function countsText(doc) {
    const t = totalsOfDoc(doc);
    return t.items
        ? ('当前：' + t.done + '/' + t.items + ' 完成' + (t.doing ? '，' + t.doing + ' 项进行中' : '') + '。')
        : '当前：还没有条目。';
}

// memoLocator 定位点：cadt-memo://<scope>/<block|item>/<id>。
// 三个消费方共用同一格式：AI（粘贴给模型，按 get_memo 清单按 id 定位）、
// CLI（CaDt-DataLens.exe --memo "cadt-memo://…"）、面板内快捷跳转。
function memoLocator(scope, kind, id) {
    return 'cadt-memo://' + scope + '/' + kind + '/' + id;
}

// jumpToLocator 解析定位点并跳转：开面板/切作用域/必要时展开折叠块/滚动+高亮。
// 返回给调用方的串仅用于调试；UI/CLI 路径不依赖返回值。
async function jumpToLocator(locator) {
    const m = /^cadt-memo:\/\/(workspace|global)\/(block|item)\/([A-Za-z0-9-]+)\s*$/.exec(String(locator || '').trim());
    if (!m) {
        deps.flash('无法识别的便签定位点：' + String(locator || ''), true);
        return '无法识别的定位点';
    }
    const scope = m[1], kind = m[2], id = m[3];
    openMemoTab();
    const view = findOpenView();
    if (!view || view.disposed) return '面板不可用';
    if (view.scope !== scope) {
        await store.flush(view.scope).catch(() => {});
        await store.releaseLease(view.scope).catch(() => {});
        view.scope = scope;
        setCurrentScope(scope);
    }
    const res = await store.load(scope, {acquire: true});
    if (res.error) { deps.flash('便签加载失败：' + res.error, true); return '加载失败'; }
    render(view);

    let el = null;
    if (kind === 'block') {
        const block = res.doc.blocks.find((b) => b.id === id);
        if (!block) { deps.flash('定位点指向的块不存在（可能已被删除）', true); return '块不存在'; }
        if (block.collapsed) {
            const r = await run(view, (d) => updateById(d, id, {collapsed: false}));
            if (!r.ok) deps.flash(r.error, true);
        }
        el = view.root.querySelector('.memo-block[data-block-id="' + cssEscape(id) + '"]');
    } else {
        const item = findItemIn(res.doc, id);
        if (!item) { deps.flash('定位点指向的条目不存在（可能已被删除）', true); return '条目不存在'; }
        const host = res.doc.blocks.find((b) => b.items.includes(item));
        if (host && host.collapsed) {
            const r = await run(view, (d) => updateById(d, host.id, {collapsed: false}));
            if (!r.ok) deps.flash(r.error, true);
        }
        el = view.root.querySelector('.memo-item[data-item-id="' + cssEscape(id) + '"]');
    }
    if (!el) return '定位失败';
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    el.classList.remove('memo-jump-flash');
    void el.offsetWidth; // 重启动画
    el.classList.add('memo-jump-flash');
    setTimeout(() => el.classList.remove('memo-jump-flash'), 1500);
    return '已定位';
}

// openJumpMenu 快捷跳转菜单：按文档顺序平铺块（点击跳到块）与块内条目（缩进，点击跳到条目）。
// 条目在折叠块里也能跳：跳转前先展开该块。
function openJumpMenu(view, x, y) {
    const doc = store.cached(view.scope);
    if (!doc || !doc.blocks.length) { deps.flash('当前便签还没有内容'); return; }
    const items = [];
    doc.blocks.forEach((block, bi) => {
        items.push({
            label: (bi + 1) + '. ' + block.title + '（分组，' + block.items.length + ' 项）',
            icon: block.collapsed ? 'E70D' : 'E70E',
            action: () => jumpToBlock(view, block.id),
        });
        if (!block.collapsed) {
            block.items.forEach((item) => {
                const snippet = item.text
                    ? (item.text.length > 26 ? item.text.slice(0, 26) + '…' : item.text)
                    : '（空）';
                items.push({
                    label: '　' + snippet,
                    action: () => jumpToItem(view, item.id),
                });
            });
        }
    });
    deps.ctxMenu.open(items, x, y);
}

// jumpToBlock / jumpToItem：展开（若折叠）→ 重渲染 → 滚动 + 高亮。locate 由 jumpToLocator 复用。
async function jumpToBlock(view, blockId) {
    commitActive(view);
    const doc = store.cached(view.scope);
    const block = doc && doc.blocks.find((b) => b.id === blockId);
    if (block && block.collapsed) {
        const r = await run(view, (d) => updateById(d, blockId, {collapsed: false}));
        if (!r.ok) deps.flash(r.error, true);
    }
    jumpFlash(view, '.memo-block[data-block-id="' + cssEscape(blockId) + '"]');
}

async function jumpToItem(view, itemId) {
    commitActive(view);
    const doc = store.cached(view.scope);
    const found = doc && (function() {
        for (const block of doc.blocks) {
            const i = block.items.findIndex((it) => it.id === itemId);
            if (i >= 0) return {block, item: block.items[i]};
        }
        return null;
    })();
    if (!found) { deps.flash('条目不存在', true); return; }
    if (found.block.collapsed) {
        const r = await run(view, (d) => updateById(d, found.block.id, {collapsed: false}));
        if (!r.ok) { deps.flash(r.error, true); return; }
    }
    jumpFlash(view, '.memo-item[data-item-id="' + cssEscape(itemId) + '"]');
}

// jumpFlash 滚动到元素并闪一段定位高亮
function jumpFlash(view, selector) {
    requestAnimationFrame(() => {
        const el = view.root.querySelector(selector);
        if (!el) return;
        el.scrollIntoView({behavior: 'smooth', block: 'center'});
        el.classList.remove('memo-jump-flash');
        void el.offsetWidth; // 重启动画
        el.classList.add('memo-jump-flash');
        setTimeout(() => el.classList.remove('memo-jump-flash'), 1500);
    });
}

// memoApi：AI 工具（memo 动作）的执行通道。改完即防抖保存并广播刷新。
const memoApi = {
    normalizeScope(scope) { return scope === 'global' ? 'global' : 'workspace'; },
    // list(scope, filter)：filter {blockId?, status?, q?} 可选——按分组/状态/文本过滤，
    // 首行仍汇报全局面板计数。status 非法直接报错（模型会修正重试）。
    async list(scope, filter) {
        const s = this.normalizeScope(scope);
        const f = filter && typeof filter === 'object' ? filter : {};
        if (f.status != null && ['pending', 'in_progress', 'completed'].indexOf(f.status) < 0) {
            throw new Error('status 过滤只支持 pending / in_progress / completed');
        }
        if (f.blockId != null && typeof f.blockId === 'string') f.blockId = f.blockId.trim();
        const res = await store.load(s);
        if (res.error) throw new Error(res.error);
        return formatMemoForAI(res.doc, s === 'global' ? '全局快捷便签' : '工作区快捷便签', f);
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
    // jumpToLocator：CLI --memo 与 app-open-memo 事件的跳转入口（返回状态串仅调试用）
    jumpToLocator,
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
    if (hit) {
        const view = findOpenView();
        if (view && view.scope === 'workspace' && store.state('workspace').readOnly) {
            store.retryAcquire('workspace').then((res) => {
                if (res && res.ok) {
                    if (view && !view.disposed) render(view);
                    return;
                }
                // 仍被占：作为只读副本把另一窗口刚写的内容读回来
                return store.reloadExternal('workspace').then(() => {
                    if (view && !view.disposed) render(view);
                });
            }).catch(() => {});
            return;
        }
        store.reloadExternal('workspace').catch(() => {});
    }
}

// memoOnWindowFocus：窗口拿回焦点时对账；全局作用域没有文件 watch，只读态顺带重试接管。
function memoOnWindowFocus() {
    const view = findOpenView();
    if (!view) return;
    if (store.state(view.scope).readOnly) {
        store.retryAcquire(view.scope).then((res) => {
            if (res && res.ok) {
                if (!view.disposed) render(view);
                return;
            }
            return store.reloadExternal(view.scope).then(() => {
                if (!view.disposed) render(view);
            });
        }).catch(() => {});
        return;
    }
    if (view.scope === 'global') store.reloadExternal('global').catch(() => {});
}

// memoOnResourceEvent：Go 侧资源目录 watch（目前只对全局便签注册）。
function memoOnResourceEvent(payload) {
    if (!payload || payload.kind !== 'memo') return;
    const view = findOpenView();
    if (!view || view.disposed) return;
    if (view.scope !== 'global' || payload.key !== 'global') return;
    if (store.state('global').readOnly) {
        store.retryAcquire('global').then((res) => {
            if (res && res.ok) {
                if (!view.disposed) render(view);
                return;
            }
            return store.reloadExternal('global').then(() => {
                if (!view.disposed) render(view);
            });
        }).catch(() => {});
        return;
    }
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
    memoOnResourceEvent,
    memoWorkspaceChanged,
};
}
