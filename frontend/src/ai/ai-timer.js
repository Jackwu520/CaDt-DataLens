// ai-timer.js：AI 计时工具的胶囊 UI 与前端注册表（类一-11）。
// 计时本体在 Go 侧（timer.go，窗口最小化不漂移）；到点广播 ai-timer-fired，
// 经 ai-panel 的 wakeSessionByTimer 注入系统消息唤醒对应会话（与定时任务同一投递通道）。
// 胶囊挂载在 AI 面板头部 chips 行（#ai-head-chips），点击即停止；纯会话态，不持久化。
//
// deps 由 ai-panel 显式传入（getter 延迟求值）：
// - getBackend(): Wails 后端（StartTimer / StopTimer / ListTimers）
// - getSessionId(): 当前会话 id（启动时归属记录，到点时据此找会话）
// - onFire(payload): 到点回调（payload 含 sessionId），由 ai-panel 注入并触发新一轮
export function createAITimer(ctx) {
    const timers = new Map();   // id → AITimerInfo
    const sessions = new Map(); // id → 启动时的会话 id（Go 侧不感知会话）
    let styleInjected = false;
    let tickTimer = 0;

    function ensureStyle() {
        if (styleInjected) return;
        styleInjected = true;
        const style = document.createElement('style');
        style.textContent = [
            '.ai-timer-chip { cursor: pointer; }',
            '.ai-timer-chip:hover { border-color: var(--accent); }',
            '.ai-timer-chip .ai-timer-time { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }',
            '.ai-timer-chip .ai-timer-label { max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.ai-timer-chip.ai-timer-countup .ai-timer-time { color: var(--muted); }',
        ].join('\n');
        document.head.appendChild(style);
    }

    function hostEl() {
        return document.getElementById('ai-head-chips');
    }

    function fmtDuration(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return hh > 0 ? hh + ':' + pad(mm) + ':' + pad(ss) : pad(mm) + ':' + pad(ss);
    }

    function chipTitle(info) {
        if (info.mode === 'countdown') {
            return '倒计时「' + info.label + '」剩 ' + fmtDuration((info.endMs - Date.now()) / 1000) + '，到点将以系统消息唤醒 AI；点击停止';
        }
        const elapsed = (Date.now() - info.startMs) / 1000;
        return '正计时「' + info.label + '」已计 ' + fmtDuration(elapsed) + '；点击停止';
    }

    function render() {
        const host = hostEl();
        if (!host) return;
        ensureStyle();
        for (const old of [...host.querySelectorAll('.ai-timer-chip')]) old.remove();
        for (const info of timers.values()) {
            const chip = document.createElement('span');
            chip.className = 'ai-chip ai-timer-chip' + (info.mode === 'countup' ? ' ai-timer-countup' : '');
            chip.dataset.timerId = info.id;
            chip.title = chipTitle(info);
            const label = document.createElement('span');
            label.className = 'ai-timer-label';
            label.textContent = info.label || (info.mode === 'countdown' ? '倒计时' : '正计时');
            const time = document.createElement('span');
            time.className = 'ai-timer-time';
            time.textContent = info.mode === 'countdown'
                ? fmtDuration((info.endMs - Date.now()) / 1000)
                : fmtDuration((Date.now() - info.startMs) / 1000);
            chip.append(label, time);
            chip.addEventListener('click', () => {
                stop(info.id).catch(() => {});
            });
            host.appendChild(chip);
        }
        if (timers.size && !tickTimer) {
            tickTimer = setInterval(() => {
                if (!timers.size) return;
                for (const chip of host.querySelectorAll('.ai-timer-chip[data-timer-id]')) {
                    const info = timers.get(chip.dataset.timerId);
                    if (!info) continue;
                    const time = chip.querySelector('.ai-timer-time');
                    if (time) {
                        time.textContent = info.mode === 'countdown'
                            ? fmtDuration((info.endMs - Date.now()) / 1000)
                            : fmtDuration((Date.now() - info.startMs) / 1000);
                    }
                    chip.title = chipTitle(info);
                }
            }, 1000);
        }
        if (!timers.size && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = 0;
        }
    }

    function sync(list) {
        timers.clear();
        for (const info of Array.isArray(list) ? list : []) {
            if (info && info.id) timers.set(info.id, info);
        }
        render();
    }

    // start 启动计时器；返回新建的计时器信息（供工具结果描述）。
    async function start(mode, seconds, label) {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.StartTimer !== 'function') throw new Error('当前版本不支持计时工具');
        // Go 返回 AITimerStartResult {list, created}
        const result = await backend.StartTimer(mode === 'countup' ? 'countup' : 'countdown',
            Math.max(0, Math.round(Number(seconds) || 0)), String(label || '').slice(0, 60));
        const list = (result && result.list) || [];
        const created = (result && result.created) || {};
        sessions.set(created.id, ctx.getSessionId ? ctx.getSessionId() : '');
        sync(list);
        return created;
    }

    // stop 停止指定计时器；返回被停信息（正计时的已计时长由前端按 now-StartMs 计算）。
    async function stop(id) {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.StopTimer !== 'function') throw new Error('当前版本不支持计时工具');
        const target = id || onlyRunningId();
        if (!target) throw new Error(timers.size ? '有多个计时器在运行，请指定 id（start_timer 返回值里有）' : '没有运行中的计时器');
        // Go 返回 AITimerStopResult {list, stopped, found}
        const result = await backend.StopTimer(target);
        if (!result || !result.found) throw new Error('计时器不存在：' + target);
        sessions.delete(result.stopped.id);
        sync(result.list || []);
        return result.stopped;
    }

    function onlyRunningId() {
        const ids = [...timers.keys()];
        return ids.length === 1 ? ids[0] : '';
    }

    async function syncFromBackend() {
        const backend = ctx.getBackend();
        if (!backend || typeof backend.ListTimers !== 'function') return;
        try {
            sync(await backend.ListTimers());
        } catch (e) {}
    }

    // onFired 倒计时到点（广播事件，只有持有该会话映射的窗口会触发唤醒）。
    function onFired(info) {
        if (!info || !info.id) return;
        const sessionId = sessions.get(info.id) || '';
        sessions.delete(info.id);
        timers.delete(info.id);
        render();
        if (typeof ctx.onFire === 'function') {
            ctx.onFire(Object.assign({}, info, {sessionId}));
        }
    }

    // onStopped 计时器被停止（本窗口或另一窗口点了胶囊 / stop_timer 工具）。
    function onStopped(info) {
        if (!info || !info.id) return;
        sessions.delete(info.id);
        timers.delete(info.id);
        render();
    }

    return {start, stop, sync, syncFromBackend, onFired, onStopped};
}
