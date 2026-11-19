// failure-notifier.js：失败 / 后台事件的统一通知出口（factory + 依赖注入）。
//
// 为什么单独一层：状态栏 flash() 5 秒就清（writing-ui.js），后台静默失败用户根本看不见。
// 这里把「需要用户回来处理」的失败送进消息中心并弹右下角 toast，且按 key 节流防刷屏。
// 只用于 A/B 级清单（落盘失败、多实例冲突、定时任务、子代理等），不用于
// 「已复制 / 已保存 / 输入校验 / 当前版本不支持」这类现场即时反馈——那些仍走 flash。
//
// deps:
//   addMessage(msg, opts)   消息中心投递（main.js 传 messageCenter.add）
//   now()                   可注入时钟（测试用）
//   windowMs                节流窗口（默认 30s）
//   enabled()               可选开关：返回 false 时只记 flash 不弹（保留扩展点，默认 true）
export function createFailureNotifier(deps) {
    const d = deps || {};
    const addMessage = typeof d.addMessage === 'function' ? d.addMessage : () => {};
    const windowMs = Number.isFinite(d.windowMs) && d.windowMs > 0 ? d.windowMs : 30000;
    const now = typeof d.now === 'function' ? d.now : Date.now;
    const enabled = typeof d.enabled === 'function' ? d.enabled : () => true;
    const lastAt = new Map();

    // notifyFailure(title, body, opts)
    //   title  —— 消息标题（短句，如「会话保存失败」）
    //   body   —— 正文（可含错误详情）
    //   opts.kind     —— 'error' | 'info' | 'success'（默认 error）
    //   opts.key      —— 节流键（缺省用 title）；同一 key 在窗口内只弹一次
    //   opts.sessionId—— 关联会话，点 toast 可跳转
    //   opts.toast    —— 是否弹右下角（默认 true；C 级高频可传 false 只进列表）
    // 返回 true=实际投递，false=被节流 / 被开关挡掉。
    function notifyFailure(title, body, opts) {
        if (enabled() === false) return false;
        const o = opts || {};
        const key = String(o.key == null || o.key === '' ? (title || '') : o.key);
        const t = now();
        const prev = lastAt.get(key);
        if (Number.isFinite(prev) && t - prev < windowMs) return false;
        lastAt.set(key, t);
        const kind = o.kind === 'info' || o.kind === 'success' ? o.kind : 'error';
        addMessage({
            kind,
            title: String(title || '提示'),
            body: String(body || ''),
            sessionId: String(o.sessionId || ''),
        }, {toast: o.toast !== false});
        return true;
    }

    return {notifyFailure};
}
