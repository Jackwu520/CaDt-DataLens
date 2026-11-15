// 设置页的行式下拉：把原生 select 增强为触发器 + 浮层面板，原生 select 仍是值真源。
// 从 settings-ui.js 拆出；options 动态增删由 MutationObserver 自动重建。
//
// 浮层用「全局单例 Portal」：挂在 body 上、position:fixed，因此不受设置面板
// overflow:auto 的裁剪，也不会把面板的滚动高度撑大（旧实现把面板放在行内，
// 选项一多就把窗口内容顶起来）。打开时按视口剩余空间决定向下 / 向上，并给出
// 最大高度上限与左右边界约束；滚动 / 缩放会重新定位。

export const SS_POP_LIMITS = {gap: 6, edge: 8, maxHeight: 320, minWidth: 160, maxWidth: 360};

// 纯函数：浮层宽度。至少与触发器同宽，最多 360px，且永不超出视口。
export function computePopWidth(rect, viewport, limits = SS_POP_LIMITS) {
    const maxByViewport = Math.max(0, viewport.width - limits.edge * 2);
    return Math.min(Math.max(rect.width, limits.minWidth), limits.maxWidth, maxByViewport);
}

// 纯函数：给定触发器矩形 / 视口 / 浮层自然高度，算出浮层几何。
// 规则：优先向下；下方放不下且上方更宽裕时向上；高度同时受 maxHeight 与可用空间约束。
export function computePopGeometry(rect, viewport, naturalHeight, limits = SS_POP_LIMITS) {
    const {gap, edge, maxHeight} = limits;
    const width = computePopWidth(rect, viewport, limits);
    const below = Math.max(0, viewport.height - rect.bottom - gap - edge);
    const above = Math.max(0, rect.top - gap - edge);
    const wanted = Math.min(Math.max(0, naturalHeight), maxHeight);
    const up = below < wanted && above > below;
    const available = up ? above : below;
    const height = Math.min(wanted, available);
    const left = Math.max(edge, Math.min(rect.left, viewport.width - width - edge));
    const top = up
        ? Math.max(edge, rect.top - gap - height)
        : Math.max(edge, Math.min(rect.bottom + gap, viewport.height - edge - height));
    return {width, height, left, top, up};
}

// 选项文本拆分：option.text 是主标题（也是触发器显示值），
// data-subtitle 存在时浮层多渲染一行副标题。没有该属性的选项保持原来的单行样式。
// 纯函数，便于单测；调用方只认这个约定，不猜任何分隔符。
export function optionLabelParts(option) {
    return {
        title: option ? String(option.text || '') : '',
        subtitle: option && option.dataset ? String(option.dataset.subtitle || '') : '',
    };
}

// tooltip 文本组装（纯函数）：spans 为 [{text, truncated}]，只保留被截断的片段、\n 分行
// （全局 tooltip 气泡对 \n 走 pre-line 换行）。返回空串 = 没有截断，调用方应移除 data-tip。
export function tipTextFromSpans(spans) {
    const hit = (spans || []).filter((s) => s && s.truncated && s.text);
    return hit.length ? hit.map((s) => String(s.text)).join('\n') : '';
}

// 截断判定容差：子像素取整误差不算截断
const TIP_TOLERANCE = 1;

// 按 selectors 顺序找第一个命中的片段组做截断检测，被截断才挂 data-tip（完整文本 \n 分行）。
// 富选项先查 .ss-main/.ss-sub（各自独立截断），单行选项落到 .ss-label；全程无截断则移除。
function syncTipFromSpans(el, selectors) {
    for (const sel of selectors) {
        const nodes = [...el.querySelectorAll(sel)];
        if (!nodes.length) continue;
        const text = tipTextFromSpans(nodes.map((n) => ({
            text: n.textContent,
            truncated: n.scrollWidth > n.clientWidth + TIP_TOLERANCE,
        })));
        if (text) el.dataset.tip = text;
        else el.removeAttribute('data-tip');
        return;
    }
    el.removeAttribute('data-tip');
}

