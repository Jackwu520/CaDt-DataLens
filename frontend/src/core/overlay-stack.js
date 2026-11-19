// overlay-stack.js：全局弹层栈——所有浮层（对话框/模态/popover/菜单/灯箱）的唯一注册口。
// 职责两件：① Esc 栈序分发（唯一 window 捕获监听，装得最早，一次 Esc 只退栈顶层）；
// ② z-index 档位分配（open 写内联、dispose 清除，style.css 不再手写弹层 z-index）。
// 档位表（低→高）：bar 100 < lightbox 1100 < dialog 2100 < modal 3100 < popover 4100 < menu 5100；
// 同档内按栈序自然后开在上。不进栈的常驻层：tooltip 9999、.app-toasts 6000，其余非栈层压在 1000 以下。
// 元素级 Esc 语义 ≠「关所在层」的输入框（如设置搜索框清词不关窗）打 data-esc-local 标记让路；
// Shift+Escape 仍归 view.closeDockPanel，栈不接管。

// 档位基准：间距 1000，容纳同档多层（栈位上限 899 不越档）。
const OVERLAY_TIERS = Object.freeze({
    bar: 100,        // 非模态工具条（查找条），须低于一切遮罩
    lightbox: 1100,  // 图片灯箱（面板内覆盖，低于对话框遮罩）
    dialog: 2100,    // 共享遮罩对话框族（#dialog-mask + 成员）
    modal: 3100,     // 独立遮罩模态（模型/环境变量编辑器、gs/jp/diff/js、git-graph、AI 弹窗）
    popover: 4100,   // 无遮罩浮层（设置下拉、标题栏、状态栏、AI 面板 pop；实证须压过 dialog/modal）
    menu: 5100,      // 右键菜单/下拉（可出现在任何层之上，仅次于 tooltip）
});

const TIER_STEP_CAP = 899; // 同档栈位偏移上限，防止越进上一档

