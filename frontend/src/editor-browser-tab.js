// editor-browser-tab.js：从 editor-groups.js 拆出的域模块（factory + 显式依赖注入）。
// 浏览器使用标签页：内容区内嵌 WebView2、地址与外部打开、视口预设菜单、
// 弹层显隐同步、标题回写。
//
// deps 经 Object.create 委托继承 editor-groups 的 getter 集。
import {iconSvg} from './icons.js';

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
// fit = 随标签页撑满（默认）；fixed = 固定宽高居中显示。.browser-surface 是唯一
// 真源：ResizeObserver 会把新尺寸同步到原生 WebView2（syncBrowserTab）。

const BROWSER_VIEWPORT_PRESETS = [
    {label: '1280 × 720（桌面）', width: 1280, height: 720},
    {label: '1440 × 900（桌面）', width: 1440, height: 900},
    {label: '375 × 812（iPhone）', width: 375, height: 812},
    {label: '768 × 1024（iPad）', width: 768, height: 1024},
];

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
        surface.style.width = Math.round(vp.width) + 'px';
        surface.style.height = Math.round(vp.height) + 'px';
        surface.style.flex = 'none';
        surface.style.margin = 'auto';
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
    doc.browserViewportBtn.title = '视口尺寸：' + browserViewportLabel(doc) + '（点击切换预设或自定义）';
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
        b.title = title;
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

function browserSurfaceRect(doc) {
    if (!doc.browserEl || !doc.browserEl.isConnected) return null;
    const rect = doc.browserEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    return {
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        w: Math.round(rect.width * dpr),
        h: Math.round(rect.height * dpr),
    };
}

// WebView2 是原生窗口，永远盖在主 WebView 之上：对话框/菜单/面板等浮层打开时必须隐藏它
const BROWSER_POPUP_SELECTORS = [
    '.dialog:not(.hidden)',
    '.ai-model-editor-mask:not(.hidden)',
    '.ctx-menu:not(.hidden)',
    '#menubar .menu.open',
    '#palette-mask:not(.hidden)',
    '#ai-panel.ai-fullscreen:not(.hidden)',
];

function browserVisibleFor(doc) {
    if (doc !== deps.file) return false;
    for (const sel of BROWSER_POPUP_SELECTORS) {
        if (document.querySelector(sel)) return false;
    }
    const mask = document.getElementById('split-mask');
    if (mask && mask.style.display === 'block') return false;
    return true;
}

let browserSyncPending = false;
function syncBrowserTab(doc) {
    if (!doc.browser || browserSyncPending || !deps.backend.BrowserSetBounds) return;
    browserSyncPending = true;
    // setTimeout 而非 rAF：后台标签页 rAF 冻结会让 bounds/可见性同步永久卡住
    setTimeout(() => {
        browserSyncPending = false;
        if (!deps.docs.includes(doc) || !doc.browserEl) return;
        const rect = browserSurfaceRect(doc);
        const visible = !!rect && browserVisibleFor(doc);
        const last = doc.browserApplied;
        // 轮询同步会反复进来：状态没变就别再跨进程调后端
        if (!visible) {
            if (last && !last.visible) return;
            doc.browserApplied = {visible: false};
            deps.backend.BrowserSetVisible(doc.id, false).catch(() => {});
            return;
        }
        if (last && last.visible && last.x === rect.x && last.y === rect.y && last.w === rect.w && last.h === rect.h) return;
        doc.browserApplied = {visible: true, x: rect.x, y: rect.y, w: rect.w, h: rect.h};
        deps.backend.BrowserSetBounds(doc.id, rect.x, rect.y, rect.w, rect.h).catch(() => {});
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
        renderTabs();
    }
    if (doc === deps.file) {
        setFilename(doc.name, '');
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