export function createSettingsSelect(deps) {

const POP_ID = 'set-select-pop';
const instances = new Set();
let popEl = null;
let active = null;
let activeIndex = -1;
let typeahead = '';
let typeaheadTimer = 0;
let rafId = 0;

// ---- 全局浮层（唯一 DOM 节点，挂 body，绕过所有 overflow 裁剪） ----
function ensurePop() {
    if (popEl && popEl.isConnected) return popEl;
    popEl = document.createElement('div');
    popEl.id = POP_ID;
    popEl.className = 'set-select-pop';
    popEl.setAttribute('role', 'listbox');
    popEl.setAttribute('aria-label', '选项');
    popEl.tabIndex = -1;
    popEl.addEventListener('keydown', onPopKeydown);
    popEl.addEventListener('mousemove', onPopHover);
    document.body.appendChild(popEl);
    return popEl;
}

function itemNodes() {
    return popEl ? [...popEl.querySelectorAll('.ss-opt')] : [];
}

function refresh(inst) {
    const sel = inst.sel;
    inst.label.textContent = sel.options[sel.selectedIndex]
        ? optionLabelParts(sel.options[sel.selectedIndex]).title : '';
    const disabled = !!sel.disabled;
    inst.btn.disabled = disabled;
    inst.wrap.classList.toggle('is-disabled', disabled);
    if (disabled && active === inst) setSelectCloseAll();
}

function renderOptions(inst) {
    const pop = ensurePop();
    pop.innerHTML = '';
    let group = '';
    [...inst.sel.options].forEach((option, idx) => {
        const parent = option.parentElement;
        const g = parent && parent.tagName === 'OPTGROUP' ? (parent.label || '') : '';
        if (g !== group) {
            group = g;
            if (g) {
                const head = document.createElement('div');
                head.className = 'ss-group';
                head.textContent = g;
                head.setAttribute('role', 'presentation');
                pop.appendChild(head);
            }
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ss-opt' + (option.selected ? ' selected' : '');
        item.id = 'ss-opt-' + idx;
        item.dataset.index = String(idx);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
        item.disabled = !!option.disabled;
        const {title, subtitle} = optionLabelParts(option);
        const text = document.createElement('span');
        text.className = 'ss-label';
        if (subtitle) {
            item.classList.add('ss-opt-rich');
            const main = document.createElement('span');
            main.className = 'ss-main';
            main.textContent = title;
            const sub = document.createElement('span');
            sub.className = 'ss-sub';
            sub.textContent = subtitle;
            text.append(main, sub);
        } else {
            text.textContent = title;
        }
        item.appendChild(text);
        if (option.selected && deps.iconSvg) {
            const check = document.createElement('span');
            check.className = 'ss-check';
            check.innerHTML = deps.iconSvg('check', 12);
            item.appendChild(check);
        }
        item.addEventListener('click', () => pick(inst, idx));
        pop.appendChild(item);
    });
    if (!inst.sel.options.length) {
        const empty = document.createElement('div');
        empty.className = 'ss-empty';
        empty.textContent = '无可用选项';
        pop.appendChild(empty);
    }
}

// ---- 定位 ----
function positionActive() {
    if (!active || !popEl) return;
    const viewport = {width: window.innerWidth, height: window.innerHeight};
    const rect = active.btn.getBoundingClientRect();
    const scroll = popEl.scrollTop;
    popEl.style.maxHeight = 'none';
    popEl.style.width = computePopWidth(rect, viewport) + 'px';
    const natural = popEl.offsetHeight;
    const geo = computePopGeometry(rect, viewport, natural);
    popEl.style.width = geo.width + 'px';
    popEl.style.left = geo.left + 'px';
    popEl.style.top = geo.top + 'px';
    popEl.style.maxHeight = geo.height + 'px';
    popEl.style.overflowY = natural > geo.height + 1 ? 'auto' : 'hidden';
    popEl.scrollTop = scroll; // 重定位不打断列表内部滚动位置
    popEl.classList.toggle('up', geo.up);
    // 几何定稿后才检测截断（滚动条出现会再挤掉几像素宽度），被省略号截断的选项挂 data-tip
    itemNodes().forEach((item) => syncTipFromSpans(item, ['.ss-main, .ss-sub', '.ss-label']));
}

function scheduleReposition() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (active) positionActive();
    });
}

