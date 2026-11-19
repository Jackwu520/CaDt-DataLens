import {iconSvg, renderMenuIcon} from '../core/icons.js';
import {overlayStack} from '../core/overlay-stack.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

// 菜单左上角定位（纯函数，便于单测）：anchorAbove 有值时菜单底边贴锚点顶边（留 gap），
// 否则用调用方给的 x / y；最后统一夹进视口（menus 比视口还大时靠 margin 兜底）。
export function computeMenuPosition(opts) {
    const {x, y, width, height, viewportWidth, viewportHeight, margin, anchorAbove, gap = 6} = opts;
    let left = anchorAbove ? anchorAbove.left : x;
    let top = anchorAbove ? anchorAbove.top - height - gap : y;
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    return {left, top};
}

// —— 子菜单预测锥（hover-intent cone，Amazon 菜单同款）——
// 斜向移向子菜单必然扫过兄弟行，兄弟行的 mouseenter 原本会立即收起子菜单。
// 预测锥 = 「子菜单近边两端角 + 父项行对侧底角」的三角走廊 ∪ 父项行 ∪ 子菜单面板；
// 指针在锥内视为正走向子菜单，收起延迟一小段（继续移动会不断顺延）；
// 锥外（明确去点别的项）立即收起。菜单与子菜单水平紧贴，走廊三角必须以父项行的
// 对侧边为起点才能罩住菜单内部的斜向路径。
export const SUBMENU_CONE_CLOSE_DELAY_MS = 250;

export function pointInRect(px, py, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
}

// 叉积同号法：点在三角形内（含边界）返回 true；退化（零面积）三角形一律 false。
function pointInTriangle(px, py, a, b, c) {
    const cross = (p, q) => (q.x - p.x) * (py - p.y) - (q.y - p.y) * (px - p.x);
    const s1 = cross(a, b), s2 = cross(b, c), s3 = cross(c, a);
    const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
    const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
    return !(hasNeg && hasPos);
}

// 预测锥判定（纯函数，rect 接受 DOMRect 或同字段普通对象）：
// 子菜单贴着父菜单哪一侧就取哪条近边，父项行取对侧底角作走廊起点（左右开均镜像成立）。
export function inSubmenuCone(px, py, anchorRect, subRect) {
    if (pointInRect(px, py, anchorRect) || pointInRect(px, py, subRect)) return true;
    if (!subRect || subRect.width <= 0 || subRect.height <= 0) return false;
    const rightSide = (subRect.left + subRect.width / 2) >= (anchorRect.left + anchorRect.width / 2);
    const nearX = rightSide ? subRect.left : subRect.right;
    const farX = rightSide ? anchorRect.left : anchorRect.right;
    return pointInTriangle(px, py,
        {x: nearX, y: subRect.top},
        {x: nearX, y: subRect.bottom},
        {x: farX, y: anchorRect.bottom});
}

