// ui-kit.js：应用页面（外部工具 / 定时任务 / 操作记录 / 补丁库）共用的视觉原子。
//
// 只抽公共原子，不强制四页同构（用户 2026-11-22 取舍：各页定制，只统一视觉 token）。
// 纯 DOM 工厂：不 import 任何域模块，域模块可单向依赖本文件；依赖 core/ 的
// form-controls / icons / overlay-stack 三件既有设施，不引入任何新依赖。
//
// 约定：
// - 所有控件走 core/form-controls.js 工厂，不写裸原生控件。
// - 图标走 core/icons.js 的 iconSvg()，不内联 SVG。
// - 页面级浮层（detailDrawer）经 overlay-stack 注册，Esc 由栈序分发，不自挂全局监听。
// - 颜色只用主题变量（--panel2/--border/--text/--muted/--accent/--on-accent/--green/--red/--warn）。

import {createInput} from '../core/form-controls.js';
import {iconSvg} from '../core/icons.js';
import {overlayStack} from '../core/overlay-stack.js';

/**
 * 页头：标题 + 一句话说明 + 右侧主操作区。
 * @param {{title:string, desc?:string, actions?:HTMLElement[]}} o
 * @returns {HTMLElement}
 */
export function pageHeader(o = {}) {
    const head = document.createElement('div');
    head.className = 'ap-head';
    const main = document.createElement('div');
    main.className = 'ap-head-main';
    const title = document.createElement('div');
    title.className = 'ap-head-title';
    title.textContent = String(o.title || '');
    main.appendChild(title);
    if (o.desc) {
        const desc = document.createElement('div');
        desc.className = 'ap-head-desc';
        desc.textContent = String(o.desc);
        main.appendChild(desc);
    }
    head.appendChild(main);
    if (Array.isArray(o.actions) && o.actions.length) {
        const actions = document.createElement('div');
        actions.className = 'ap-head-actions';
        for (const el of o.actions) if (el) actions.appendChild(el);
        head.appendChild(actions);
    }
    return head;
}

/**
 * 状态徽标。tone ∈ success | warn | danger | neutral。
 * @param {string} text
 * @param {string} [tone]
 * @returns {HTMLElement}
 */
export function statusBadge(text, tone = 'neutral') {
    const el = document.createElement('span');
    const safeTone = ['success', 'warn', 'danger', 'neutral'].includes(tone) ? tone : 'neutral';
    el.className = 'ap-badge ap-badge-' + safeTone;
    el.textContent = String(text == null ? '' : text);
    return el;
}

/**
 * 命令栏：搜索框（防抖）+ 筛选区 + 右侧动作区。
 * 返回 {element, input, setSearch}，setSearch 用于外部重置搜索词（不触发回调）。
 * @param {{placeholder?:string, debounceMs?:number, onSearch?:(v:string)=>void,
 *          filters?:HTMLElement[], actions?:HTMLElement[]}} o
 */
export function commandBar(o = {}) {
    const bar = document.createElement('div');
    bar.className = 'ap-cmdbar';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'ap-cmd-search';
    // 搜索图标：iconSvg 默认 14px，放进 16 网格的容器里尺寸合适
    searchWrap.insertAdjacentHTML('afterbegin', iconSvg('search', 14));
    const {element: input, control} = createInput({
        type: 'search',
        placeholder: String(o.placeholder || '搜索'),
        className: 'dlg-input ap-cmd-input',
        attrs: {'aria-label': String(o.placeholder || '搜索')},
    });
    searchWrap.appendChild(input);
    bar.appendChild(searchWrap);

    let timer = 0;
    const debounceMs = Number(o.debounceMs) >= 0 ? Number(o.debounceMs) : 200;
    control.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (typeof o.onSearch === 'function') o.onSearch(control.value.trim());
        }, debounceMs);
    });

    if (Array.isArray(o.filters) && o.filters.length) {
        const filters = document.createElement('div');
        filters.className = 'ap-cmd-filters';
        for (const el of o.filters) if (el) filters.appendChild(el);
        bar.appendChild(filters);
    }
    if (Array.isArray(o.actions) && o.actions.length) {
        const actions = document.createElement('div');
        actions.className = 'ap-cmd-actions';
        for (const el of o.actions) if (el) actions.appendChild(el);
        bar.appendChild(actions);
    }

    return {
        element: bar,
        input: control,
        setSearch(v = '', fire = false) {
            clearTimeout(timer);
            control.value = String(v || '');
            if (fire && typeof o.onSearch === 'function') o.onSearch(control.value.trim());
        },
        destroy() { clearTimeout(timer); },
    };
}

/**
 * 筛选 chips：一组单选按钮，点击切换 active 并回调。
 * @param {{items:Array<{value:string,label:string}>, value?:string, onChange?:(v:string)=>void}} o
 * @returns {{element:HTMLElement, setValue:(v:string)=>void}}
 */
