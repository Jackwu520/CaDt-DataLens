// core/tooltip.js：全局 tooltip 运行时（data-tip 属性驱动），替代原生 title。
// 单例气泡挂在 body 上：mouseover/focusin 显示（带停留判定），mouseout/focusout/滚动/点击/Esc 隐藏；
// 位置优先在锚点下方，越界翻转到上方并做视口钳制。
//
// 显示时机（别改回「悬停即弹」——扫过一排按钮时满屏乱冒，很打扰人）。
// 参照平台两档制（Windows UX 指南：首次 0.5s / 换控件 0.1s；macOS NSInitialToolTipDelay：1s）：
// - 普通 data-tip：指针要停留 SHOW_DELAY_MS(1s) 才出；一路扫过去不停顿，一个都不弹。
// - 热窗口：气泡刚消失后 WARM_WINDOW_MS 内又贴到别的锚点，只等 RESHOW_DELAY_MS(150ms)——
//   这是 Windows 的 TTDT_RESHOW 语义，沿着一排图标看过去不用一秒一个。
// - 设置页 ⓘ 说明点（.info-tip）：立即出——用户是明确来求解释的，等一秒只会让人以为没反应。
// - 单点覆盖：data-tip-delay="<毫秒>"，0 = 立即（写在外层就整块生效，因为取的是最近 [data-tip]）。
// - 气泡还在屏上时切到相邻锚点：立即出，避免两个相邻图标之间空等一大段。
// - 键盘聚焦（focusin）：立即出，Tab 走查不该还要等。
// - 触屏（粗指针）：点击 ⓘ 切换气泡。
//
// 文本经 textContent 写入（不执行 HTML），\n 以 pre-line 换行。
// 替换约定：元素上的 `.title = x` 统一改 `.dataset.tip = x`（HTML 模板 `title="x"` → `data-tip="x"`）；
// document.title（窗口标题）与 iframe 的 title（无障碍名）不属于 tooltip，保持原生。
export const SHOW_DELAY_MS = 1000; // 首次悬停的「停留」窗口（对齐 macOS 的 1s；别往下调回 250 = 悬停即弹）
export const RESHOW_DELAY_MS = 150; // 热窗口内的再次显示（Windows TTDT_RESHOW 约 initial/5）
const WARM_WINDOW_MS = SHOW_DELAY_MS; // 上一枚气泡消失后多久内算「热」：正好一个停留窗口（同 Windows）
const HIDE_DELAY_MS = 120;
const INSTANT_SELECTOR = '.info-tip';
const BUBBLE_ID = 'app-tip-bubble';
const VIEWPORT_MARGIN = 8;
const GAP = 6;
const COARSE_POINTER = '(pointer: coarse)';

let bubble = null;
let anchor = null;
let showTimer = 0;
let hideTimer = 0;
let lastHiddenAt = 0; // 上一枚气泡真正消失的时刻（热窗口起点）
let installed = false;

function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.id = BUBBLE_ID;
    bubble.className = 'app-tip';
    bubble.setAttribute('role', 'tooltip');
    bubble.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bubble);
    return bubble;
}

function bubbleVisible() {
    return !!(bubble && bubble.classList.contains('app-tip-on'));
}

// warm=true 表示这次隐藏是「指针/焦点离开」，可开热窗口；滚动、点击、Esc、窗口失焦不算
// （那是用户在干别的事，不该让下一个 tooltip 提前冒出来）。
function hideNow(warm) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
    // 真的显示过才记热窗口：没露过面的待显示被撤销，不该让下一次秒出
    if (warm === true && bubbleVisible()) lastHiddenAt = Date.now();
    if (anchor) {
        if (anchor.getAttribute('aria-describedby') === BUBBLE_ID) anchor.removeAttribute('aria-describedby');
        anchor = null;
    }
    if (bubble) bubble.classList.remove('app-tip-on');
}

function scheduleHide(delayMs) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideNow(true), delayMs);
}

// 纯图标元素（无可见文本、无 aria-label）把气泡文本兼作可访问名。只补缺，且在悬停意图阶段就写，
// 这样即便气泡因为没停留而没弹出来，无障碍名也在。
function ensureAccessibleName(target) {
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    if (!target.getAttribute('aria-label') && !String(target.textContent || '').trim()) {
        target.setAttribute('aria-label', tip);
    }
}

