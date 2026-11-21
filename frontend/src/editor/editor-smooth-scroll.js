// editor-smooth-scroll.js：代码视图滚轮平滑滚动。
// 接管 jsoneditor 内嵌 Ace 的 mousewheel 默认处理器，把「一格滚轮瞬跳 3 行」改为平滑过渡；
// 提供三种手感（标准 / 迅捷 / 轻快）+ 关闭，风格表 SCROLL_STYLES 是单一来源。
// 与分屏同步共用 changeScrollTop 信号，互不冲突。
// 纯逻辑（逼近 / 缓动 / 风格解析）导出供单测；运行时 hook 幂等且带能力探测，失败静默回退原生滚动。

// 风格表（单一来源）：value 落盘，label 给用户看，mode 决定算法。
// - exp：累积目标 + 指数逼近，factor 越大越快；连续滚动不断推高目标，跟手不拖尾。
// - duration：固定时长 easeOut，每格重启一段（VSCode 风格），干脆利落。
export const SCROLL_STYLES = [
    {value: 'standard', label: '标准', mode: 'exp', factor: 0.5, desc: '均衡跟手（默认）'},
    {value: 'swift', label: '迅捷', mode: 'exp', factor: 0.7, desc: '最快、最跟手'},
    {value: 'brisk', label: '轻快', mode: 'duration', duration: 80, desc: '短促的 VSCode 风格'},
    {value: 'off', label: '关闭', mode: 'off', desc: '恢复原生逐行硬切'},
];
export const DEFAULT_SCROLL_STYLE = 'standard';

const FRAME_MS = 1000 / 60;
// 吸附阈值：差值小于此值直接落位，消除指数逼近无限拖尾。
const SNAP_PX = 0.5;

// 风格解析：未设置 / 未知值 / 旧的布尔 true 一律回落到默认（标准）；旧布尔 false 视为关闭。
export function resolveScrollStyle(settings) {
    if (!settings) return DEFAULT_SCROLL_STYLE;
    const v = settings.scrollStyle;
    if (v === undefined || v === null || v === '') {
        // 兼容旧版布尔开关 smoothScroll
        if (settings.smoothScroll === false) return 'off';
        return DEFAULT_SCROLL_STYLE;
    }
    return SCROLL_STYLES.some((s) => s.value === v) ? v : DEFAULT_SCROLL_STYLE;
}

export function styleOf(settings) {
    const v = resolveScrollStyle(settings);
    return SCROLL_STYLES.find((s) => s.value === v) || SCROLL_STYLES[0];
}

// 一帧指数逼近（帧率无关）：dt 越大逼近越多，60fps 单帧走 factor 比例。
export function expStep(current, target, elapsedMs, factor) {
    const diff = target - current;
    if (Math.abs(diff) <= SNAP_PX) return target;
    const k = 1 - Math.pow(1 - factor, Math.max(0, elapsedMs) / FRAME_MS);
    return current + diff * k;
}

// 固定时长 easeOut（VSCode 风格）：到时长即终值。
export function easeOutStep(from, to, elapsedMs, duration) {
    if (elapsedMs >= duration || from === to) return to;
    const t = Math.max(0, elapsedMs) / duration;
    return from + (to - from) * (1 - Math.pow(1 - t, 3));
}

// 把「基准位置 + 增量」钳制到 [0, max]，避免滚过界。
export function clampScrollTarget(from, delta, max) {
    const limit = Math.max(0, Number(max) || 0);
    const to = (Number(from) || 0) + (Number(delta) || 0);
    return Math.min(limit, Math.max(0, to));
}