export function createContextMenu() {
    const root = el('div', 'ctx-menu hidden');
    document.body.appendChild(root);
    let panels = [root];
    let isOpen = false;
    let openOptions = {};
    // 实例的弹层栈条目与本次打开的菜单基准 z（子菜单在其上逐层 +1）
    let stackHandle = null;
    let menuBaseZ = 0;
    // 最近一次按下 / 右键的目标：open() 时作为菜单锚点，用来判断滚动是否与菜单有关。
    let lastPointerTarget = null;
    // 预测锥状态：subOpen[depth] 记住该层打开的子菜单（锚点行 + 面板）；
    // pendingCloses[depth] 是锥内触发的挂起收起；lastMouse 供到点复核用。
    const subOpen = {};
    const pendingCloses = new Map();
    const lastMouse = {x: null, y: null};

    document.addEventListener('mousemove', (e) => {
        lastMouse.x = e.clientX;
        lastMouse.y = e.clientY;
    }, true);

    function cancelPendingClose(depth) {
        const timer = pendingCloses.get(depth);
        if (timer !== undefined) {
            clearTimeout(timer);
            pendingCloses.delete(depth);
        }
    }

    function closeDeeper(depth) {
        for (const key of pendingCloses.keys()) {
            if (key >= depth) cancelPendingClose(key);
        }
        while (panels.length > depth + 1) {
            delete subOpen[panels.length - 2];
            const panel = panels.pop();
            panel.remove();
        }
    }

    function close() {
        const onClose = openOptions.onClose;
        closeDeeper(0);
        if (stackHandle) {
            stackHandle.dispose();
            stackHandle = null;
        }
        root.classList.add('hidden');
        root.textContent = '';
        isOpen = false;
        openOptions = {};
        if (typeof onClose === 'function') {
            try { onClose(); } catch (e) {}
        }
    }

    function place(panel, x, y, options) {
        panel.classList.remove('hidden');
        panel.style.left = '0px';
        panel.style.top = '0px';
        panel.style.maxHeight = '';
        panel.style.overflowY = '';
        let width = panel.offsetWidth;
        let height = panel.offsetHeight;
        const margin = 8;
        // 菜单比视口还高时限制高度并内部滚动，避免被窗口截断
        const maxH = window.innerHeight - margin * 2;
        if (height > maxH) {
            panel.style.maxHeight = maxH + 'px';
            panel.style.overflowY = 'auto';
            height = maxH;
            width = panel.offsetWidth;
        }
        // 上翻锚定（options.anchorAbove）：菜单底边贴锚点顶边。菜单高度随描述行数 / 缩放变化，
        // 调用方算不出偏移，必须等渲染完拿到实测高度再定（权限胶囊原先写死 top - 280，实测高度
        // 不同就会飘出一大截空档）。
        const anchorRect = options && options.anchorAbove && options.anchor && options.anchor.nodeType === 1
            ? options.anchor.getBoundingClientRect()
            : null;
        const pos = computeMenuPosition({
            x,
            y,
            width,
            height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            margin,
            anchorAbove: anchorRect,
        });
        panel.style.left = pos.left + 'px';
        panel.style.top = pos.top + 'px';
    }

    function placeSubmenu(panel, anchor) {
        panel.classList.remove('hidden');
        panel.style.left = '0px';
        panel.style.top = '0px';
        panel.style.maxHeight = '';
        panel.style.overflowY = '';
        const rect = anchor.getBoundingClientRect();
        let width = panel.offsetWidth;
        let height = panel.offsetHeight;
        const margin = 8;
        const maxH = window.innerHeight - margin * 2;
        if (height > maxH) {
            panel.style.maxHeight = maxH + 'px';
            panel.style.overflowY = 'auto';
            height = maxH;
            width = panel.offsetWidth;
        }
        let left = rect.right + 2;
        if (left + width > window.innerWidth - margin) left = rect.left - width - 2;
        left = Math.max(margin, left);
        let top = rect.top - 4;
        if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
        top = Math.max(margin, top);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    function openSubmenu(anchor, items, depth) {
        closeDeeper(depth);
        const panel = el('div', 'ctx-menu ctx-sub');
        // 子菜单压在本实例菜单之上逐层 +1（基准由弹层栈在 open 时分配）
        panel.style.zIndex = String(menuBaseZ + depth + 1);
        panels.push(panel);
        subOpen[depth] = {anchor, panel};
        document.body.appendChild(panel);
        render(panel, items, depth + 1);
        placeSubmenu(panel, anchor);
        // 进入子菜单面板：取消该层挂起的延迟收起
        panel.addEventListener('mouseenter', () => cancelPendingClose(depth));
    }

    // 兄弟行 mouseenter：该层有打开的子菜单且指针在其预测锥内时，改为延迟收起
    //（斜向走向子菜单的路上扫过兄弟行不至于把子菜单杀掉）；锥外立即收起。
    function maybeCloseDeeper(depth, e) {
        const open = subOpen[depth];
        const px = e && typeof e.clientX === 'number' ? e.clientX : lastMouse.x;
        const py = e && typeof e.clientY === 'number' ? e.clientY : lastMouse.y;
        if (!open || px == null || py == null ||
            !inSubmenuCone(px, py, open.anchor.getBoundingClientRect(), open.panel.getBoundingClientRect())) {
            closeDeeper(depth);
            return;
        }
        cancelPendingClose(depth);
        pendingCloses.set(depth, setTimeout(() => {
            pendingCloses.delete(depth);
            const cur = subOpen[depth];
            if (!cur) return;
            // 到点复核：指针已进子菜单面板或回到锚点行则放行，仍停在兄弟行上才收
            if (lastMouse.x != null && (pointInRect(lastMouse.x, lastMouse.y, cur.panel.getBoundingClientRect()) ||
                pointInRect(lastMouse.x, lastMouse.y, cur.anchor.getBoundingClientRect()))) return;
            closeDeeper(depth);
        }, SUBMENU_CONE_CLOSE_DELAY_MS));
    }

    // 胶囊徽标（如权限菜单「自动审批」旁的 AI 标识）：item.badge 为短文本，
    // item.badgeIcon 为纯图标徽标（无文字）；两者可并存并排渲染。
    function renderBadge(item) {
        if (!item.badge && !item.badgeIcon) return null;
        const badge = el('span', 'mi-badge');
        badge.innerHTML = iconSvg(item.badgeIcon || 'sparkles', 9);
        if (item.badge) badge.appendChild(el('span', 'mi-badge-text', String(item.badge)));
        return badge;
    }

    function render(panel, items, depth) {
        for (const item of items || []) {
            if (item.sep) {
                panel.appendChild(el('div', 'menu-sep'));
                continue;
            }
            const rich = !!item.description;
            const badge = renderBadge(item);
            const row = el('button', 'menu-item ctx-item' + (rich ? ' ctx-rich' : '') +
                (item.disabled ? ' disabled' : '') + (item.danger ? ' danger' : ''));
            row.type = 'button';
            const icon = el('span', 'mi-icon');
            renderMenuIcon(icon, rich ? {...item, checked: false} : item);
            const label = el('span', 'mi-label', item.label);
            const key = el('span', 'mi-key', item.shortcut || '');
            if (rich) {
                const text = el('span', 'mi-text');
                if (badge) {
                    const line = el('span', 'mi-line');
                    line.append(label, badge);
                    text.append(line, el('span', 'mi-desc', item.description));
                } else {
                    text.append(label, el('span', 'mi-desc', item.description));
                }
                row.append(icon, text, key);
                if (item.selected || item.checked) {
                    const check = el('span', 'mi-check');
                    check.innerHTML = iconSvg('check', 14);
                    row.appendChild(check);
                }
            } else {
                row.append(icon, label);
                if (badge) row.appendChild(badge);
                row.append(key);
            }
            if (item.submenu && item.submenu.length) {
                const arrow = el('span', 'ctx-arrow');
                arrow.innerHTML = iconSvg('chevron-right', 10);
                row.appendChild(arrow);
                row.addEventListener('mouseenter', () => {
                    if (!item.disabled) openSubmenu(row, item.submenu, depth);
                });
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!item.disabled) openSubmenu(row, item.submenu, depth);
                });
            } else {
                row.addEventListener('mouseenter', (e) => maybeCloseDeeper(depth, e));
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (item.disabled) return;
                    close();
                    item.action();
                });
            }
            panel.appendChild(row);
        }
    }

    function open(items, x, y, options) {
        close();
        isOpen = true;
        openOptions = options || {};
        // 锚点：显式传了 anchor 就用它，否则退回「刚刚按下的元素」。
        openOptions._origin = openOptions.anchor || lastPointerTarget;
        lastPointerTarget = null;
        render(root, items, 0);
        place(root, x == null ? 24 : x, y == null ? 24 : y, openOptions);
        // 进全局弹层栈：菜单可出现在任何层之上（dialog/modal/popover 皆然），Esc 先退菜单
        stackHandle = overlayStack.open({
            id: 'ctx-menu', kind: 'menu', el: root,
            onClose: () => { close(); return true; },
        });
        menuBaseZ = Number(root.style.getPropertyValue('z-index')) || overlayStack.tierZ('menu') + 1;
    }

    document.addEventListener('pointerdown', (e) => {
        lastPointerTarget = e.target;
        if (!isOpen) return;
        if (e.target.closest && e.target.closest('.ctx-menu')) return;
        close();
    }, true);
    document.addEventListener('contextmenu', (e) => {
        lastPointerTarget = e.target;
    }, true);
    // 菜单的 Esc 已归全局弹层栈（open 注册，menu 档在栈顶时先退菜单）
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', (e) => {
        if (!isOpen) return;
        const target = e.target;
        if (target && target.closest && target.closest('.ctx-menu')) return;
        // AI 流式输出会自动滚动消息区；面板内菜单不应因此被关闭
        if (openOptions.ignoreScrollWithin && target && target.closest && target.closest(openOptions.ignoreScrollWithin)) return;
        // 只有「滚动到菜单锚点所在的那个容器」才关菜单：别处的滚动（AI 面板输出、
        // 侧边栏、另一个编辑器分组……）跟这个菜单没关系，不该把它关掉。
        const origin = openOptions._origin;
        if (origin && origin.nodeType === 1 && target && target.nodeType === 1) {
            if (target === origin || (target.contains && target.contains(origin))) close();
            return;
        }
        close();
    }, true);

    // 菜单条下拉的子菜单复用本实例打开（openDropdownSubmenu），预测锥判定需要
    // 读它的开关状态与根元素矩形；实例内嵌套子菜单的锥逻辑在 maybeCloseDeeper。
    return {open, close, isOpen: () => isOpen, rootEl: () => root};
}
