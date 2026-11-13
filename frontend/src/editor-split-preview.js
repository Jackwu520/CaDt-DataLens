// editor-split-preview.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// 分屏与预览视图族：Markdown 预览 + 分屏双向滚动同步、HTML 预览、SVG 渲染、
// 图片/二进制/纯文本视图，及各 enter/show/hide/leave 分发器。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集，另接
// applyAceMode / updateStatus / showBanner / syncTabViewTools /
// patchMarkdownPreview / renderMarkdownBlocksHtml 的转发箭头。
export function createEditorSplitPreview(deps) {

function createMarkdownPreview(doc) {
    if (doc.previewEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-preview-view';
    const scroll = document.createElement('div');
    scroll.className = 'md-preview-scroll';
    const body = document.createElement('div');
    body.className = 'md-preview';
    scroll.appendChild(body);
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.previewEl = wrap;
    doc.previewScroll = scroll;
    doc.previewBody = body;
    wrap.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#')) return;
        e.preventDefault();
        if (!/^(https?:|mailto:)/i.test(href)) return;
        if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(href);
        else window.open(href, '_blank', 'noopener');
    });
}

function renderMarkdownPreview(doc, opts = {}) {
    if (!doc || !doc.editor || !doc.previewBody) return;
    const scrollTop = doc.previewScroll ? doc.previewScroll.scrollTop : 0;
    try {
        const patched = !!(opts.incremental && patchMarkdownPreview(doc));
        if (!patched) doc.previewBody.innerHTML = renderMarkdownBlocksHtml(doc.editor.getText());
        deps.resolveMarkdownImages(doc);
    } catch (e) {
        doc.previewBody.textContent = 'Markdown 渲染失败：' + e.message;
    }
    if (doc.previewScroll) doc.previewScroll.scrollTop = scrollTop;
    mdSyncScrollFromAce(doc);
    deps.renderMermaidBlocks(doc.previewBody);
}

function showMarkdownPreview(doc) {
    if (!doc || !doc.format.preview) return;
    createMarkdownPreview(doc);
    if (doc.pane) doc.pane.classList.add('preview-active');
    renderMarkdownPreview(doc);
}

function hideMarkdownPreview(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('preview-active');
    if (doc === deps.file && doc.editor && doc.editor.aceEditor) {
        try {
            doc.editor.aceEditor.resize();
        } catch (e) {}
    }
}

function enterMarkdownPreview(doc) {
    if (!doc || !doc.format.preview || !doc.editor) return;
    if (doc.large) {
        deps.flash('大文件不支持 Markdown 预览', true);
        return;
    }
    const text = doc.editor.getText();
    doc.loading = true;
    try {
        doc.editor.setMode('code');
        doc.editor.setText(text);
        doc.text = text;
        if (!doc.dirty && doc.bases.preview == null) doc.bases.preview = text;
        doc.mode = 'preview';
        deps.currentMode = 'preview';
        showMarkdownPreview(doc);
        deps.updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换预览失败：' + e.message, true);
    } finally {
        doc.loading = false;
    }
}

function leaveMarkdownPreview(doc, mode) {
    if (!doc || !doc.editor) return;
    hideMarkdownPreview(doc);
    doc.mode = mode;
    deps.currentMode = mode;
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode(mode);
    } catch (e) {
        deps.flash('切换视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    // 预览底层编辑器本来就是 code 模式，setMode('code') 不会触发 onModeChange，
    // 必须显式应用 Markdown 等语法模式（否则残留 jsoneditor 默认 JSON 模式）
    if (doc === deps.file && mode === 'code') deps.applyAceMode(true);
    deps.updateStatus();
    deps.updateSearchState();
}

// ---- 单标签页分屏：左源码 / 右预览 ----

function splitRatioFor(doc) {
    const r = Number(doc && doc.splitRatio != null ? doc.splitRatio : deps.settings.splitRatio);
    return Number.isFinite(r) ? Math.min(0.85, Math.max(0.15, r)) : 0.5;
}

function ensureSplitDivider(doc) {
    if (doc.splitDivider || !doc.pane) return;
    const bar = document.createElement('div');
    bar.className = 'vp-split-divider';
    bar.title = '拖动调整左右宽度';
    doc.pane.appendChild(bar);
    bar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !doc.pane) return;
        const rect = doc.pane.getBoundingClientRect();
        if (rect.width < 40) return;
        const startX = e.clientX;
        const startRatio = splitRatioFor(doc);
        deps.setDragCursor('ew');
        document.body.style.userSelect = 'none';
        const move = (ev) => {
            const ratio = Math.min(0.85, Math.max(0.15, startRatio + (ev.clientX - startX) / rect.width));
            doc.splitRatio = ratio;
            doc.pane.style.setProperty('--split-ratio', String(ratio));
            if (!doc._splitResizePending) {
                doc._splitResizePending = true;
                requestAnimationFrame(() => {
                    doc._splitResizePending = false;
                    if (doc.editor && doc.editor.aceEditor) {
                        try { doc.editor.aceEditor.resize(); } catch (err) {}
                    }
                });
            }
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            deps.setDragCursor(null);
            document.body.style.userSelect = '';
            deps.settings.splitRatio = doc.splitRatio;
            try { localStorage.setItem(deps.settingsKey, JSON.stringify(deps.settings)); } catch (err) {}
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });
    doc.splitDivider = bar;
}