function onViewportChange(e) {
    if (!active) return;
    if (e && e.target === popEl) return; // 面板内部滚动不改位置
    if (!active.wrap.isConnected) { setSelectCloseAll(); return; }
    const r = active.btn.getBoundingClientRect();
    if (!r.width || r.bottom <= SS_POP_LIMITS.edge || r.top >= window.innerHeight - SS_POP_LIMITS.edge) {
        setSelectCloseAll();
        return;
    }
    scheduleReposition();
}

// ---- 键盘 / 焦点 ----
function setActiveIndex(idx, scroll = true) {
    const items = itemNodes();
    if (!items.length) return;
    const next = Math.max(0, Math.min(items.length - 1, idx));
    if (activeIndex === next && items[next].classList.contains('ss-focus')) return;
    activeIndex = next;
    items.forEach((el, i) => el.classList.toggle('ss-focus', i === next));
    const node = items[next];
    if (popEl && node) {
        popEl.setAttribute('aria-activedescendant', node.id);
        if (scroll) {
            const top = node.offsetTop;
            const bottom = top + node.offsetHeight;
            if (top < popEl.scrollTop) popEl.scrollTop = top - 4;
            else if (bottom > popEl.scrollTop + popEl.clientHeight) popEl.scrollTop = bottom - popEl.clientHeight + 4;
        }
    }
}

function moveActive(delta) {
    const items = itemNodes();
    if (!items.length) return;
    let i = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
    for (let n = 0; n < items.length; n++) {
        i = (i + delta + items.length) % items.length;
        if (!items[i].disabled) break;
    }
    setActiveIndex(i);
}

function jumpToEdge(first) {
    const items = itemNodes();
    let idx = -1;
    if (first) idx = items.findIndex((el) => !el.disabled);
    else for (let i = items.length - 1; i >= 0; i--) if (!items[i].disabled) { idx = i; break; }
    if (idx >= 0) setActiveIndex(idx);
}

function typeaheadTo(ch) {
    clearTimeout(typeaheadTimer);
    typeahead += ch.toLowerCase();
    typeaheadTimer = setTimeout(() => { typeahead = ''; }, 600);
    const items = itemNodes();
    const hit = items.findIndex((el) => !el.disabled && el.textContent.trim().toLowerCase().startsWith(typeahead));
    if (hit >= 0) setActiveIndex(hit);
}

function onPopKeydown(e) {
    if (!active) return;
    switch (e.key) {
        case 'ArrowDown': e.preventDefault(); moveActive(1); break;
        case 'ArrowUp': e.preventDefault(); moveActive(-1); break;
        case 'Home': e.preventDefault(); jumpToEdge(true); break;
        case 'End': e.preventDefault(); jumpToEdge(false); break;
        case 'Enter':
        case ' ': {
            e.preventDefault();
            const items = itemNodes();
            const node = items[activeIndex];
            if (node && !node.disabled) pick(active, Number(node.dataset.index));
            break;
        }
        case 'Tab': {
            e.preventDefault();
            const btn = active.btn;
            setSelectCloseAll();
            try { btn.focus({preventScroll: true}); } catch (e2) {}
            break;
        }
        default:
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeaheadTo(e.key);
    }
}