function showFor(target) {
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    const el = ensureBubble();
    el.textContent = tip;
    el.classList.add('app-tip-on');
    // 量宽高前先摆到左上角，避免上一次位置残留导致测量翻页
    el.style.left = '0px';
    el.style.top = '0px';
    const rect = target.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let x = rect.left + rect.width / 2 - width / 2;
    x = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN));
    let y = rect.bottom + GAP;
    if (y + height > window.innerHeight - VIEWPORT_MARGIN && rect.top - height - GAP >= VIEWPORT_MARGIN) {
        y = rect.top - height - GAP;
    }
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(Math.max(VIEWPORT_MARGIN, y)) + 'px';
    ensureAccessibleName(target);
    target.setAttribute('aria-describedby', BUBBLE_ID);
    anchor = target;
}

// 延迟判定（纯函数，tooltip.test.mjs 有护栏）：显式 data-tip-delay 优先，其次 ⓘ 说明点立即，
// 气泡还在屏上换内容不留空档，热窗口内只等 reshow，其余一律走「停留」窗口。
export function resolveTipDelay({
    delayAttr = null,
    instant = false,
    showing = false,
    warm = false,
    baseDelay = SHOW_DELAY_MS,
    reshowDelay = RESHOW_DELAY_MS,
} = {}) {
    if (delayAttr !== null && delayAttr !== undefined && String(delayAttr).trim() !== '') {
        const n = Number(delayAttr);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    if (instant) return 0;
    if (showing) return 0;
    if (warm) return Math.min(reshowDelay, baseDelay);
    return baseDelay;
}

function showDelayFor(target, alreadyShowing) {
    const warm = lastHiddenAt > 0 && Date.now() - lastHiddenAt <= WARM_WINDOW_MS;
    return resolveTipDelay({
        delayAttr: target.getAttribute('data-tip-delay'),
        instant: !!(target.closest && target.closest(INSTANT_SELECTOR)),
        showing: alreadyShowing,
        warm,
    });
}

function closestTip(target) {
    return target && target.closest ? target.closest('[data-tip]') : null;
}


export function installTooltip() {
    if (installed) return;
    installed = true;

    document.addEventListener('mouseover', (e) => {
        const target = closestTip(e.target);
        if (!target) {
            // 移到没有 tooltip 的地方：撤掉还没到点的待显示，别「鼠标已经走了才弹出来」
            if (showTimer) {
                clearTimeout(showTimer);
                showTimer = 0;
            }
            return;
        }
        if (target === anchor) return;
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        showTimer = 0;
        hideTimer = 0;
        anchor = target;
        ensureAccessibleName(target);
        const delay = showDelayFor(target, bubbleVisible());
        if (delay <= 0) {
            showFor(target);
            return;
        }
        showTimer = setTimeout(() => {
            showTimer = 0;
            showFor(target);
        }, delay);
    });

    document.addEventListener('mouseout', (e) => {
        if (!anchor) return;
        const related = e.relatedTarget;
        // 在锚点子树内移动（含移动到锚点的另一子元素）不隐藏
        if (related && related.closest && closestTip(related) === anchor) return;
        scheduleHide(HIDE_DELAY_MS);
    });

    // 键盘聚焦立即显示：Tab 走查时不该还要等停留
    document.addEventListener('focusin', (e) => {
        const target = closestTip(e.target);
        if (!target) return;
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        showTimer = 0;
        hideTimer = 0;
        showFor(target);
    });

    document.addEventListener('focusout', () => scheduleHide(HIDE_DELAY_MS));

    // 滚动（任意容器）立即隐藏：气泡不跟手滚动。（包一层，别把 Event 当 warm 传进去）
    window.addEventListener('scroll', () => hideNow(), true);
    document.addEventListener('pointerdown', (e) => {
        const target = closestTip(e.target);
        const coarse = window.matchMedia && window.matchMedia(COARSE_POINTER).matches;
        if (coarse && target && target.classList.contains('info-tip')) {
            if (target === anchor) {
                hideNow();
            } else {
                clearTimeout(hideTimer);
                clearTimeout(showTimer);
                showTimer = 0;
                showFor(target);
            }
            return;
        }
        hideNow();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideNow();
    });
    window.addEventListener('blur', () => hideNow());
}