// ---- Markdown 分屏滚动同步：左源码滚动 → 右预览按比例跟随（单向，不回环） ----

function mdSyncScrollFromAce(doc) {
    if (!doc || !doc.splitActive || doc.splitKind !== 'markdown') return;
    if (deps.settings.mdScrollSync === false) return;
    const scroll = doc.previewScroll;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!scroll || !ace) return;
    let ratio = 0;
    try {
        // 比例统一用屏幕坐标系（像素同源）：文档行经 documentToScreenRow 转换，
        // 否则开启自动换行时与反向（预览→源码按像素驱动）的坐标系不一致
        const firstDoc = ace.getFirstVisibleRow();
        const first = ace.session.documentToScreenRow(firstDoc, 0);
        const last = ace.session.documentToScreenRow(ace.getLastVisibleRow(), 0);
        const visRows = Math.max(1, last - first + 1);
        const denom = ace.session.getScreenLength() - visRows;
        ratio = denom > 0 ? Math.min(1, Math.max(0, first / denom)) : 0;
    } catch (e) {
        return;
    }
    const max = scroll.scrollHeight - scroll.clientHeight;
    if (max <= 0) return;
    doc._previewEcho = Math.round(ratio * max);
    scroll.scrollTop = doc._previewEcho;
}

// 反方向：预览滚动 → 源码跟随。该内核 session.setScrollTop 收像素
// （scrollToLine 内部就是 getPixelPosition(row).top 直接喂给 setScrollTop）。
function mdSyncScrollFromPreview(doc) {
    if (!doc || !doc.splitActive || doc.splitKind !== 'markdown') return;
    if (deps.settings.mdScrollSync === false) return;
    const scroll = doc.previewScroll;
    const ace = doc.editor && doc.editor.aceEditor;
    if (!scroll || !ace) return;
    const denom = scroll.scrollHeight - scroll.clientHeight;
    if (denom <= 0) return;
    const ratio = Math.min(1, Math.max(0, scroll.scrollTop / denom));
    try {
        const lineHeight = ace.renderer.lineHeight || 16;
        const scroller = ace.renderer.scroller || ace.container;
        const maxPx = Math.max(0, ace.session.getScreenLength() * lineHeight - scroller.clientHeight);
        if (maxPx <= 0) return;
        doc._aceEcho = Math.round(ratio * maxPx);
        ace.session.setScrollTop(doc._aceEcho);
    } catch (e) {}
}

// hookPreviewScrollSync 监听预览滚动做反向同步；自激事件（左源码写入引起）值与
// _previewEcho 相同，直接忽略，防止两侧互相追逐。
function hookPreviewScrollSync(doc) {
    const scroll = doc && doc.previewScroll;
    if (!scroll || doc._splitPreviewHooked === scroll) return;
    doc._splitPreviewHooked = scroll;
    const onScroll = () => {
        if (!doc.splitActive || doc.splitKind !== 'markdown') return;
        if (deps.settings.mdScrollSync === false) return;
        if (Math.round(scroll.scrollTop) === doc._previewEcho) return;
        mdSyncScrollFromPreview(doc);
    };
    scroll.addEventListener('scroll', onScroll);
    doc._splitPreviewDetach = () => {
        scroll.removeEventListener('scroll', onScroll);
        doc._splitPreviewHooked = null;
        doc._splitPreviewDetach = null;
    };
}

