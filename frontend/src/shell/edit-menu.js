// shell/edit-menu.js：输入框 / 可编辑元素的右键编辑菜单（撤销/重做/剪切/复制/粘贴/全选）。
// WebView2 的原生编辑菜单与应用菜单风格脱节，还带打印 / 书写方向 / 更多工具等无关入口，
// 各输入面统一走应用菜单。从 ai-composer.js 的 composer 专用版泛化成共享件（2026-11-22）：
// 默认粘贴只回读系统剪贴板文本插入目标；composer 的图片 / 折叠粘贴分支由调用方用
// options.paste 覆盖。bindEditableContextMenuFallback 是全局兜底：右键落在没有任何
// 自定义菜单接管的输入面上时给应用编辑菜单——冒泡阶段监听，域处理器先跑，
// preventDefault 过（已开自定义菜单）就不再兜底。
import {iconSvg} from '../core/icons.js';

// 接管口径（与 composer 一致）：input / textarea / contenteditable。本模块的兜底按
// closest('input, textarea, [contenteditable="true"]') 判定（target 可能是可编辑元素的子节点）。

export function editableHasSelection(target) {
    if (typeof target.selectionStart === 'number') return target.selectionEnd > target.selectionStart;
    const selection = window.getSelection ? window.getSelection() : null;
    return !!(selection && selection.rangeCount && !selection.isCollapsed);
}

export function execEditable(target, command) {
    target.focus();
    try {
        return !!document.execCommand(command);
    } catch (e) {
        return false;
    }
}

// 右键菜单的「粘贴」拿不到 paste 事件（菜单点击不会触发剪贴板事件），文字只能
// 回读系统剪贴板（后端优先，navigator 兜底）再插入；图片粘贴属 composer 专属流程，
// 由调用方用 options.paste 覆盖，这里不做。
export async function pasteTextIntoEditable(target, backend) {
    let text = '';
    try {
        if (backend && backend.GetClipboardText) text = String((await backend.GetClipboardText()) || '');
    } catch (e) {}
    if (!text && navigator.clipboard && navigator.clipboard.readText) {
        try {
            text = await navigator.clipboard.readText();
        } catch (e) {}
    }
    if (!text) return false;
    target.focus();
    // execCommand('insertText') 会进 undo 栈（菜单粘贴也能 Ctrl+Z 撤销）；不可用时回退 setRangeText
    let ok = false;
    try {
        ok = document.execCommand('insertText', false, text);
    } catch (e) {}
    if (!ok) {
        if (typeof target.selectionStart === 'number') {
            target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
        } else {
            target.value += text;
        }
        target.dispatchEvent(new Event('input', {bubbles: true}));
    }
    return true;
}

// 输入面的应用编辑菜单。options.paste 覆盖默认粘贴（composer 的图片 / 折叠分支）；
// options.backend 供默认粘贴回读系统剪贴板。
export function openEditMenu(showContextMenu, event, target, options = {}) {
    if (typeof showContextMenu !== 'function') return;
    const hasSel = editableHasSelection(target);
    const paste = options.paste || (() => pasteTextIntoEditable(target, options.backend));
    showContextMenu([
        {label: '撤销', shortcut: 'Ctrl+Z', icon: 'undo', action: () => execEditable(target, 'undo')},
        {label: '重做', shortcut: 'Ctrl+Y', icon: 'redo', action: () => execEditable(target, 'redo')},
        {sep: true},
        {label: '剪切', shortcut: 'Ctrl+X', icon: 'cut', disabled: !hasSel, action: () => execEditable(target, 'cut')},
        {label: '复制', shortcut: 'Ctrl+C', icon: 'copy', disabled: !hasSel, action: () => execEditable(target, 'copy')},
        {label: '粘贴', shortcut: 'Ctrl+V', icon: 'paste', action: paste},
        {sep: true},
        {label: '全选', shortcut: 'Ctrl+A', icon: 'select-all', action: () => execEditable(target, 'selectAll')},
    ], event.clientX, event.clientY);
}

// 全局兜底（注册一次，main.js 组合根调用）：右键落在没人接管的输入面上时给应用编辑菜单。
// 冒泡阶段监听，让域处理器先跑；它们 preventDefault（已开自定义菜单）或 stopPropagation
// （接管判定中）时这里都不再出手。showContextMenu 惰性求值（ctxMenu 迟于本注册被创建）。
export function bindEditableContextMenuFallback(showContextMenu, options = {}) {
    document.addEventListener('contextmenu', (e) => {
        if (e.defaultPrevented) return;
        const target = e.target && e.target.closest
            ? e.target.closest('input, textarea, [contenteditable="true"]')
            : null;
        if (!target) return;
        e.preventDefault();
        openEditMenu(showContextMenu, e, target, options);
    });
}