function onPopHover(e) {
    if (!active) return;
    const node = e.target && e.target.closest ? e.target.closest('.ss-opt') : null;
    if (!node || node.disabled) return;
    const items = itemNodes();
    const idx = items.indexOf(node);
    if (idx >= 0) setActiveIndex(idx, false);
}

function onBtnKeydown(inst) {
    return (e) => {
        const sel = inst.sel;
        if (e.key === 'Escape') { setSelectCloseAll(); return; }
        let step = 0;
        if (e.key === 'ArrowDown') step = 1;
        else if (e.key === 'ArrowUp') step = -1;
        else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            const list = [...sel.options];
            if (!list.length) return;
            const idx = e.key === 'Home'
                ? list.findIndex((o) => !o.disabled)
                : list.reduce((acc, o, i) => (!o.disabled ? i : acc), 0);
            if (idx >= 0 && list[idx] && !list[idx].disabled) {
                sel.selectedIndex = idx;
                sel.dispatchEvent(new Event('change', {bubbles: true}));
            }
            return;
        }
        if (!step) return;
        // 关闭状态下的 ↑↓ 沿用旧习惯：直接换值并派发 change
        e.preventDefault();
        let idx = sel.selectedIndex < 0 ? (step > 0 ? -1 : 0) : sel.selectedIndex;
        for (let n = 0; n < sel.options.length; n++) {
            idx = (idx + step + sel.options.length) % sel.options.length;
            if (!sel.options[idx].disabled) break;
        }
        if (idx !== sel.selectedIndex) {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('change', {bubbles: true}));
        }
    };
}

// ---- 值提交 / 开合 ----
function pick(inst, idx) {
    const option = inst.sel.options[idx];
    if (!option || option.disabled) return;
    if (inst.sel.value !== option.value) {
        inst.sel.value = option.value;
        inst.sel.dispatchEvent(new Event('change', {bubbles: true}));
    }
    setSelectCloseAll();
    try { inst.btn.focus({preventScroll: true}); } catch (e) {}
}

function openInstance(inst) {
    if (inst.btn.disabled) return;
    if (active === inst) { setSelectCloseAll(); return; }
    const r = inst.btn.getBoundingClientRect();
    // 触发器滚出视口（例如程序化 click 到隐藏行的下拉）时不打开，避免浮层飘在窗口外
    if (!r.width || r.bottom <= SS_POP_LIMITS.edge || r.top >= window.innerHeight - SS_POP_LIMITS.edge) {
        setSelectCloseAll();
        return;
    }
    setSelectCloseAll();
    active = inst;
    activeIndex = -1;
    typeahead = '';
    inst.wrap.classList.add('open');
    inst.btn.setAttribute('aria-expanded', 'true');
    inst.sel.dataset.ssOpen = '1';
    const pop = ensurePop();
    renderOptions(inst);
    pop.classList.add('open');
    pop.style.visibility = 'hidden';
    positionActive();
    pop.style.visibility = '';
    setActiveIndex(Math.max(0, inst.sel.selectedIndex), false);
    document.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    try { pop.focus({preventScroll: true}); } catch (e) {}
}

function setSelectCloseAll(except) {
    if (except && active && active.wrap === except) return;
    const inst = active;
    document.querySelectorAll('.set-select.open').forEach((wrap) => wrap.classList.remove('open'));
    document.querySelectorAll('.set-select-btn[aria-expanded="true"]').forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
    if (popEl) {
        popEl.classList.remove('open');
        popEl.removeAttribute('aria-activedescendant');
        popEl.innerHTML = '';
        popEl.style.visibility = '';
    }
    document.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    clearTimeout(typeaheadTimer);
    active = null;
    activeIndex = -1;
    if (inst) {
        inst.sel.dataset.ssOpen = '';
        inst.wrap.classList.remove('open');
    }
    instances.forEach((i) => { i.sel.dataset.ssOpen = ''; i.btn.setAttribute('aria-expanded', 'false'); });
}