export function createEditorSmoothScroll(deps) {
    // 持续逼近循环：wheel 只推高 _smoothTarget（累积目标），这里每帧向它靠近。
    // duration 风格则用 anim.from + anim.start 每帧算 easeOut。
    function ensureAnim(ace) {
        if (ace._smoothAnim) return; // 已在跑，wheel 只需更新 target
        const session = ace.session;
        const anim = {raf: 0, last: 0, start: 0, from: session.getScrollTop()};
        ace._smoothAnim = anim;
        const frame = (now) => {
            if (ace._smoothAnim !== anim || session !== ace.session) {
                clearAnim(ace);
                return;
            }
            const style = styleOf(deps.getSettings());
            let next;
            if (style.mode === 'duration') {
                if (!anim.start) anim.start = now;
                next = easeOutStep(anim.from, ace._smoothTarget, now - anim.start, style.duration);
            } else {
                const dt = anim.last ? now - anim.last : FRAME_MS;
                anim.last = now;
                next = expStep(session.getScrollTop(), ace._smoothTarget, dt, style.factor);
            }
            try {
                session.setScrollTop(next);
            } catch (e) {
                clearAnim(ace);
                return;
            }
            if (next === ace._smoothTarget || session.getScrollTop() !== next) {
                clearAnim(ace); // 到位，或被外部（Ace/分屏同步）改写了位置
            } else {
                anim.raf = requestAnimationFrame(frame);
            }
        };
        anim.raf = requestAnimationFrame(frame);
    }

    function clearAnim(ace) {
        const anim = ace && ace._smoothAnim;
        if (!anim) return;
        if (anim.raf) cancelAnimationFrame(anim.raf);
        ace._smoothAnim = null;
        ace._smoothTarget = undefined;
    }

    // 用公开 on('mousewheel') 注册监听器（在 Ace 默认处理器之前执行）。
    // e.preventDefault() 会让 _dispatchEvent 跳过默认处理器（原生 scrollBy 的离散跳行）——
    // vendored Ace: `return n && !t.defaultPrevented ? n(t, this) : void 0`。
    function makeHandler(ace) {
        return function onSmoothWheel(e) {
            // ctrl+wheel（缩放）与纯横向滚动不接管，保留原生行为
            try {
                if (e.getAccelKey && e.getAccelKey()) return;
            } catch (err) {}
            if (e.wheelX && !e.wheelY) return;
            const style = styleOf(deps.getSettings());
            if (style.mode === 'off') return; // 关闭：什么都不做，原生滚动照常
            const session = ace.session;
            const renderer = ace.renderer;
            if (!session || !renderer) return;
            const delta = (e.wheelY || 0) * (e.speed || 4);
            if (!delta) return;
            let max = 0;
            try {
                max = Math.max(0, session.getScreenLength() * (renderer.lineHeight || 16) - (renderer.scroller ? renderer.scroller.clientHeight : 0));
            } catch (err) {}
            const from = session.getScrollTop();
            // 累积目标：动画进行中以 target 为基准，连续 wheel 不断推高，速度不被锁死
            const base = Number.isFinite(ace._smoothTarget) ? ace._smoothTarget : from;
            const to = clampScrollTarget(base, delta, max);
            if (to === from && !ace._smoothAnim) return; // 已到边界且无动画：交回原生让滚动链继续
            ace._smoothTarget = to;
            e.preventDefault(); // 阻止 Ace 原生离散滚动，改由动画驱动
            ensureAnim(ace);
        };
    }

    function hookAce(ace) {
        if (!ace || ace._smoothScrollHooked) return;
        if (typeof ace.on !== 'function' || typeof ace.off !== 'function') return; // 能力探测：接口变了就回退原生
        const handler = makeHandler(ace);
        try { ace.on('mousewheel', handler); } catch (e) { return; }
        ace._smoothScrollHooked = true;
        ace._smoothWheelHandler = handler;
        // session 切换（setMode / 分屏退出）时取消进行中的动画，避免写到旧 session
        const onSession = () => clearAnim(ace);
        ace._smoothOnSession = onSession;
        try { ace.on('changeSession', onSession); } catch (e) {}
        // Ace 销毁（关标签 / reload 重建）时自动清 rAF——两条销毁路径都覆盖，无需改调用方
        const onDestroy = () => clearAnim(ace);
        ace._smoothOnDestroy = onDestroy;
        try { ace.on('destroy', onDestroy); } catch (e) {}
    }

    function unhookAce(ace) {
        if (!ace || !ace._smoothScrollHooked) return;
        clearAnim(ace);
        try { if (ace._smoothWheelHandler) ace.off('mousewheel', ace._smoothWheelHandler); } catch (e) {}
        try { if (ace._smoothOnSession) ace.off('changeSession', ace._smoothOnSession); } catch (e) {}
        try { if (ace._smoothOnDestroy) ace.off('destroy', ace._smoothOnDestroy); } catch (e) {}
        ace._smoothScrollHooked = false;
        ace._smoothWheelHandler = null;
        ace._smoothOnSession = null;
        ace._smoothOnDestroy = null;
    }

    function applyToAll() {
        const docs = (deps.getDocs && deps.getDocs()) || [];
        for (const doc of docs) {
            const ace = doc && doc.editor && doc.editor.aceEditor;
            if (ace) hookAce(ace);
        }
    }

    return {hookAce, unhookAce, applyToAll, clearAnim};
}
