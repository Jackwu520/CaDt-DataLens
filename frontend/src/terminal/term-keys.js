// term-keys.js：终端按键语义分流纯函数——Ctrl+C / Ctrl+Shift+C / Ctrl+Shift+V
// 在 xterm 里是「复制/粘贴」还是「放行给 PTY」。attachCustomKeyEventHandler 用。

// 返回 'copy' | 'paste' | 'send'。Ctrl+C 无选中照常发 \x03（SIGINT 中断前台程序），
// 有选中变复制（Windows Terminal 语义）；Ctrl+Shift+V 粘贴；Ctrl+V 不拦，
// 走浏览器原生 paste 事件（xterm 自带处理）。
export function termKeyAction(ev, hasSelection) {
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return 'send';
    const k = String(ev.key || '').toLowerCase();
    if (k === 'c' && hasSelection) return 'copy';
    if (k === 'v' && ev.shiftKey) return 'paste';
    return 'send';
}