// hookSplitScrollSync 挂 Ace 滚动监听；setMode 可能更换 session，用 changeSession 重新挂。
// changeScrollTop 触发时渲染层还没更新到新位置，延一帧再读，否则比例会慢一拍。
function hookSplitScrollSync(doc) {
    const ace = doc && doc.editor && doc.editor.aceEditor;
    if (!ace || doc._splitSyncAce === ace) return;
    unhookSplitScrollSync(doc);
    // changeScrollTop 回调参数就是滚动值（像素）：预览反向驱动写入的值与 _aceEcho 相同，忽略
    const onScroll = (top) => {
        if (top != null && Math.round(top) === doc._aceEcho) return;
        if (doc._splitSyncRaf) cancelAnimationFrame(doc._splitSyncRaf);
        doc._splitSyncRaf = requestAnimationFrame(() => {
            doc._splitSyncRaf = 0;
            mdSyncScrollFromAce(doc);
        });
    };
    const attach = (sess) => {
        if (!sess || sess === doc._splitSyncSession) return;
        detachSession();
        doc._splitSyncSession = sess;
        sess.on('changeScrollTop', onScroll);
    };
    const detachSession = () => {
        if (doc._splitSyncSession) {
            try { doc._splitSyncSession.off('changeScrollTop', onScroll); } catch (e) {}
            doc._splitSyncSession = null;
        }
    };
    const onSession = (e) => attach(e && e.session ? e.session : ace.session);
    doc._splitSyncAce = ace;
    doc._splitSyncDetach = () => {
        detachSession();
        try { ace.off('changeSession', onSession); } catch (e) {}
    };
    attach(ace.session);
    ace.on('changeSession', onSession);
}

function unhookSplitScrollSync(doc) {
    if (doc && doc._splitSyncDetach) {
        try { doc._splitSyncDetach(); } catch (e) {}
    }
    if (doc) {
        if (doc._splitSyncRaf) {
            cancelAnimationFrame(doc._splitSyncRaf);
            doc._splitSyncRaf = 0;
        }
        doc._splitSyncAce = null;
        doc._splitSyncDetach = null;
        doc._splitSyncSession = null;
    }
}

function createHtmlPreviewView(doc) {
    if (doc.htmlPreviewEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'html-preview-view';
    const frame = document.createElement('iframe');
    frame.className = 'html-preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = doc.name || 'HTML 预览';
    wrap.appendChild(frame);
    doc.pane.appendChild(wrap);
    doc.htmlPreviewEl = wrap;
    doc.htmlFrame = frame;
}

function relativeDirUrl(root, filePath) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const r = norm(root);
    const d = norm(deps.parentFolderOf(filePath));
    if (!r || !d) return '';
    if (d.toLowerCase() === r.toLowerCase()) return '';
    if (!d.toLowerCase().startsWith(r.toLowerCase() + '/')) return '';
    return d.slice(r.length + 1).split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
}

async function ensureHtmlPreviewRoot(doc) {
    if (doc.htmlPreviewRoot || !doc.path || !deps.backend.RegisterPreviewRoot) return;
    let root = '';
    if (deps.workspaceFolder && deps.pathWithinValue(deps.workspaceFolder, doc.path)) root = deps.workspaceFolder;
    else root = deps.parentFolderOf(doc.path);
    if (!root) return;
    try {
        const token = await deps.backend.RegisterPreviewRoot(root);
        if (token) doc.htmlPreviewRoot = {root, token};
    } catch (e) {}
}

function injectHtmlBase(text, baseTag) {
    const src = String(text || '');
    if (!baseTag) return src;
    const doctype = /^\s*<!doctype[^>]*>/i.exec(src);
    if (doctype) return src.slice(0, doctype[0].length) + baseTag + src.slice(doctype[0].length);
    return baseTag + src;
}