// ---- 增强：把 select 替换为触发器 + 浮层（原生 select 仍是值真源，change 照常从它派发） ----
// 单个 select 的增强（幂等）。设置页扫描器与设置页之外的域（如全局搜索，经 main.js deps
// 注入 enhanceSelect）共用这一条路径；wrap 继承原 select 的布局类，外观类需各域自行适配。
function enhanceSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT') return null;
    if (sel.dataset.setSelect === '1' || sel.multiple || sel.size > 1) return null;
    sel.dataset.setSelect = '1';
    const wrap = document.createElement('div');
    // 继承原 select 的布局类（.opt-select / .set-control .opt-select 的宽度与 flex 规则）
    wrap.className = 'set-select ' + [...sel.classList].filter((c) => c !== 'set-select-native').join(' ');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'set-select-btn';
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', POP_ID);
    const aLabel = sel.getAttribute('aria-label') || sel.title || '';
    if (aLabel) btn.setAttribute('aria-label', aLabel);
    btn.innerHTML = '<span class="ss-label"></span><span class="ss-chev"></span>';
    if (deps.iconSvg) btn.querySelector('.ss-chev').innerHTML = deps.iconSvg('chevron-down', 12);
    wrap.appendChild(btn);
    sel.classList.add('set-select-native');
    sel.after(wrap);
    const inst = {sel, wrap, btn, label: btn.querySelector('.ss-label'), observer: null};
    btn.addEventListener('click', () => openInstance(inst));
    btn.addEventListener('keydown', onBtnKeydown(inst));
    // 触发器显示值被省略号截断时，hover / 键盘聚焦给完整 tooltip。
    // mouseover 先于 document 上的委托监听（冒泡顺序），data-tip 挂好后气泡才读得到；
    // 下拉展开期间不挂（列表即将出现，气泡反而挡视线）。无截断则移除，未截断的选项不弹气泡。
    const syncBtnTip = () => {
        if (btn.getAttribute('aria-expanded') === 'true') { btn.removeAttribute('data-tip'); return; }
        syncTipFromSpans(btn, ['.ss-label']);
    };
    btn.addEventListener('mouseover', syncBtnTip);
    btn.addEventListener('focus', syncBtnTip);
    sel.addEventListener('change', () => refresh(inst));
    inst.observer = new MutationObserver((records) => {
        refresh(inst);
        if (active === inst) {
            renderOptions(inst);
            positionActive();
            setActiveIndex(Math.max(0, inst.sel.selectedIndex), false);
        }
    });
    inst.observer.observe(sel, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['disabled'],
    });
    instances.add(inst);
    refresh(inst);
    return inst;
}

function enhanceSetSelects() {
    // 切到别的设置页时原触发器虽还在 DOM 里但已 display:none，浮层必须跟着收起
    if (active && active.wrap && (!active.wrap.isConnected || !active.wrap.getClientRects().length)) setSelectCloseAll();
    // 动态面板（格式总览等）每次重建都会留下旧节点，顺手回收 observer
    instances.forEach((inst) => {
        if (!inst.wrap.isConnected) {
            inst.observer.disconnect();
            instances.delete(inst);
        }
    });
    document.querySelectorAll('.settings-pane select').forEach(enhanceSelect);
    if (!window.__setSelectDelegated) {
        window.__setSelectDelegated = true;
        // 外点关闭（浮层在 body 上，必须把它一并算作「内部」）
        document.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.set-select, .set-select-pop')) return;
            setSelectCloseAll();
        });
        // Esc 全局兜底：设置对话框被 Esc 关掉时浮层不能留在 body 上
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !active) return;
            const btn = active.btn;
            const restore = !!popEl && document.activeElement === popEl;
            setSelectCloseAll();
            if (restore) { try { btn.focus({preventScroll: true}); } catch (e2) {} }
        }, true);
    }
}

return {enhanceSetSelects, enhanceSelect, setSelectCloseAll};
}
