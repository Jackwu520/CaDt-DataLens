// cursor-themes.js：从 main.js 拆出的域模块（factory + 显式依赖注入）。
// Win11/系统调整光标（后端读注册表当前主题 + 内置候选，失败回落 CSS 关键字）
// 注意：Windows 的 .cur 是多尺寸帧容器（aero_* 含 32/48/64/96/128 五帧），每帧在 ICONDIRENTRY
// 的 planes/bitcount 位置存自己的热点。以前按 ICONDIR 头部读热点是错的（读到 dwImageOffset），
// 而且浏览器默认会挑最大帧再缩放，导致糊、偏、尺寸不对。这里自己解析 .cur、按基准尺寸取帧原样使用。
//
// 依赖一律经 deps 延迟求值（调用方传 getter），不在创建期解构：
// 这样既不依赖 main.js 的声明顺序，也不会把 let 状态拍成快照。


export function createCursorThemes(deps) {

let sysCursor = null;
// 系统光标逻辑基准尺寸（96dpi CSS px）：后端读 CursorBaseSize（默认 32；辅助功能放大光标时更大）。
// 高 DPI 缩放不写死，由 image-set 按运行时 devicePixelRatio 自动选帧。
let cursorCssSize = 32;

// 统一清理：拖拽态一旦残留，普通区域会继承全局光标、文本无法选中、点击被吞。
// 各拖拽流程自己的收尾照旧，这里只做幂等兜底，集中一处避免「只清了一半」。
function clearDragVisualState() {
    const body = document.body;
    if (!body) return;
    body.classList.remove('cursor-ew', 'cursor-ns', 'csv-col-resizing');
    if (body.style.userSelect) body.style.userSelect = '';
}

// Wails frameless 的边缘 resize 是「系统级」状态：runtime 会在 6px 边缘写入
// resizeEdge + html 内联光标，只有下一次非边缘 mousemove 才清。清除被跳过时
// （最大化时 enableResize=false / 鼠标直接移出窗口），下一次任意 mousedown
// 都会被 runtime 劫持成 WM_NCLBUTTONDOWN → 系统模态 sizing loop，WebView2
// 收不到任何输入。这里只在「确认是残留」时清，不干扰正常的边缘拖窗口。
const RESIZE_CURSOR = /^(n|ne|e|se|s|sw|w|nw)-resize$/;
function wailsFlags() {
    return (window.wails && window.wails.flags) || null;
}
function clearStaleWailsResize() {
    const flags = wailsFlags();
    if (!flags) return;
    flags.resizeEdge = undefined;
    const root = document.documentElement;
    if (root && RESIZE_CURSOR.test(root.style.cursor || '')) root.style.cursor = '';
}
function isNearWindowEdge(e, thickness) {
    const t = thickness || 6;
    return e.clientX < t
        || window.outerWidth - e.clientX < t
        || e.clientY < t
        || window.outerHeight - e.clientY < t;
}
function clearDragState() {
    clearDragVisualState();
    clearStaleWailsResize();
}

function setDragCursor(kind) {
    // 诊断探针：间歇性「全局左右箭头」问题定位——记录谁设置 / 谁清除（进调试控制台与 jsonl）
    if (kind || document.body.classList.contains('cursor-ew') || document.body.classList.contains('cursor-ns')) {
        const stack = String(new Error().stack || '').split('\n').slice(2, 4).join(' ← ').trim();
        console.info('[cursor] setDragCursor(' + (kind || 'null') + ') ' + stack);
    }
    if (!kind) {
        clearDragVisualState();
        return;
    }
    document.body.classList.toggle('cursor-ew', kind === 'ew');
    document.body.classList.toggle('cursor-ns', kind === 'ns');
}

function parseCurFrames(dataUrl) {
    try {
        const bin = atob((dataUrl || '').split(',')[1] || '');
        const n = bin.length;
        if (n < 22) return null;
        const u16 = (o) => bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8);
        const u32 = (o) => (bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) | (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24)) >>> 0;
        if (u16(2) !== 2) return null; // 2 = CUR（1 = ICO）
        const count = u16(4);
        const out = [];
        for (let i = 0; i < count; i++) {
            const e = 6 + i * 16;
            if (e + 16 > n) break;
            const w = bin.charCodeAt(e) || 256;
            const h = bin.charCodeAt(e + 1) || 256;
            const hx = u16(e + 4); // CUR 的 wPlanes 字段实为热点 X
            const hy = u16(e + 6); // CUR 的 wBitCount 字段实为热点 Y
            const size = u32(e + 8);
            const off = u32(e + 12);
            if (!size || off + size > n) continue;
            out.push({bin, w, h, hx, hy, size, off});
        }
        return out.length ? out : null;
    } catch (e) { return null; }
}

