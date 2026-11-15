// editor-browser-tab.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// 浏览器使用标签页：内容区内嵌 WebView2、地址与外部打开、视口预设菜单、
// 弹层显隐同步、标题回写。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集。
import {iconSvg} from '../core/icons.js';

// 纯函数：两个矩形是否真正相交。pad 用来忽略「边缘刚好相切」的 1px 误差，
// 避免菜单贴着网页区域右边界就被判成遮挡。放在模块顶层供单测直接导入。
export function browserRectsOverlap(a, b, pad = 2) {
    if (!a || !b) return false;
    return a.left < b.right - pad && a.right > b.left + pad &&
        a.top < b.bottom - pad && a.bottom > b.top + pad;
}

export function createEditorBrowserTab(deps) {

// ---- 浏览器使用标签页：内容区内嵌 WebView2（browser-use） ----

// 地址栏目标解析：协议原样；Windows 绝对/UNC 路径转 file://；其余补 https://
function browserTargetUrl(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z]:[\\/]/.test(raw)) return encodeURI('file:///' + raw.replace(/\\/g, '/'));
    if (raw.startsWith('\\\\')) return encodeURI('file:' + raw.replace(/\\/g, '/'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    return 'https://' + raw;
}

// 地址栏里优先用户正在输入的内容，否则用当前页面地址
function browserAddressOf(doc) {
    const typed = doc.browserAddr ? String(doc.browserAddr.value || '').trim() : '';
    if (typed) return typed;
    const current = String(doc.browserUrl || '').trim();
    return current && current !== 'about:blank' ? current : '';
}

function openBrowserExternally(doc) {
    const target = browserAddressOf(doc);
    if (!target) {
        deps.flash('地址栏为空，先输入网址或文件路径', true);
        return;
    }
    const url = browserTargetUrl(target);
    if (!url) return;
    if (deps.rt && deps.rt.BrowserOpenURL) deps.rt.BrowserOpenURL(url);
    else window.open(url, '_blank', 'noopener');
}

function showBrowserMoreMenu(doc, anchor) {
    if (!deps.ctxMenu) return;
    const target = browserAddressOf(doc);
    const url = target ? browserTargetUrl(target) : '';
    const rect = anchor.getBoundingClientRect();
    deps.ctxMenu.open([
        {label: '用默认浏览器打开', icon: 'browser', disabled: !url, action: () => openBrowserExternally(doc)},
        {label: '复制网页地址', icon: 'copy', disabled: !target, action: () => deps.copyText(target, '网页地址')},
        {label: '在新标签页中打开', icon: 'new-window', disabled: !url, action: () => deps.openBrowserTab(url, doc.browserProfile)},
        {sep: true},
        {label: '刷新页面', icon: 'refresh', action: () => deps.backend.BrowserReload(doc.id).catch(() => {})},
        {label: '停止加载', icon: 'close', disabled: !doc.loading, action: () => deps.backend.BrowserStop(doc.id).catch(() => {})},
    ], rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    // 菜单已进 DOM：作废显隐缓存，让同步逻辑把原生控件先藏起来（否则菜单会被它盖住）
    doc.browserApplied = null;
    syncBrowserTab(doc);
}

// ---------- 浏览器视口尺寸（用户菜单或 AI browser_resize 工具控制） ----------
// fit = 随标签页撑满（默认）；fixed = 固定逻辑视口，画面在区域内**等比缩放**显示
// （DevTools 响应式模式的做法：控件摆进容器、栅格比例让页面保持设定宽高）。
// .browser-surface 是唯一真源：ResizeObserver 会把新尺寸同步到原生 WebView2（syncBrowserTab）。

const BROWSER_VIEWPORT_PRESETS = [
    {label: '1280 × 720（桌面）', width: 1280, height: 720},
    {label: '1440 × 900（桌面）', width: 1440, height: 900},
    {label: '375 × 812（iPhone）', width: 375, height: 812},
    {label: '768 × 1024（iPad）', width: 768, height: 1024},
];

// 固定视口可用容器区域（CSS px）：.browser-view 去掉工具栏
function browserViewportAvail(doc) {
    const surface = doc.browserEl;
    const view = surface && surface.parentElement;
    if (!view || view.isConnected === false) return null;
    const vr = view.getBoundingClientRect();
    const toolbar = view.querySelector('.browser-toolbar');
    const tbH = toolbar ? toolbar.getBoundingClientRect().height : 0;
    const w = vr.width;
    const h = vr.height - tbH;
    if (!(w > 0) || !(h > 0)) return null;
    return {w, h};
}

// contain 等比缩放系数（≤1）：视口多大逻辑尺寸不变，画面缩到放得下
function browserViewportFitScale(doc) {
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) return 1;
    const avail = browserViewportAvail(doc);
    if (!avail) return 1;
    return Math.min(1, avail.w / vp.width, avail.h / vp.height);
}

// 按当前可用区刷新 fixed 模式的 surface 内联尺寸（窗口改变时同步重算）
function layoutFixedViewport(doc) {
    const vp = doc.browserViewport;
    if (!doc.browserEl || !vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) return;
    const fit = browserViewportFitScale(doc);
    const w = Math.max(1, Math.round(vp.width * fit)) + 'px';
    const h = Math.max(1, Math.round(vp.height * fit)) + 'px';
    if (doc.browserEl.style.width !== w) doc.browserEl.style.width = w;
    if (doc.browserEl.style.height !== h) doc.browserEl.style.height = h;
}

// 解析「宽×高」文本（支持 × x * 与逗号分隔），非法返回 null
function parseBrowserViewportText(text) {
    const match = String(text || '').trim().match(/^(\d{1,5})\s*[×xX*,:，]\s*(\d{1,5})$/);
    if (!match) return null;
    const width = Math.round(Number(match[1]));
    const height = Math.round(Number(match[2]));
    if (width < 200 || width > 8000 || height < 200 || height > 8000) return null;
    return {mode: 'fixed', width, height};
}

function applyBrowserViewport(doc) {
    if (!doc || !doc.browserEl) return;
    const surface = doc.browserEl;
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0) || !(vp.height > 0)) {
        surface.classList.remove('browser-surface-fixed');
        surface.style.width = '';
        surface.style.height = '';
        surface.style.flex = '';
        surface.style.margin = '';
    } else {
        surface.classList.add('browser-surface-fixed');
        surface.style.flex = 'none';
        surface.style.margin = 'auto';
        layoutFixedViewport(doc);
    }
    updateBrowserViewportBtn(doc);
    syncBrowserTab(doc);
}