export function filterChips(o = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'ap-chips';
    let current = String(o.value == null ? '' : o.value);
    const buttons = [];

    function setValue(v) {
        current = String(v == null ? '' : v);
        for (const b of buttons) b.classList.toggle('active', b.dataset.value === current);
    }
    for (const item of (o.items || [])) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ap-chip';
        btn.dataset.value = String(item.value);
        btn.textContent = String(item.label);
        btn.addEventListener('click', () => {
            setValue(item.value);
            if (typeof o.onChange === 'function') o.onChange(String(item.value));
        });
        buttons.push(btn);
        wrap.appendChild(btn);
    }
    setValue(current);
    return {element: wrap, setValue};
}

/**
 * 状态块：空态 / 加载 / 错误 / 旧后端降级。kind ∈ empty | loading | error | info。
 * @param {string} kind
 * @param {string} text
 * @param {HTMLElement} [action] 可选 CTA
 * @returns {HTMLElement}
 */
export function stateBlock(kind, text, action) {
    const el = document.createElement('div');
    const safeKind = ['empty', 'loading', 'error', 'info'].includes(kind) ? kind : 'info';
    el.className = 'ap-state ap-state-' + safeKind;
    const label = document.createElement('span');
    label.className = 'ap-state-text';
    label.textContent = String(text || '');
    el.appendChild(label);
    if (action) el.appendChild(action);
    return el;
}

/**
 * 详情抽屉：右侧滑出面板，经 overlay-stack 注册（Esc 栈序关闭）。
 * 返回 {element, close, handle}；调用方负责 element 的挂载位置与 destroy。
 * @param {{title?:string, onClose?:()=>void, content?:HTMLElement}} o
 */
export function detailDrawer(o = {}) {
    const el = document.createElement('div');
    el.className = 'ap-drawer';
    const head = document.createElement('div');
    head.className = 'ap-drawer-head';
    const title = document.createElement('div');
    title.className = 'ap-drawer-title';
    title.textContent = String(o.title || '详情');
    head.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dlg-icon-btn ap-drawer-close';
    closeBtn.dataset.tip = '关闭（Esc）';
    closeBtn.setAttribute('aria-label', '关闭详情');
    closeBtn.insertAdjacentHTML('afterbegin', iconSvg('close', 14));
    head.appendChild(closeBtn);
    const body = document.createElement('div');
    body.className = 'ap-drawer-body';
    if (o.content) body.appendChild(o.content);
    el.append(head, body);

    let disposed = false;
    const handle = overlayStack.open({
        id: 'app-page-drawer-' + Math.random().toString(36).slice(2, 8),
        kind: 'popover',
        el,
        onClose() {
            close();
            return true;
        },
    });
    function close() {
        if (disposed) return;
        disposed = true;
        handle.dispose();
        if (typeof o.onClose === 'function') o.onClose();
        if (el.parentNode) el.parentNode.removeChild(el);
    }
    closeBtn.addEventListener('click', close);
    return {element: el, body, close, handle};
}

/** 完整时间（含年份）：YYYY-MM-DD HH:mm:ss。 */
export function formatFullTime(ts) {
    const d = ts instanceof Date ? ts : new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 完整时间。 */
export function relativeTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return '—';
    const diff = Date.now() - t;
    if (diff < 0) return formatFullTime(t);
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
    if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
    return formatFullTime(t);
}

/**
 * 复制按钮：点击把 text 写入剪贴板并 flash 反馈。
 * @param {() => string} getText
 * @param {{flash?:(msg:string,isError?:boolean)=>void, label?:string, tip?:string}} [o]
 */
export function copyButton(getText, o = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dlg-icon-btn ap-copy-btn';
    btn.dataset.tip = String(o.tip || '复制');
    btn.setAttribute('aria-label', String(o.tip || '复制'));
    btn.insertAdjacentHTML('afterbegin', iconSvg('copy', 13));
    if (o.label) btn.appendChild(document.createTextNode(' ' + String(o.label)));
    btn.addEventListener('click', async () => {
        const text = typeof getText === 'function' ? String(getText() || '') : '';
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
            else throw new Error('clipboard 不可用');
            if (typeof o.flash === 'function') o.flash('已复制');
        } catch (err) {
            if (typeof o.flash === 'function') o.flash('复制失败', true);
        }
    });
    return btn;
}

/**
 * 图标动作按钮：统一 data-tip + aria-label，消除「只有图标没有语义」的问题。
 * @param {{icon:string, tip:string, onClick:()=>void, danger?:boolean, label?:string}} o
 */
export function iconButton(o = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dlg-icon-btn ap-icon-btn' + (o.danger ? ' ap-icon-btn-danger' : '');
    btn.dataset.tip = String(o.tip || '');
    btn.setAttribute('aria-label', String(o.tip || ''));
    btn.insertAdjacentHTML('afterbegin', iconSvg(String(o.icon || 'info'), 14));
    if (o.label) btn.appendChild(document.createTextNode(' ' + String(o.label)));
    if (typeof o.onClick === 'function') btn.addEventListener('click', o.onClick);
    return btn;
}