function renderHtmlPreview(doc) {
    if (!doc || !doc.htmlFrame || !doc.editor) return;
    const apply = () => {
        if (!doc.htmlFrame || !doc.editor) return;
        let base = '<base target="_blank">';
        if (doc.htmlPreviewRoot) {
            const sub = relativeDirUrl(doc.htmlPreviewRoot.root, doc.path);
            base = '<base href="/__local/' + doc.htmlPreviewRoot.token + '/' + sub + '" target="_blank">';
        }
        doc.htmlFrame.srcdoc = injectHtmlBase(doc.editor.getText(), base);
    };
    if (doc.htmlPreviewRoot || doc.htmlRootTried || !doc.path) {
        apply();
        return;
    }
    doc.htmlRootTried = true;
    ensureHtmlPreviewRoot(doc).then(apply).catch(() => apply());
}

// SVG 渲染用的源文本：渲染视图下 jsoneditor 可能已把树值序列化成 JSON 填进编辑器，
// 真源保存在 _svgSrcText；其余情况以编辑器文本为准，最后回退打开时的原文。
function svgSourceFor(doc) {
    if (!doc) return '';
    if (doc.mode === 'render' && doc._svgSrcText != null && doc._svgSrcText.trim()) return doc._svgSrcText;
    let text = '';
    try { text = doc.editor ? doc.editor.getText() : ''; } catch (e) { text = ''; }
    if (!text.trim() && doc._svgSrcText != null && doc._svgSrcText.trim()) text = doc._svgSrcText;
    if (!text.trim() && doc.rawText != null) text = doc.rawText;
    return text;
}

function looksLikeSvg(text) {
    return /<svg[\s>]/i.test(String(text || ''));
}

// 渲染失败时隐藏 <img> 并在画布中央显示原因，避免只剩一片空白（图片 onerror 原本没有处理）
function setSvgRenderError(doc, message) {
    if (!doc || !doc.svgRenderImg) return;
    const status = doc.svgRenderStatus;
    if (!message) {
        doc.svgRenderError = '';
        doc.svgRenderImg.style.display = '';
        if (status) {
            status.classList.add('hidden');
            status.textContent = '';
        }
        return;
    }
    doc.svgRenderError = message;
    doc.svgRenderImg.style.display = 'none';
    if (status) {
        status.textContent = message;
        status.classList.remove('hidden');
    }
}

function renderSplitSvg(doc) {
    if (!doc || !doc.svgRenderImg || !doc.editor) return;
    const text = svgSourceFor(doc);
    if (!text || !text.trim()) {
        setSvgRenderError(doc, '当前没有可渲染的 SVG 源码');
        return;
    }
    if (!looksLikeSvg(text)) {
        setSvgRenderError(doc, '当前源码不是 SVG（缺少 <svg> 根元素），已停止渲染');
        return;
    }
    setSvgRenderError(doc, '');
    doc.svgRenderImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
}

function renderSplitPreview(doc) {
    if (!doc || !doc.splitActive) return;
    if (doc.splitKind === 'markdown') renderMarkdownPreview(doc, {incremental: true});
    else if (doc.splitKind === 'svg') renderSplitSvg(doc);
    else if (doc.splitKind === 'html') renderHtmlPreview(doc);
}

function scheduleSplitPreview(doc) {
    if (!doc || !doc.splitActive) return;
    clearTimeout(doc.splitTimer);
    doc.splitTimer = setTimeout(() => {
        doc.splitTimer = 0;
        renderSplitPreview(doc);
    }, doc.splitKind === 'html' ? 350 : 160);
}