function setBrowserViewport(doc, viewport) {
    if (!doc || !doc.browserEl) return false;
    doc.browserViewport = viewport && viewport.mode === 'fixed' && viewport.width > 0 && viewport.height > 0
        ? {mode: 'fixed', width: Math.round(viewport.width), height: Math.round(viewport.height)}
        : {mode: 'fit'};
    applyBrowserViewport(doc);
    return true;
}

function browserViewportLabel(doc) {
    const vp = doc.browserViewport;
    if (!vp || vp.mode !== 'fixed' || !(vp.width > 0)) return '自适应';
    return Math.round(vp.width) + '×' + Math.round(vp.height);
}

function updateBrowserViewportBtn(doc) {
    if (!doc || !doc.browserViewportBtn) return;
    doc.browserViewportBtn.textContent = browserViewportLabel(doc);
    doc.browserViewportBtn.dataset.tip = '视口尺寸：' + browserViewportLabel(doc) + '（点击切换预设或自定义）';
}

function showBrowserViewportMenu(doc, anchor) {
    if (!deps.ctxMenu) return;
    const rect = anchor.getBoundingClientRect();
    const vp = doc.browserViewport;
    const isFit = !vp || vp.mode !== 'fixed';
    const items = [{label: '自适应容器', checked: isFit, action: () => setBrowserViewport(doc, {mode: 'fit'})}, {sep: true}];
    for (const preset of BROWSER_VIEWPORT_PRESETS) {
        const active = !isFit && Math.round(vp.width) === preset.width && Math.round(vp.height) === preset.height;
        items.push({
            label: preset.label,
            checked: active,
            action: () => setBrowserViewport(doc, {mode: 'fixed', width: preset.width, height: preset.height}),
        });
    }
    items.push({sep: true});
    items.push({label: '自定义尺寸…', action: () => showBrowserViewportDialog(doc)});
    deps.ctxMenu.open(items, rect.left, rect.bottom + 4, {onClose: () => syncBrowserTab(doc)});
    doc.browserApplied = null;
    syncBrowserTab(doc);
}