function pickCurFrame(frames, target) {
    let best = null;
    let bestScore = Infinity;
    for (const f of frames) {
        // 优先选不小于目标的帧（放大精度更好），再取尺寸差最小
        const score = Math.abs(f.w - target) + (f.w < target ? 1024 : 0);
        if (score < bestScore) { bestScore = score; best = f; }
    }
    return best;
}

function curFrameDataUrl(fr) {
    // 重新打包成单帧 .cur，避免浏览器在多帧文件里挑到最大帧
    const le = (v, bytes) => {
        let s = '';
        for (let i = 0; i < bytes; i++) s += String.fromCharCode((v >> (8 * i)) & 255);
        return s;
    };
    let head = le(0, 2) + le(2, 2) + le(1, 2);
    head += String.fromCharCode(fr.w === 256 ? 0 : fr.w, fr.h === 256 ? 0 : fr.h, 0, 0);
    head += le(fr.hx, 2) + le(fr.hy, 2) + le(fr.size, 4) + le(22, 4);
    return 'data:image/x-icon;base64,' + btoa(head + fr.bin.substr(fr.off, fr.size));
}

function rasterizeCurFrame(fr, size) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const iw = img.naturalWidth || img.width;
                const ih = img.naturalHeight || img.height;
                const c = document.createElement('canvas');
                c.width = size;
                c.height = size;
                const ctx = c.getContext('2d');
                const scaled = iw !== size || ih !== size;
                ctx.imageSmoothingEnabled = scaled; // 1:1 帧原样拷贝，不做二次插值
                if (scaled) ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, size, size);
                resolve({png: c.toDataURL('image/png'), iw, ih});
            } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = curFrameDataUrl(fr);
    });
}

let imageSetCursorSupport = null;
function supportsImageSetCursor() {
    if (imageSetCursorSupport == null) {
        try {
            imageSetCursorSupport = !!(window.CSS && CSS.supports && CSS.supports('cursor', 'image-set(url("x") 1x) 0 0, auto'));
        } catch (e) { imageSetCursorSupport = false; }
    }
    return imageSetCursorSupport;
}

function fmtResolution(res) {
    if (Number.isInteger(res)) return res + 'x';
    return res.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'x';
}

async function buildCursorValue(kind, keyFallback) {
    const url = sysCursor[kind];
    if (!url) return null;
    const frames = parseCurFrames(url);
    if (!frames) return null;
    const base = pickCurFrame(frames, cursorCssSize);
    const one = await rasterizeCurFrame(base, cursorCssSize);
    if (!one) return null;
    // 热点按实际帧尺寸换算到 CSS 逻辑尺寸；CSS 只接受整数
    const hx = Math.max(0, Math.min(cursorCssSize - 1, Math.round(base.hx * cursorCssSize / base.w)));
    const hy = Math.max(0, Math.min(cursorCssSize - 1, Math.round(base.hy * cursorCssSize / base.h)));
    const plain = 'url("' + one.png + '") ' + hx + ' ' + hy + ', ' + keyFallback;

    // image-set 让 Chromium 按 DPR 选原生帧：@150% 用 48px 帧，不再把 32px 位图向上插值（糊）
    let set = null;
    if (supportsImageSetCursor()) {
        const cands = [];
        const seen = {};
        for (const f of frames) {
            if (f.w < 16) continue;
            const res = f.w / cursorCssSize;
            if (res < 1 || res > 4) continue; // 原生帧按「基准尺寸」换算成 1x~4x 档
            const key = res.toFixed(2);
            if (seen[key]) continue;
            seen[key] = true;
            const png = await rasterizeCurFrame(f, f.w); // 原生像素，1:1，不插值
            if (png) cands.push({res, png: png.png});
        }
        if (!seen['1.00']) cands.push({res: 1, png: one.png});
        cands.sort((a, b) => a.res - b.res);
        if (cands.length) {
            set = 'image-set(' + cands.map((c) => 'url("' + c.png + '") ' + fmtResolution(c.res)).join(', ') + ') ' + hx + ' ' + hy + ', ' + keyFallback;
        }
    }
    return {plain, set};
}