function enterSplitView(doc) {
    if (!doc || !doc.editor) return;
    const kind = deps.splitKindFor(doc);
    if (!kind) {
        deps.flash('当前文件不支持分屏预览', true);
        return;
    }
    if (doc.large || doc.binary) {
        deps.flash('大文件不支持分屏预览', true);
        return;
    }
    if (doc.splitActive) {
        if (doc.pane) doc.pane.style.setProperty('--split-ratio', String(splitRatioFor(doc)));
        renderSplitPreview(doc);
        if (kind === 'markdown') {
            hookSplitScrollSync(doc);
            hookPreviewScrollSync(doc);
            mdSyncScrollFromAce(doc);
        }
        setTimeout(() => {
            if (doc.editor && doc.editor.aceEditor) {
                try { doc.editor.aceEditor.resize(); } catch (e) {}
            }
        }, 0);
        return;
    }
    const loading = doc.loading;
    doc.loading = true;
    try {
        let src = null;
        if (kind === 'svg' && doc.mode === 'tree') {
            try { src = doc.format.stringify(doc.editor.get()); } catch (e) {}
        }
        // 从渲染视图切分屏时真源是 _svgSrcText：走到这里时编辑器文本可能已经被序列化成 JSON
        if (src == null) src = kind === 'svg' ? svgSourceFor(doc) : doc.editor.getText();
        doc.editor.setMode('code');
        if (kind === 'svg') doc.editor.setText(src);
        doc.text = doc.editor.getText();
        if (!doc.dirty) doc.bases.code = doc.text;
        doc.mode = 'code';
        deps.currentMode = 'code';
        if (doc.pane) {
            doc.pane.classList.remove('preview-active', 'svg-render-active');
            doc.pane.classList.add('split-active');
            doc.pane.classList.toggle('split-markdown', kind === 'markdown');
            doc.pane.classList.toggle('split-svg', kind === 'svg');
            doc.pane.classList.toggle('split-html', kind === 'html');
            doc.pane.style.setProperty('--split-ratio', String(splitRatioFor(doc)));
        }
        if (kind === 'markdown') createMarkdownPreview(doc);
        else if (kind === 'svg') createSvgRenderView(doc);
        else if (kind === 'html') createHtmlPreviewView(doc);
        ensureSplitDivider(doc);
        doc.splitKind = kind;
        doc.splitActive = true;
        renderSplitPreview(doc);
        if (kind === 'markdown') {
            hookSplitScrollSync(doc);
            hookPreviewScrollSync(doc);
        }
        deps.applyAceMode(true);
        deps.showBanner(doc, doc.parseError);
        deps.updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('打开分屏失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    setTimeout(() => {
        if (doc.splitActive && doc.editor && doc.editor.aceEditor) {
            try { doc.editor.aceEditor.resize(); } catch (e) {}
        }
    }, 0);
}

function exitSplitView(doc) {
    if (!doc || !doc.splitActive) return;
    doc.splitActive = false;
    doc.splitKind = '';
    clearTimeout(doc.splitTimer);
    doc.splitTimer = 0;
    unhookSplitScrollSync(doc);
    if (doc._splitPreviewDetach) {
        try { doc._splitPreviewDetach(); } catch (e) {}
    }
    if (doc.htmlFrame) doc.htmlFrame.srcdoc = '';
    if (doc.splitDivider) {
        doc.splitDivider.remove();
        doc.splitDivider = null;
    }
    if (doc.pane) {
        doc.pane.classList.remove('split-active', 'split-markdown', 'split-svg', 'split-html');
        doc.pane.style.removeProperty('--split-ratio');
    }
    if (doc.editor && doc.editor.aceEditor) {
        try { doc.editor.aceEditor.resize(); } catch (e) {}
    }
    deps.syncTabViewTools();
}

function createImageView(doc) {
    if (doc.imageEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'image-preview-view';
    const scroll = document.createElement('div');
    scroll.className = 'image-preview-scroll';
    const canvas = document.createElement('div');
    canvas.className = 'image-preview-canvas';
    const status = document.createElement('div');
    status.className = 'image-preview-status';
    status.textContent = '正在加载图片…';
    const img = document.createElement('img');
    img.className = 'image-preview-img';
    img.alt = doc.name;
    img.draggable = false;
    img.hidden = true;
    img.addEventListener('load', () => {
        doc.imageWidth = img.naturalWidth;
        doc.imageHeight = img.naturalHeight;
        doc.imageError = null;
        img.hidden = false;
        status.classList.add('hidden');
        applyImageZoom(doc);
        if (doc === deps.file) deps.updateStatus();
    });
    img.addEventListener('error', () => {
        img.hidden = true;
        doc.imageError = '无法解码该图片';
        status.textContent = '无法预览此图片，可切换到二进制视图';
        status.classList.remove('hidden');
        if (doc === deps.file && deps.currentMode === 'image') {
            deps.flash('图片无法预览，已切换到二进制视图', true);
            deps.switchMode('binary');
        }
    });
    canvas.appendChild(img);
    scroll.append(canvas, status);
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.imageEl = wrap;
    doc.imageScroll = scroll;
    doc.imageCanvas = canvas;
    doc.imageNode = img;
    doc.imageStatus = status;

    scroll.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (scroll.scrollWidth <= scroll.clientWidth + 1 && scroll.scrollHeight <= scroll.clientHeight + 1) return;
        e.preventDefault();
        doc.imagePan = {id: e.pointerId, x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop};
        scroll.classList.add('panning');
        try {
            scroll.setPointerCapture(e.pointerId);
        } catch (err) {}
    });
    scroll.addEventListener('pointermove', (e) => {
        const pan = doc.imagePan;
        if (!pan || e.pointerId !== pan.id) return;
        scroll.scrollLeft = pan.left - (e.clientX - pan.x);
        scroll.scrollTop = pan.top - (e.clientY - pan.y);
    });
    const endPan = (e) => {
        if (!doc.imagePan || (e && e.pointerId !== doc.imagePan.id)) return;
        doc.imagePan = null;
        scroll.classList.remove('panning');
    };
    scroll.addEventListener('pointerup', endPan);
    scroll.addEventListener('pointercancel', endPan);
    scroll.addEventListener('dblclick', () => {
        if (!doc.imageWidth) return;
        doc.imageZoom = null;
        applyImageZoom(doc);
    });
    if (typeof ResizeObserver === 'function') {
        doc.imageResizeObserver = new ResizeObserver(() => {
            if (doc === deps.file && deps.currentMode === 'image') applyImageZoom(doc);
        });
        doc.imageResizeObserver.observe(scroll);
    }
}