function showBrowserViewportDialog(doc) {
    const vp = doc.browserViewport && doc.browserViewport.mode === 'fixed' ? doc.browserViewport : {width: 1280, height: 800};
    deps.openNameDialog({
        title: '自定义视口尺寸',
        label: '宽 × 高（像素，如 1280×800）',
        value: Math.round(vp.width) + '×' + Math.round(vp.height),
        placeholder: '1280×800',
        okLabel: '应用',
        onSubmit: async (value) => {
            const parsed = parseBrowserViewportText(value);
            if (!parsed) {
                throw new Error('格式应为「宽×高」，宽高各 200–8000 像素');
            }
            setBrowserViewport(doc, parsed);
            deps.flash('浏览器视口已设为 ' + parsed.width + '×' + parsed.height);
        },
    });
}

function createBrowserView(doc) {
    const pane = document.createElement('div');
    pane.className = 'jsoneditor-pane active browser-pane';
    deps.els.editor.appendChild(pane);
    const view = document.createElement('div');
    view.className = 'browser-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'browser-toolbar';
    const mkBtn = (icon, title, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'browser-btn';
        b.dataset.tip = title;
        b.innerHTML = iconSvg(icon, 14);
        b.addEventListener('click', action);
        return b;
    };
    const backBtn = mkBtn('back', '后退', () => deps.backend.BrowserGoBack(doc.id).catch(() => {}));
    const fwdBtn = mkBtn('forward', '前进', () => deps.backend.BrowserGoForward(doc.id).catch(() => {}));
    const reloadBtn = mkBtn('refresh', '刷新', () => deps.backend.BrowserReload(doc.id).catch(() => {}));
    // 左侧浏览器图标：交给系统默认浏览器打开当前地址/文件；右侧「更多」：复制地址、新标签页、刷新等
    const externalBtn = mkBtn('browser', '用默认浏览器打开', () => openBrowserExternally(doc));
    const moreBtn = mkBtn('more', '更多操作', () => showBrowserMoreMenu(doc, moreBtn));
    const addr = document.createElement('input');
    addr.className = 'browser-addr';
    addr.type = 'text';
    addr.spellcheck = false;
    addr.placeholder = '输入网址或文件路径后回车（默认 https://）';
    addr.value = doc.browserUrl && doc.browserUrl !== 'about:blank' ? doc.browserUrl : '';
    addr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const target = addr.value.trim();
        if (!target) return;
        const url = browserTargetUrl(target);
        if (!url) return;
        doc.browserUrl = url;
        deps.backend.BrowserNavigate(doc.id, url).catch((err) => deps.flash('导航失败：' + err, true));
    });
    // 视口尺寸按钮：预设（桌面/手机/平板）+ 自定义宽高；AI browser_resize 走同一入口
    const viewportBtn = document.createElement('button');
    viewportBtn.type = 'button';
    viewportBtn.className = 'browser-btn browser-viewport-btn';
    viewportBtn.addEventListener('click', () => showBrowserViewportMenu(doc, viewportBtn));
    toolbar.append(backBtn, fwdBtn, reloadBtn, externalBtn, addr, viewportBtn, moreBtn);
    const surface = document.createElement('div');
    surface.className = 'browser-surface';
    const empty = document.createElement('div');
    empty.className = 'browser-empty';
    empty.textContent = '网页区域加载中…';
    surface.appendChild(empty);
    view.append(toolbar, surface);
    pane.appendChild(view);
    doc.pane = pane;
    doc.browserEl = surface;
    doc.browserEmpty = empty;
    doc.browserAddr = addr;
    doc.browserBackBtn = backBtn;
    doc.browserFwdBtn = fwdBtn;
    doc.browserViewportBtn = viewportBtn;
    if (!doc.browserViewport) doc.browserViewport = {mode: 'fit'};
    updateBrowserViewportBtn(doc);
    if (typeof ResizeObserver === 'function') {
        doc.browserRO = new ResizeObserver(() => syncBrowserTab(doc));
        doc.browserRO.observe(surface);
        doc.browserRO.observe(pane);
    }
    syncBrowserTab(doc);
}