async function applySystemCursors() {
    if (!sysCursor) return;
    const ew = await buildCursorValue('ew', 'ew-resize');
    const ns = await buildCursorValue('ns', 'ns-resize');
    const parts = [];
    const pushRule = (selector, v) => {
        if (!v) return;
        let rule = selector + ' { cursor: ' + v.plain + ';';
        if (v.set) rule += ' cursor: ' + v.set + ';';
        parts.push(rule + ' }');
    };
    pushRule('.sidebar-resize, .esplit-col > .esplit-divider', ew);
    pushRule('body.cursor-ew', ew);
    pushRule('.term-resize, .git-splitter, .esplit-row > .esplit-divider', ns);
    pushRule('body.cursor-ns', ns);
    if (!parts.length) return;
    let style = document.getElementById('sys-cursors');
    if (!style) {
        style = document.createElement('style');
        style.id = 'sys-cursors';
        document.head.appendChild(style);
    }
    style.textContent = parts.join('\n');
}

if (deps.backend && deps.backend.GetSystemCursors) {
    deps.backend.GetSystemCursors().then((c) => {
        if (!c || !(c.ew || c.ns)) return;
        const base = Number(c.base);
        if (Number.isFinite(base) && base >= 16 && base <= 128) cursorCssSize = Math.round(base);
        sysCursor = c;
        applySystemCursors();
    }).catch(() => {});
}

// 拖拽结束事件丢失（鼠标在窗外松手、pointer capture 失败、预览 iframe 吞事件等）
// 会把全局拖拽态卡死。四层兜底，一律挂捕获阶段：业务代码常在子元素
// stopPropagation，冒泡阶段的监听收不到事件。
//  ① 抬起 / 取消 / 失焦：撤前端视觉态（含 CSV 列宽的 csv-col-resizing 与 userSelect）；
//  ② pointermove / mousemove 且无按键：必然卡死，动一下即自愈（拖拽中 buttons≠0 不误伤）；
//  ③ mousedown 捕获阶段：Wails 的 resizeEdge 与鼠标位置不符或 resize 已禁用 → 清残留，
//     抢在 runtime 的冒泡 mousedown 之前，避免误入系统模态 sizing loop；
//  ④ 窗口尺寸变化 / 页面隐藏：最大化后 enableResize=false，runtime 不再自己清。
for (const dragEndEvt of ['pointerup', 'pointercancel', 'mouseup', 'blur']) {
    window.addEventListener(dragEndEvt, clearDragVisualState, true);
}
function selfHealOnMove(e) {
    if (e.buttons) return;
    const body = document.body;
    const stuck = body && (body.classList.contains('cursor-ew')
        || body.classList.contains('cursor-ns')
        || body.classList.contains('csv-col-resizing')
        || body.style.userSelect);
    const flags = wailsFlags();
    const staleResize = !!(flags && !flags.enableResize && flags.resizeEdge);
    if (stuck) clearDragVisualState();
    if (staleResize) clearStaleWailsResize();
}
for (const moveEvt of ['pointermove', 'mousemove']) {
    window.addEventListener(moveEvt, selfHealOnMove, true);
}
window.addEventListener('mousedown', (e) => {
    const flags = wailsFlags();
    if (!flags || !flags.resizeEdge) return;
    // 位置不符或 resize 已关 → 这条 edge 一定是上次留下的，清掉才能保住这次点击
    if (!flags.enableResize || !isNearWindowEdge(e, flags.borderThickness)) clearStaleWailsResize();
}, true);
function clearResizeWhenDisabled() {
    const flags = wailsFlags();
    if (flags && !flags.enableResize) clearStaleWailsResize();
}
window.addEventListener('resize', clearResizeWhenDisabled, true);
document.addEventListener('visibilitychange', clearResizeWhenDisabled, true);

    return {setDragCursor, clearDragState};
}
