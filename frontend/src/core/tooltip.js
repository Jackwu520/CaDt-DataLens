// core/tooltip.js：全局 tooltip 运行时（data-tip 属性驱动），替代原生 title。
// 单例气泡挂在 body 上：mouseenter/focusin 显示（鼠标带 250ms 延迟防闪烁，键盘焦点立即显示），
// mouseout/focusout/滚动/点击/Esc 隐藏；位置优先在锚点下方，越界翻转到上方并做视口钳制。
// 文本经 textContent 写入（不执行 HTML），\n 以 pre-line 换行。设置页 ⓘ 说明圆点（.info-tip）
// 的气泡也从这里渲染（::after 版本已删）；触屏（粗指针）上点击 ⓘ 切换气泡。
// 替换约定：元素上的 `.title = x` 统一改 `.dataset.tip = x`（HTML 模板 `title="x"` → `data-tip="x"`）；
// document.title（窗口标题）与 iframe 的 title（无障碍名）不属于 tooltip，保持原生。
const SHOW_DELAY_MS = 250;
const BUBBLE_ID = 'app-tip-bubble';
const VIEWPORT_MARGIN = 8;
const GAP = 6;

let bubble = null;
let anchor = null;
let showTimer = 0;
let hideTimer = 0;
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

function hideNow() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (anchor) {
        if (anchor.getAttribute('aria-describedby') === BUBBLE_ID) anchor.removeAttribute('aria-describedby');
        anchor = null;
    }
    if (bubble) bubble.classList.remove('app-tip-on');
}

function scheduleHide(delayMs) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideNow, delayMs);
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
    if (!target.getAttribute('aria-label') && !String(target.textContent || '').trim()) {
        // 纯图标元素：气泡文本兼作可访问名（无障碍名兜底，只补缺）
        target.setAttribute('aria-label', tip);
    }
    target.setAttribute('aria-describedby', BUBBLE_ID);
    anchor = target;
}

function closestTip(target) {
    return target && target.closest ? target.closest('[data-tip]') : null;
}


export function installTooltip() {
    if (installed) return;
    installed = true;

    document.addEventListener('mouseover', (e) => {
        const target = closestTip(e.target);
        if (!target) return;
        if (target === anchor) return;
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        showTimer = setTimeout(() => showFor(target), SHOW_DELAY_MS);
        anchor = target;
    });

    document.addEventListener('mouseout', (e) => {
        if (!anchor) return;
        const related = e.relatedTarget;
        // 在锚点子树内移动（含移动到锚点的另一子元素）不隐藏
        if (related && related.closest && closestTip(related) === anchor) return;
        scheduleHide(120);
    });

    document.addEventListener('focusin', (e) => {
        const target = closestTip(e.target);
        if (!target) return;
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        showFor(target);
    });

    document.addEventListener('focusout', () => scheduleHide(120));

    // 滚动（任意容器）立即隐藏：气泡不跟手滚动。
    window.addEventListener('scroll', hideNow, true);
    document.addEventListener('pointerdown', (e) => {
        const target = closestTip(e.target);
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (coarse && target && target.classList.contains('info-tip')) {
            if (target === anchor) {
                hideNow();
            } else {
                clearTimeout(hideTimer);
                showFor(target);
            }
            return;
        }
        hideNow();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideNow();
    });
    window.addEventListener('blur', hideNow);
}