function applyImageZoom(doc) {
    if (!doc || !doc.imageNode || !doc.imageScroll || !doc.imageWidth || !doc.imageHeight) return;
    const scroll = doc.imageScroll;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width < 20 || height < 20) return;
    const availableWidth = Math.max(1, width - 48);
    const availableHeight = Math.max(1, height - 48);
    const scale = doc.imageZoom == null
        ? Math.min(1, availableWidth / doc.imageWidth, availableHeight / doc.imageHeight)
        : doc.imageZoom;
    const previous = doc.imageScale || 0;
    const centerX = scroll.scrollLeft + width / 2;
    const centerY = scroll.scrollTop + height / 2;
    doc.imageScale = scale;
    doc.imageNode.style.width = Math.max(1, Math.round(doc.imageWidth * scale)) + 'px';
    doc.imageNode.style.height = Math.max(1, Math.round(doc.imageHeight * scale)) + 'px';
    if (previous > 0 && Math.abs(scale - previous) > 0.0001) {
        const ratio = scale / previous;
        requestAnimationFrame(() => {
            if (!doc.imageScroll) return;
            doc.imageScroll.scrollLeft = Math.max(0, centerX * ratio - width / 2);
            doc.imageScroll.scrollTop = Math.max(0, centerY * ratio - height / 2);
        });
    }
    requestAnimationFrame(() => {
        if (!doc.imageScroll) return;
        const canPan = doc.imageScroll.scrollWidth > doc.imageScroll.clientWidth + 1 ||
            doc.imageScroll.scrollHeight > doc.imageScroll.clientHeight + 1;
        doc.imageScroll.classList.toggle('can-pan', canPan);
    });
    if (doc === deps.file) deps.updateStatus();
}

function zoomImageBy(doc, deltaY) {
    if (!doc || !doc.imageWidth || !deltaY) return;
    const base = doc.imageScale || 1;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    doc.imageZoom = Math.min(8, Math.max(0.05, Math.round(base * factor * 1000) / 1000));
    applyImageZoom(doc);
}

function loadImagePreview(doc) {
    if (!doc || !doc.image) return;
    createImageView(doc);
    if (!doc.imageNode) return;
    if (doc.imageUrl) {
        doc.imageStatus.classList.add('hidden');
        if (doc.imageNode.getAttribute('src') !== doc.imageUrl) doc.imageNode.src = doc.imageUrl;
        applyImageZoom(doc);
        return;
    }
    if (doc.imageLoading) return;
    doc.imageLoading = true;
    doc.imageError = null;
    doc.imageStatus.textContent = '正在加载图片…';
    doc.imageStatus.classList.remove('hidden');
    doc.imageNode.hidden = true;
    const load = deps.backend.ReadImageDataURL
        ? deps.backend.ReadImageDataURL(doc.path)
        : Promise.reject(new Error('当前后端不支持图片预览'));
    Promise.resolve(load).then((url) => {
        doc.imageLoading = false;
        if (!url || !doc.imageNode) throw new Error('图片数据为空');
        doc.imageUrl = url;
        doc.imageNode.src = url;
    }).catch((err) => {
        doc.imageLoading = false;
        doc.imageError = (err && err.message) || String(err);
        if (!doc.imageStatus) return;
        doc.imageStatus.textContent = '无法预览此图片：' + doc.imageError;
        doc.imageStatus.classList.remove('hidden');
        if (doc === deps.file && deps.currentMode === 'image') {
            deps.flash('图片无法预览，已切换到二进制视图', true);
            deps.switchMode('binary');
        }
    });
}