// 网页区域的 CSS 像素矩形（浮层相交判定用）与设备像素矩形（后端 SetBounds 用）
function browserSurfaceCssRect(doc) {
    if (!doc.browserEl || doc.browserEl.isConnected === false) return null;
    const rect = browserRectOf(doc.browserEl);
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function browserSurfaceRect(doc) {
    const rect = browserSurfaceCssRect(doc);
    if (!rect) return null;
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(rect.left * dpr);
    const y = Math.round(rect.top * dpr);
    const physW = Math.round(rect.width * dpr);
    const physH = Math.round(rect.height * dpr);
    // 栅格比例：自适应=设备缩放比（CSS 视口=控件物理尺寸/dpr，与页面坐标严格一致）；
    // 固定视口=缩放后控件反推，保证页面逻辑视口宽高恰是设定的尺寸
    const vp = doc.browserViewport;
    let scale = dpr;
    if (vp && vp.mode === 'fixed' && vp.width > 0 && physW > 0) {
        scale = physW / vp.width;
    }
    return {x, y, w: physW, h: physH, scale};
}

// WebView2 是独立 HWND，永远盖在主 WebView 之上。旧逻辑只要页面里「有」浮层就隐藏
// 整个控件——哪怕菜单在右侧 AI 面板里、完全没压住网页，用户也会看到整页变空白
// （2026-11-15 反馈）。现在只对**实际与网页区域相交**的浮层隐藏控件；相交时把
// 最近一帧网页截图铺在区域上，内容看上去是「定格」而不是消失。
// 全屏遮罩 / 覆盖整窗的面板也在这里，它们的矩形天然与网页区域相交。
const BROWSER_POPUP_SELECTORS = [
    '#dialog-mask:not(.hidden)',
    '.ai-model-editor-mask:not(.hidden)',
    '#palette-mask:not(.hidden)',
    '#quick-switch-mask:not(.hidden)',
    '.gs-mask:not(.hidden)', // gs/jp/diff/js 四个遮罩共享此类
    '#ai-panel.ai-fullscreen:not(.hidden)',
    '.img-lightbox:not(.hidden)',
    '.dialog:not(.hidden)',
    '.ctx-menu:not(.hidden)',
    '#menubar .menu.open',
    // 下拉面板是 absolute、从菜单条往下展开的，父级 .menu 的矩形盖不住它，
    // 必须单独按面板矩形判定（2026-11-15 全量排查）
    '#menubar .menu > .dropdown:not(.hidden)',
    '.tb-pop:not(.hidden)',
    '.msg-center-pop',
    '.set-select-pop.open',
    '.ai-popover:not(.hidden)',
    '.ai-usage-pop',
    '.ai-turn-usage',
    '.ai-model-picker', // 关闭态是 inline visibility:hidden，browserRectOf 会滤掉
    '.ai-model-list-pop',
    '.ai-dialog.ai-dialog-top:not(.hidden)', // 从设置窗打开记忆/技能管理：fixed 挂 body
    '.enc-popover:not(.hidden)', // 状态栏编码/视图浮层：fixed
];

// 取可见元素的矩形；display:none（getClientRects 为空）、visibility:hidden
// （如 ai-model-picker 关闭态：留在 DOM 里但不可命中）与零尺寸元素一律忽略
function browserRectOf(el) {
    if (!el || el.isConnected === false) return null;
    if (typeof el.getClientRects === 'function' && !el.getClientRects().length) return null;
    if (typeof el.getBoundingClientRect !== 'function') return null;
    const vis = el.style && el.style.visibility;
    if (vis === 'hidden' || vis === 'collapse') return null;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
            const css = window.getComputedStyle(el);
            if (css && (css.visibility === 'hidden' || css.visibility === 'collapse')) return null;
        } catch { /* 测试桩可能不支持，忽略 */ }
    }
    const rect = el.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