function createOverlayStack() {
    const entries = [];
    let installed = false;

    // 元素探活：已断开 DOM 或被 .hidden 藏起的条目视为死层，Esc 时顺手清除（自愈泄漏）。
    function defaultIsAlive(entry) {
        const el = entry.el;
        if (!el) return true; // 无元素托管的纯逻辑层只靠 dispose 收口
        if (el.isConnected === false) return false;
        if (el.classList && el.classList.contains('hidden')) return false;
        return true;
    }

    // 记录并写入内联 z-index；dispose 时还原（原先没有内联值就移除，恢复 CSS 兜底）。
    function applyZ(el, z) {
        if (!el || !el.style) return;
        if (el.__overlayPrevZ === undefined) {
            el.__overlayPrevZ = el.style.getPropertyValue('z-index');
        }
        el.style.setProperty('z-index', String(z));
    }

    function restoreZ(el) {
        if (!el || !el.style) return;
        const prev = el.__overlayPrevZ;
        if (prev) el.style.setProperty('z-index', prev);
        else el.style.removeProperty('z-index');
        delete el.__overlayPrevZ;
    }

    // data-esc-local 让路：焦点落在顶层子树内带标记的元素上时，Esc 语义归元素自己（如清搜索词）。
    function escLocalInside(e, entry) {
        const t = e && e.target;
        if (!t || typeof t.closest !== 'function') return false;
        const el = entry.el;
        if (!el || typeof el.contains !== 'function') return false;
        const local = t.closest('[data-esc-local]');
        return !!local && el.contains(local);
    }

    function safeClose(entry) {
        try {
            return entry.onClose();
        } catch (err) {
            // 关闭回调异常时按已消费处理，避免一次 Esc 连环触发多层（错误照常上报不吞）
            console.error('[overlay-stack] onClose 执行失败', err);
            return true;
        }
    }

    // 从栈顶向下找第一个可消费的层：跳过已让路（passed）与死层（顺手剔除，自愈泄漏）。
    function findTopViable(passed) {
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (passed.has(entry)) continue;
            const alive = entry.isAlive ? entry.isAlive(entry) : defaultIsAlive(entry);
            if (!alive) {
                entries.splice(i, 1);
                continue;
            }
            return entry;
        }
        return null;
    }

    function dispatchEscape(e) {
        if (!e || e.key !== 'Escape') return false;
        // Shift+Escape 归 view.closeDockPanel；输入法组合态的 Esc 不算关闭意图
        if (e.defaultPrevented || e.shiftKey || e.isComposing) return false;
        const passed = new Set();
        for (;;) {
            const entry = findTopViable(passed);
            if (!entry) return false;
            // data-esc-local 只对真实顶层生效：焦点在顶层子树的标记元素里时，Esc 语义归元素自己
            if (passed.size === 0 && entry.consumesEsc !== false && escLocalInside(e, entry)) {
                return false;
            }
            if (entry.consumesEsc === false) {
                passed.add(entry);
                continue;
            }
            // onClose 返回 false = 该层让路（如 quick-switch 先回上级再回到本层），传给下一层
            const handled = safeClose(entry);
            if (handled === false) {
                passed.add(entry);
                continue;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            return true;
        }
    }

    return {
        /**
         * 注册一个弹层。所有关闭路径（按钮/遮罩点击/外点/blur/resize）都应收口到 handle.dispose()。
         * @param {{id:string, kind:string, el:HTMLElement=, underEl:HTMLElement=, onClose:Function, consumesEsc:boolean=, isAlive:Function=}} desc
         * @returns {{dispose:Function, entry:Object}}
         */
        open(desc) {
            if (!desc || typeof desc.onClose !== 'function') {
                throw new Error('[overlay-stack] open 需要 onClose 回调');
            }
            const kind = OVERLAY_TIERS[desc.kind] !== undefined ? desc.kind : 'popover';
            const entry = {
                id: desc.id || '',
                kind,
                el: desc.el || null,
                underEl: desc.underEl || null,
                onClose: desc.onClose,
                consumesEsc: desc.consumesEsc !== false,
                isAlive: typeof desc.isAlive === 'function' ? desc.isAlive : null,
            };
            entries.push(entry);
            // underEl（遮罩）钉在档位地板；el 压在地板之上、按栈位排序
            applyZ(entry.underEl, OVERLAY_TIERS[kind]);
            applyZ(entry.el, OVERLAY_TIERS[kind] + 1 + Math.min(entries.length - 1, TIER_STEP_CAP));
            const handle = {
                entry,
                dispose() {
                    const at = entries.indexOf(entry);
                    if (at >= 0) entries.splice(at, 1);
                    // 共享遮罩（如设置对话框族的 #dialog-mask）还有其他条目引用时保留内联 z
                    const underShared = entry.underEl &&
                        entries.some((other) => other.underEl === entry.underEl);
                    if (!underShared) restoreZ(entry.underEl);
                    restoreZ(entry.el);
                },
            };
            entry.handle = handle;
            return handle;
        },
        /** 栈顶条目（不含 handle），空栈返回 null。 */
        top() {
            return entries.length ? entries[entries.length - 1] : null;
        },
        has(id) {
            return entries.some((entry) => entry.id === id);
        },
        size() {
            return entries.length;
        },
        /** 档位基准值，供遮罩兄弟层、ctx 子菜单（menuZ + 1 + depth）等特例取基准。 */
        tierZ(kind) {
            return OVERLAY_TIERS[kind] !== undefined ? OVERLAY_TIERS[kind] : OVERLAY_TIERS.popover;
        },
        /**
         * Esc 分发：消费返回 true 并 stopImmediatePropagation（装得最早，可靠抢占一切旧监听）；
         * 不消费返回 false，事件照旧流向旧监听（未迁移层与元素级语义的兜底通道）。
         */
        dispatchEscape,
        /** 安装唯一的全局 Esc 监听（window 捕获）。幂等；必须在任何弹层工厂创建之前调用。 */
        install(target) {
            if (installed || !target || typeof target.addEventListener !== 'function') return;
            installed = true;
            target.addEventListener('keydown', (e) => {
                dispatchEscape(e);
            }, true);
        },
    };
}

// 全局单例：仿 keymap.js 先例，域模块直接 import，免穿线 deps。
export const overlayStack = createOverlayStack();
export { createOverlayStack, OVERLAY_TIERS };