function applySvgZoom(doc) {
    if (!doc || !doc.svgRenderImg || !doc.svgRenderScroll || !doc.svgRenderW || !doc.svgRenderH) return;
    const scroll = doc.svgRenderScroll;
    const width = scroll.clientWidth;
    const height = scroll.clientHeight;
    if (width < 20 || height < 20) return;
    const availableWidth = Math.max(1, width - 36);
    const availableHeight = Math.max(1, height - 36);
    const scale = doc.svgRenderZoom == null
        ? Math.min(1, availableWidth / doc.svgRenderW, availableHeight / doc.svgRenderH)
        : doc.svgRenderZoom;
    const previous = doc.svgRenderScale || 0;
    const centerX = scroll.scrollLeft + width / 2;
    const centerY = scroll.scrollTop + height / 2;
    doc.svgRenderScale = scale;
    doc.svgRenderImg.style.width = Math.max(1, Math.round(doc.svgRenderW * scale)) + 'px';
    doc.svgRenderImg.style.height = Math.max(1, Math.round(doc.svgRenderH * scale)) + 'px';
    if (previous > 0 && Math.abs(scale - previous) > 0.0001) {
        const ratio = scale / previous;
        requestAnimationFrame(() => {
            if (!doc.svgRenderScroll) return;
            scroll.scrollLeft = Math.max(0, centerX * ratio - width / 2);
            scroll.scrollTop = Math.max(0, centerY * ratio - height / 2);
        });
    }
    if (doc === deps.file) deps.updateStatus();
}

function zoomSvgRenderBy(doc, deltaY) {
    if (!doc || !doc.svgRenderW || !deltaY) return;
    const base = doc.svgRenderScale || 1;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    doc.svgRenderZoom = Math.min(8, Math.max(0.05, Math.round(base * factor * 1000) / 1000));
    applySvgZoom(doc);
}

function showSvgRender(doc) {
    createSvgRenderView(doc);
    if (doc.pane) doc.pane.classList.add('svg-render-active');
    if (!doc.svgRenderImg || !doc.editor) return;
    // 真源优先用进入渲染视图时保存的 _svgSrcText（树模式下 getText() 是 JSON 序列化）
    const svgText = svgSourceFor(doc);
    if (!svgText || !svgText.trim()) {
        setSvgRenderError(doc, '当前没有可渲染的 SVG 源码');
        return;
    }
    if (!looksLikeSvg(svgText)) {
        setSvgRenderError(doc, '当前内容不是 SVG（缺少 <svg> 根元素），已停止渲染');
        return;
    }
    setSvgRenderError(doc, '');
    doc.svgRenderImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
}

function hideSvgRender(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('svg-render-active');
}

function enterSvgRender(doc) {
    if (!doc || !doc.editor) return;
    doc.loading = true;
    try {
        // 记录退出渲染视图时的 SVG 源文本：
        // 树模式下 getText() 是树值的 JSON 序列化，必须用 format.stringify 还原 XML 源
        let src = null;
        if (doc.mode === 'tree') {
            try { src = doc.format.stringify(doc.editor.get()); } catch (e) {}
        }
        if (!src || !src.trim()) src = doc.editor.getText();
        if (!src || !src.trim()) src = doc.rawText != null ? doc.rawText : (doc.content || '');
        doc._svgSrcText = src;
        doc.editor.setMode('code');
        // setMode('code') 会把树值序列化成 JSON 填进编辑器，必须立刻写回 SVG 源文本，
        // 否则随后切分屏/保存拿到的都是 JSON（渲染本身正常，分屏则整片空白）
        doc.editor.setText(src);
        doc.text = src;
        if (!doc.dirty) doc.bases.code = src;
        doc.mode = 'render';
        deps.currentMode = 'render';
        showSvgRender(doc);
        deps.showBanner(doc, doc.parseError);
        deps.updateStatus();
        deps.updateSearchState();
    } finally {
        doc.loading = false;
    }
}