// 兜底：没列进选择器表的浮层（以后新增的 popover 等）用命中测试抽检 9 个点。
// 只要网页区域上压着别的元素就认为被遮挡；右下角 toast 不算——它只是短提示，
// 不该让整页闪一下空白。
function browserHasUnknownOverlay(doc, surface, dom) {
    if (!dom || typeof dom.elementsFromPoint !== 'function' || !doc.browserEl) return false;
    const pad = 8;
    const w = surface.right - surface.left;
    const h = surface.bottom - surface.top;
    if (w < pad * 3 || h < pad * 3) return false;
    const xs = [surface.left + pad, surface.left + w / 2, surface.right - pad];
    const ys = [surface.top + pad, surface.top + h / 2, surface.bottom - pad];
    for (const x of xs) {
        for (const y of ys) {
            const stack = dom.elementsFromPoint(x, y);
            if (!stack || !stack.length) continue;
            const top = stack[0];
            if (top === doc.browserEl || (doc.browserEl.contains && doc.browserEl.contains(top))) continue;
            if (top.contains && top.contains(doc.browserEl)) continue; // 编辑器/body 等祖先
            if (top.closest && top.closest('#app-toasts')) continue;
            return true;
        }
    }
    return false;
}

// dom 参数供单测注入最小 DOM 桩；生产走全局 document
function browserVisibleFor(doc, surfaceRect, dom) {
    if (doc !== deps.file || !surfaceRect) return false;
    const root = dom || (typeof document !== 'undefined' ? document : null);
    if (!root) return false;
    const split = root.getElementById && root.getElementById('split-mask');
    if (split && split.style && split.style.display === 'block') return false;
    for (const sel of BROWSER_POPUP_SELECTORS) {
        const nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
        for (const el of nodes) {
            const rect = browserRectOf(el);
            if (rect && browserRectsOverlap(rect, surfaceRect)) return false;
        }
    }
    return !browserHasUnknownOverlay(doc, surfaceRect, root);
}

// ---- 冻结帧：浮层压住网页时保留页面内容 ----
// 控件可见时用 BrowserSnapshot 轻量抓一帧（Go 侧单次短超时、隐藏态不 Show）；
// 隐藏时把这一帧铺在 .browser-surface 上，浮层关闭后立刻移除恢复实时渲染。
const BROWSER_SNAPSHOT_GAP = 2000; // ms，正常浏览时约 2s 刷一帧，不额外打扰宿主线程

function browserSnapshotRefresh(doc, force) {
    if (!doc.browser || !deps.backend.BrowserSnapshot || !doc.browserApplied || !doc.browserApplied.visible) return Promise.resolve('');
    if (doc.browserSnapshotPending) return doc.browserSnapshotPending;
    const now = Date.now();
    if (!force && doc.browserSnapshotAt && now - doc.browserSnapshotAt < BROWSER_SNAPSHOT_GAP) return Promise.resolve('');
    doc.browserSnapshotAt = now;
    const url = doc.browserUrl || '';
    const pending = deps.backend.BrowserSnapshot(doc.id).then((b64) => {
        if (!b64) return '';
        doc.browserSnapshot = {url, src: 'data:image/png;base64,' + b64};
        // 抓帧期间浮层才打开：补上定格图，别让用户一直对着空白（地址变了就用不上）
        if (doc.browserApplied && !doc.browserApplied.visible &&
            doc.browserSnapshot.url === (doc.browserUrl || '')) {
            showBrowserSnapshot(doc, doc.browserSnapshot.src);
        }
        return doc.browserSnapshot.src;
    }).catch(() => '').finally(() => {
        if (doc.browserSnapshotPending === pending) doc.browserSnapshotPending = null;
    });
    doc.browserSnapshotPending = pending;
    return pending;
}

function showBrowserSnapshot(doc, src) {
    const surface = doc.browserEl;
    if (!surface || !src) return;
    let img = doc.browserSnapshotEl;
    if (!img || img.isConnected === false) {
        img = document.createElement('img');
        img.className = 'browser-freeze';
        img.alt = '';
        img.style.position = 'absolute';
        img.style.left = '0';
        img.style.top = '0';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'fill';
        img.style.pointerEvents = 'none';
        img.style.userSelect = 'none';
        surface.appendChild(img);
        doc.browserSnapshotEl = img;
    }
    if (img.src !== src) img.src = src;
}

function clearBrowserSnapshot(doc) {
    const img = doc.browserSnapshotEl;
    if (!img) return;
    if (typeof img.remove === 'function') img.remove();
    else if (img.parentNode && img.parentNode.removeChild) img.parentNode.removeChild(img);
    doc.browserSnapshotEl = null;
}

