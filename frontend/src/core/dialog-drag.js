// dialog-drag.js：对话框头部拖动——把原先埋在 writing-mode.js 的 startDialogDrag 抽成独立纯模块。
// 用 document 级事件委托，动态创建的弹窗（含 AI 弹窗）也自动获得拖动能力，不再依赖初始化时的
// querySelectorAll 静态快照。定位策略：首次按下时把目标归一到 fixed + 像素 left/top，其后用增量位移；
// 关闭后归位由各弹窗自己的 open 流程负责（.dialog 族在 openDialogEl，AI 弹窗在 openAIDialog）。

/**
 * 创建一组对话框拖动处理器。
 * @param {Array<{handle:string, exclude?:string, targetOf?:Function, clearTransform?:boolean}>} rules
 *        每个规则：handle=头部选择器（事件委托匹配）；exclude=头内不触发拖动的元素（如关闭按钮）；
 *        targetOf=从头部找可移动元素（默认 head.parentElement）；clearTransform=是否清掉居中 transform
 *        （.dialog 靠 translate(-50%,-50%) 居中需要清；靠 flex 居中的不需要）。
 * @returns {{onMouseDown:Function, onMouseMove:Function, onMouseUp:Function, install:Function}}
 */
export function createDialogDrag(rules) {
    let drag = null;

    function ruleFor(target) {
        if (!target || typeof target.closest !== 'function') return null;
        for (const rule of rules) {
            if (target.closest(rule.handle)) return rule;
        }
        return null;
    }

    function onMouseDown(e) {
        if (e.button !== 0) return; // 只响应左键，右键菜单等不触发拖动
        const rule = ruleFor(e.target);
        if (!rule) return;
        if (rule.exclude && e.target.closest(rule.exclude)) return;
        const handle = e.target.closest(rule.handle);
        const target = rule.targetOf ? rule.targetOf(handle) : handle.parentElement;
        if (!target || !target.style) return;
        // 首次按下：记录当前视觉位置，转成 fixed + 像素定位（清 transform 后视觉不跳）。
        // 之后重复按下是幂等的：读到的 rect 已是像素定位，再设一次值不变。
        const r = target.getBoundingClientRect();
        if (!target.style.position) target.style.position = 'fixed';
        if (rule.clearTransform) target.style.transform = 'none';
        target.style.left = r.left + 'px';
        target.style.top = r.top + 'px';
        drag = {target, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top};
        e.preventDefault();
    }

    function onMouseMove(e) {
        if (!drag) return;
        drag.target.style.left = (drag.left + e.clientX - drag.sx) + 'px';
        drag.target.style.top = (drag.top + e.clientY - drag.sy) + 'px';
    }

    function onMouseUp() {
        drag = null;
    }

    function install(win) {
        win.addEventListener('mousedown', onMouseDown);
        win.addEventListener('mousemove', onMouseMove);
        win.addEventListener('mouseup', onMouseUp);
    }

    return {onMouseDown, onMouseMove, onMouseUp, install};
}