function createSvgRenderView(doc) {
    if (doc.svgRenderEl || !doc.pane) return;
    const wrap = document.createElement('div');
    wrap.className = 'svg-render-view';
    const scroll = document.createElement('div');
    scroll.className = 'svg-render-scroll';
    const img = document.createElement('img');
    img.className = 'svg-render-img';
    img.alt = doc.name || 'SVG';
    img.onload = () => {
        doc.svgRenderW = img.naturalWidth || 240;
        doc.svgRenderH = img.naturalHeight || 120;
        setSvgRenderError(doc, '');
        applySvgZoom(doc);
    };
    img.onerror = () => setSvgRenderError(doc, 'SVG 渲染失败：浏览器无法解码该内容');
    const status = document.createElement('div');
    status.className = 'svg-render-status hidden';
    scroll.append(img, status);
    doc.svgRenderScroll = scroll;
    doc.svgRenderStatus = status;
    wrap.appendChild(scroll);
    doc.pane.appendChild(wrap);
    doc.svgRenderEl = wrap;
    doc.svgRenderImg = img;
}

function showImageView(doc) {
    if (!doc || !doc.image) return;
    createImageView(doc);
    if (doc.pane) doc.pane.classList.add('image-active');
    loadImagePreview(doc);
}

function hideImageView(doc) {
    if (!doc || !doc.pane) return;
    doc.pane.classList.remove('image-active');
}

function enterImageView(doc) {
    if (!doc || !doc.image || !doc.editor) return;
    doc.loading = true;
    try {
        doc.editor.setMode('code');
        doc.mode = 'image';
        deps.currentMode = 'image';
        showImageView(doc);
        deps.showBanner(doc, doc.parseError);
        deps.updateStatus();
        deps.updateSearchState();
    } finally {
        doc.loading = false;
    }
}

function enterBinaryView(doc) {
    if (!doc || !doc.binary || !doc.editor) return;
    hideImageView(doc);
    doc.mode = 'binary';
    deps.currentMode = 'binary';
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode('code');
    } catch (e) {
        deps.flash('切换二进制视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    if (doc.pane) doc.pane.classList.add('active');
    deps.applyAceMode();
    deps.showBanner(doc, doc.parseError);
    deps.updateStatus();
    deps.updateSearchState();
    try {
        if (doc.editor.aceEditor) doc.editor.aceEditor.resize();
    } catch (e) {}
}

function enterTextView(doc) {
    if (!doc || !doc.editor) return;
    hideImageView(doc);
    const loading = doc.loading;
    doc.loading = true;
    try {
        doc.editor.setMode('text');
        doc.mode = 'text';
        deps.currentMode = 'text';
        if (doc.pane) doc.pane.classList.add('active');
        deps.showBanner(doc, doc.parseError);
        deps.updateStatus();
        deps.updateSearchState();
    } catch (e) {
        deps.flash('切换文本视图失败：' + e.message, true);
    } finally {
        doc.loading = loading;
    }
    deps.applyReadOnlyToDoc(doc);
}

    return {
        createMarkdownPreview,
        renderMarkdownPreview,
        showMarkdownPreview,
        hideMarkdownPreview,
        enterMarkdownPreview,
        leaveMarkdownPreview,
        splitRatioFor,
        ensureSplitDivider,
        mdSyncScrollFromAce,
        mdSyncScrollFromPreview,
        hookPreviewScrollSync,
        hookSplitScrollSync,
        unhookSplitScrollSync,
        createHtmlPreviewView,
        renderHtmlPreview,
        svgSourceFor,
        looksLikeSvg,
        setSvgRenderError,
        renderSplitSvg,
        renderSplitPreview,
        scheduleSplitPreview,
        enterSplitView,
        exitSplitView,
        createImageView,
        applyImageZoom,
        zoomImageBy,
        loadImagePreview,
        applySvgZoom,
        zoomSvgRenderBy,
        showSvgRender,
        hideSvgRender,
        enterSvgRender,
        createSvgRenderView,
        showImageView,
        hideImageView,
        enterImageView,
        enterBinaryView,
        enterTextView,
    };
}