let browserSyncPending = false;
function syncBrowserTab(doc) {
    if (!doc.browser || browserSyncPending || !deps.backend.BrowserSetBounds) return;
    browserSyncPending = true;
    // setTimeout 而非 rAF：后台标签页 rAF 冻结会让 bounds/可见性同步永久卡住
    setTimeout(() => {
        browserSyncPending = false;
        if (!deps.docs.includes(doc) || !doc.browserEl) return;
        // 窗口/分栏尺寸变了：固定视口先按新可用区重算 contain 缩放，再取矩形
        layoutFixedViewport(doc);
        const rect = browserSurfaceRect(doc);
        const cssRect = browserSurfaceCssRect(doc);
        const visible = !!rect && browserVisibleFor(doc, cssRect);
        const last = doc.browserApplied;
        // 轮询同步会反复进来：状态没变就别再跨进程调后端
        if (!visible) {
            if (last && !last.visible) return;
            const hidden = {visible: false};
            doc.browserApplied = hidden;
            const shot = doc.browserSnapshot;
            // 只展示与当前地址一致的帧，避免导航后露出上一页的内容
            if (shot && shot.url === (doc.browserUrl || '')) showBrowserSnapshot(doc, shot.src);
            deps.backend.BrowserSetVisible(doc.id, false).catch(() => {
                // 后端失败也照样记成「已隐藏」的话就再无重试路径（原生窗口会一直压在
                // 弹层/菜单上面）。撤回状态，下一轮 250ms 轮询重试。
                if (doc.browserApplied === hidden) doc.browserApplied = null;
            });
            return;
        }
        if (last && last.visible && last.x === rect.x && last.y === rect.y && last.w === rect.w && last.h === rect.h && last.scale === rect.scale) {
            // 状态没变就不重调 SetBounds；但主 WebView 重建/重排控件窗口会重新
            // 抢占子窗口 z 顶盖住内嵌控件（用户看是黑屏，点一下才恢复）——
            // z 序幂等自检很便宜（Go 侧一次 GetWindow 扫描，已在顶则零副作用）。
            if (deps.backend.BrowserEnsureZ) deps.backend.BrowserEnsureZ(doc.id).catch(() => {});
            // 地址变了且已加载完立刻重抓；否则按节流周期刷新，保证浮层打开时有可用的定格帧
            browserSnapshotRefresh(doc, !!doc.browserSnapshot && !doc.loading &&
                doc.browserSnapshot.url !== (doc.browserUrl || ''));
            return;
        }
        const applied = {visible: true, x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale: rect.scale};
        doc.browserApplied = applied;
        deps.backend.BrowserSetBounds(doc.id, rect.x, rect.y, rect.w, rect.h, rect.scale).then(() => {
            if (!deps.docs.includes(doc)) return;
            clearBrowserSnapshot(doc);      // 原生控件已 Show，撤掉定格帧
            browserSnapshotRefresh(doc, false); // 为下一次浮层备好新帧
        }).catch(() => {
            // 首次 Show/SetBounds 失败（宿主忙、看门狗超时）时若仍记成已应用，
            // 后面轮询全部走「状态没变」分支 → 原生控件永远不显示，只能靠点一下
            // 触发新矩形才恢复。撤回状态让轮询自愈。
            if (doc.browserApplied === applied) doc.browserApplied = null;
        });
    }, 0);
}

function syncAllBrowserTabs() {
    for (const d of deps.docs) {
        if (d.browser) syncBrowserTab(d);
    }
}

function updateBrowserTitle(doc, title) {
    if (!title || title === 'about:blank') return;
    if (doc.name !== title) {
        doc.name = title;
        deps.renderTabs();
    }
    if (doc === deps.file) {
        deps.setFilename(doc.name, '');
        deps.updateWindowTitle();
    }
}

    return {
        browserTargetUrl,
        browserAddressOf,
        openBrowserExternally,
        showBrowserMoreMenu,
        setBrowserViewport,
        browserViewportLabel,
        createBrowserView,
        browserVisibleFor,
        syncBrowserTab,
        syncAllBrowserTabs,
        updateBrowserTitle,
    };
}
