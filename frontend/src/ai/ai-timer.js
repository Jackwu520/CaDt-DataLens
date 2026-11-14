// ai-timer.js：AI 计时工具的单胶囊 UI 与前端注册表（类一-11）。
// 计时本体在 Go 侧（timer.go，窗口最小化不漂移）；到点广播 ai-timer-fired，
// 经 ai-panel 的 wakeSessionByTimer 注入系统消息唤醒对应会话（与定时任务同一投递通道）。
// 头部只挂一枚「计时」胶囊（数量角标 + 最近倒计时剩余走秒），无计时器时隐藏；
// 点击弹出计时器列表：行点击进入详情（读数/起止时刻/id + 停止按钮），行尾【x】直接停止。
// 用户也能从消息框「+」→ 计时器手动创建倒计时 / 正计时（openCreateDialog）。
// 弹层复用 chips-pop 机制（kind=timers，内容由 renderPop 提供）。
//
// deps 由 ai-panel 显式传入（getter 延迟求值）：
// - getBackend(): Wails 后端（StartTimer / StopTimer / ListTimers）
// - getSessionId(): 当前会话 id（启动时归属记录，到点时据此找会话）
// - getChip(): 头部计时胶囊（index.html 的 #ai-chip-timers）
// - togglePop(chip): 开关计时器弹层（ai-panel 转发到 subagents 的 chips-pop 机制）
// - onTimersChanged(): 计时器集合/视图变化通知（弹层开着时由 ai-panel 原位刷新）
// - flash(msg, isErr): 用户可见提示（创建成功 / 校验失败）
// - onFire(payload): 到点回调（payload 含 sessionId），由 ai-panel 注入并触发新一轮
import {iconSvg} from '../icons.js';

// 计时器会话隔离（纯函数，ai-timer.test.mjs 覆盖）。
// 显示与上限都按会话隔离：胶囊 / 弹层 / 数量角标只算「归属当前会话」的计时器；
// 归属不明（跨窗同步来的外部计时器，本实例没记过归属）保持可见可停，避免另一窗口
// 关闭后计时器在本窗口失联。done（到点 / 停止）的计时器已从注册表移除，天然不计入。
export function filterTimersForSession(timers, sessionIdOf, currentSessionId) {
    const out = [];
    if (timers && typeof timers.values === 'function') {
        for (const info of timers.values()) {
            const owner = sessionIdOf(info.id);
            if (!owner || owner === currentSessionId) out.push(info);
        }
    }
    return out;
}

// 会话内上限计数：只数归属当前会话的运行中计时器（不含归属不明的跨窗计时器）。
export function countSessionTimers(timers, sessionIdOf, currentSessionId) {
    let n = 0;
    if (timers && typeof timers.keys === 'function') {
        for (const id of timers.keys()) {
            if (sessionIdOf(id) === currentSessionId) n += 1;
        }
    }
    return n;
}

const AI_TIMER_SESSION_MAX = 5; // 单会话同时运行上限（应用总上限 30 在 Go 侧 aiTimerMaxActive）

export function createAITimer(ctx) {
    const timers = new Map();   // id → AITimerInfo
    const sessions = new Map(); // id → 启动时的会话 id（Go 侧不感知会话）
    let styleInjected = false;
    let tickTimer = 0;
    let detailId = '';          // 弹层当前展示的详情计时器 id（空 = 列表视图）
    let createBox = null;       // 「+」菜单弹出的创建小对话框（同时只一个）

    // 当前会话可见的计时器（显示隔离的统一口径，见文件头 filterTimersForSession 注释）
    function visibleTimers() {
        const sid = ctx.getSessionId ? ctx.getSessionId() : '';
        return filterTimersForSession(timers, (id) => sessions.get(id) || '', sid);
    }

    function ensureStyle() {
        if (styleInjected) return;
        styleInjected = true;
        const style = document.createElement('style');
        style.textContent = [
            '.ai-chip-time { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }',
            '.ai-chip-time.hidden { display: none; }',
            '.ai-timer-badge { flex: none; font-size: 10px; line-height: 16px; color: var(--accent); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; }',
            '.ai-timer-badge.countup { color: var(--muted); }',
            '.ai-timer-row-time { font-variant-numeric: tabular-nums; }',
            '.ai-timer-stop { flex: none; width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border: none; border-radius: 3px; background: none; color: var(--muted); cursor: pointer; }',
            '.ai-timer-stop:hover { background: color-mix(in srgb, var(--red) 14%, transparent); color: var(--red); }',
            '.ai-timer-stop svg { width: 11px; height: 11px; display: block; }',
            '.ai-timer-back { width: 100%; margin-bottom: 4px; justify-content: flex-start; }',
            '.ai-timer-detail { padding: 4px 6px 6px; display: flex; flex-direction: column; gap: 3px; font-size: 11px; }',
            '.ai-timer-detail-row { display: flex; gap: 8px; min-width: 0; }',
            '.ai-timer-detail-key { flex: none; color: var(--muted); }',
            '.ai-timer-detail-val { flex: 1; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }',
            '.ai-timer-detail-time { color: var(--accent); font-weight: 600; }',
            '.ai-timer-stop-btn { margin-top: 6px; align-self: flex-start; }',
            '.ai-timer-create { position: absolute; z-index: 60; width: 250px; padding: 10px; display: flex; flex-direction: column; gap: 6px; background: var(--panel2); border: 1px solid var(--border); border-radius: 9px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }',
            '.ai-timer-create-title { font-size: 12px; font-weight: 600; }',
            '.ai-timer-create input, .ai-timer-create select { width: 100%; box-sizing: border-box; font-size: 12px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--input, transparent); color: inherit; }',
            '.ai-timer-create-row { display: flex; gap: 6px; }',
            '.ai-timer-create-row input { flex: 1; min-width: 0; }',
            '.ai-timer-create-row select { flex: none; width: 64px; }',
            '.ai-timer-create-err { font-size: 10.5px; color: var(--red); min-height: 13px; }',
            '.ai-timer-create-foot { display: flex; justify-content: flex-end; gap: 6px; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    function chipEl() {
        return typeof ctx.getChip === 'function' ? ctx.getChip() : null;
    }

    function flash(msg, isErr) {
        return typeof ctx.flash === 'function' ? ctx.flash(msg, isErr) : undefined;
    }

    // 弹层内容变化的原位刷新：经 ai-panel 的 onTimersChanged 转发（chipsPopKind 为 timers 时重渲染）
    function refreshPop() {
        if (typeof ctx.onTimersChanged === 'function') ctx.onTimersChanged();
    }

    function fmtDuration(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return hh > 0 ? hh + ':' + pad(mm) + ':' + pad(ss) : pad(mm) + ':' + pad(ss);
    }

    function fmtClock(ms) {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    // 胶囊时间位与弹层行的实时读数：倒计时显示剩余，正计时显示已计
    function liveTime(info) {
        return info.mode === 'countdown'
            ? fmtDuration((info.endMs - Date.now()) / 1000)
            : fmtDuration((Date.now() - info.startMs) / 1000);
    }

    // 胶囊聚焦的计时器（仅当前会话可见集）：优先「最快到点的倒计时」，没有倒计时时取最新启动的正计时
    function focusTimer() {
        let soonest = null;
        for (const info of visibleTimers()) {
            if (info.mode !== 'countdown') continue;
            if (!soonest || info.endMs < soonest.endMs) soonest = info;
        }
        if (soonest) return soonest;
        let latest = null;
        for (const info of visibleTimers()) {
            if (!latest || (info.startMs || 0) > (latest.startMs || 0)) latest = info;
        }
        return latest;
    }

    function chipTitle() {
        const parts = [];
        for (const info of visibleTimers()) {
            parts.push((info.mode === 'countdown' ? '倒计时「' : '正计时「') + (info.label || '')
                + '」' + (info.mode === 'countdown' ? '剩 ' : '已计 ') + liveTime(info));
        }
        return parts.join('；') + '；点击查看详情 / 停止';
    }

    function ensureChipChrome(chip) {
        const iconEl = chip.querySelector('.ai-chip-icon');
        if (iconEl && !iconEl.dataset.ready) {
            iconEl.dataset.ready = '1';
            iconEl.innerHTML = iconSvg('clock', 12);
        }
    }

    function updateChipTime(chip) {
        const timeEl = chip.querySelector('.ai-chip-time');
        if (!timeEl) return;
        const info = focusTimer();
        if (info) {
            timeEl.textContent = liveTime(info);
            timeEl.classList.remove('hidden');
        } else {
            timeEl.textContent = '';
            timeEl.classList.add('hidden');
        }
    }

    function render() {
        const chip = chipEl();
        if (!chip) return;
        ensureStyle();
        ensureChipChrome(chip);
        // 会话隔离：只显示/统计当前会话的计时器（其他会话的照常在跑并到点唤醒自己，只是不在这里显示）
        const visible = visibleTimers();
        chip.classList.toggle('hidden', !visible.length);
        const countEl = chip.querySelector('.ai-chip-count');
        if (countEl) {
            countEl.textContent = String(visible.length);
            countEl.classList.toggle('hidden', !visible.length);
        }
        if (visible.length) {
            updateChipTime(chip);
            chip.title = chipTitle();
        }
        // 弹层开着时由 ai-panel 原位刷新（详情对象被停止时自动回到列表）
        refreshPop();
        if (timers.size && !tickTimer) {
            tickTimer = setInterval(() => {
                if (!timers.size) return;
                const current = chipEl();
                if (current && !current.classList.contains('hidden')) updateChipTime(current);
                // 弹层行/详情读数原位刷新，不整层重建（避免打断悬停/点击）
                const pop = document.getElementById('ai-chips-pop');
                if (pop) {
                    for (const timeEl of pop.querySelectorAll('.ai-timer-row-time[data-timer-id], .ai-timer-detail-time[data-timer-id]')) {
                        const info = timers.get(timeEl.dataset.timerId);
                        if (info) timeEl.textContent = liveTime(info);
                    }
                }
            }, 1000);
        }
        if (!timers.size && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = 0;
        }
    }

    // chips-pop 的 timers 内容：列表视图（行点击进详情，行尾【x】停止）与详情视图两种形态
    function renderPop(host) {
        if (!host) return;
        ensureStyle();
        host.textContent = '';
        const info = timers.get(detailId);
        if (info) {
            renderPopDetail(host, info);
            return;
        }
        const title = document.createElement('div');
        title.className = 'ai-chips-pop-title';
        title.textContent = '计时器';
        host.appendChild(title);
        const list = visibleTimers().sort((a, b) => {
            if ((a.mode === 'countdown') !== (b.mode === 'countdown')) return a.mode === 'countdown' ? -1 : 1;
            return a.mode === 'countdown' ? (a.endMs - b.endMs) : ((b.startMs || 0) - (a.startMs || 0));
        });
        for (const item of list) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ai-chips-row ai-timer-row';
            const badge = document.createElement('span');
            badge.className = 'ai-timer-badge' + (item.mode === 'countdown' ? '' : ' countup');
            badge.textContent = item.mode === 'countdown' ? '倒计时' : '正计时';
            const main = document.createElement('span');
            main.className = 'ai-chips-main';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'ai-chips-name';
            nameSpan.textContent = item.label || (item.mode === 'countdown' ? '倒计时' : '正计时');
            const timeSpan = document.createElement('span');
            timeSpan.className = 'ai-chips-sub ai-timer-row-time';
            timeSpan.dataset.timerId = item.id;
            timeSpan.textContent = liveTime(item);
            main.append(nameSpan, timeSpan);
            // 行尾【x】：直接停止该计时器（行本体点击 = 看详情）
            const stopBtn = document.createElement('span');
            stopBtn.className = 'ai-timer-stop';
            stopBtn.setAttribute('role', 'button');
            stopBtn.setAttribute('aria-label', '停止「' + (item.label || item.id) + '」');
            stopBtn.title = '停止该计时器';
            stopBtn.innerHTML = iconSvg('close', 12);
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                stop(item.id).catch(() => {});
            });
            row.append(badge, main, stopBtn);
            row.title = '点击查看详情';
            row.addEventListener('click', () => {
                detailId = item.id;
                refreshPop();
            });
            host.appendChild(row);
        }
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-chips-empty';
            empty.textContent = '本会话暂无计时器，可让 AI 用 start_timer 启动，或在消息框「+」→ 计时器手动创建';
            host.appendChild(empty);
        }
    }

    // 详情视图：目的 / 模式 / 实时读数 / 起止时刻 / id + 停止按钮（返回按钮回到列表）
    function renderPopDetail(host, info) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'ai-chips-row ai-timer-back';
        const backIco = document.createElement('span');
        backIco.className = 'ai-chips-go';
        backIco.style.transform = 'rotate(180deg)';
        backIco.innerHTML = iconSvg('chevron-right', 12);
        const backLabel = document.createElement('span');
        backLabel.className = 'ai-chips-name';
        backLabel.textContent = '返回列表';
        back.append(backIco, backLabel);
        back.addEventListener('click', () => {
            detailId = '';
            refreshPop();
        });
        host.appendChild(back);
        const box = document.createElement('div');
        box.className = 'ai-timer-detail';
        const rowOf = (key, valNode) => {
            const row = document.createElement('div');
            row.className = 'ai-timer-detail-row';
            const keyEl = document.createElement('span');
            keyEl.className = 'ai-timer-detail-key';
            keyEl.textContent = key;
            row.append(keyEl, valNode);
            return row;
        };
        const textVal = (text) => {
            const el = document.createElement('span');
            el.className = 'ai-timer-detail-val';
            el.textContent = text;
            return el;
        };
        box.appendChild(rowOf('目的', textVal(info.label || (info.mode === 'countdown' ? '倒计时' : '正计时'))));
        box.appendChild(rowOf('模式', textVal(info.mode === 'countdown' ? '倒计时（到点自动唤醒 AI）' : '正计时（停止时上报时长）')));
        const timeEl = document.createElement('span');
        timeEl.className = 'ai-timer-detail-val ai-timer-detail-time';
        timeEl.dataset.timerId = info.id;
        timeEl.textContent = liveTime(info);
        box.appendChild(rowOf(info.mode === 'countdown' ? '剩余' : '已计', timeEl));
        if (info.mode === 'countdown') box.appendChild(rowOf('到点时刻', textVal(fmtClock(info.endMs))));
        box.appendChild(rowOf('启动时刻', textVal(fmtClock(info.startMs))));
        box.appendChild(rowOf('id', textVal(info.id)));
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'dlg-btn ai-timer-stop-btn';
        stopBtn.textContent = '停止计时器';
        stopBtn.addEventListener('click', () => {
            stop(info.id).catch(() => {});
        });
        box.appendChild(stopBtn);
        host.appendChild(box);
    }

    // 「+」菜单的创建对话框：倒计时填目的 + 时长（分钟/秒），正计时只填目的
    function openCreateDialog(mode) {
        const chip = chipEl();
        const panel = chip ? chip.closest('#ai-panel') : document.getElementById('ai-panel');
        if (!panel) {
            flash('计时器面板不可用', true);
            return;
        }
        ensureStyle();
        closeCreateDialog();
        const isCountdown = mode !== 'countup';
        const box = document.createElement('div');
        box.className = 'ai-timer-create';
        const title = document.createElement('div');
        title.className = 'ai-timer-create-title';
        title.textContent = isCountdown ? '新建倒计时' : '新建正计时';
        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.maxLength = 60;
        labelInput.placeholder = '计时目的（必填，如「等待构建完成」）';
        const errEl = document.createElement('div');
        errEl.className = 'ai-timer-create-err';
        let secondsRow = null;
        if (isCountdown) {
            secondsRow = document.createElement('div');
            secondsRow.className = 'ai-timer-create-row';
            const secondsInput = document.createElement('input');
            secondsInput.type = 'number';
            secondsInput.min = '1';
            secondsInput.placeholder = '时长';
            const unitSelect = document.createElement('select');
            const minOpt = document.createElement('option');
            minOpt.value = '60';
            minOpt.textContent = '分钟';
            const secOpt = document.createElement('option');
            secOpt.value = '1';
            secOpt.textContent = '秒';
            unitSelect.append(minOpt, secOpt);
            unitSelect.value = '60';
            secondsRow.append(secondsInput, unitSelect);
        }
        const foot = document.createElement('div');
        foot.className = 'ai-timer-create-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'dlg-btn';
        cancelBtn.textContent = '取消';
        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'dlg-btn';
        startBtn.textContent = '启动';
        foot.append(cancelBtn, startBtn);
        const headRow = document.createElement('div');
        headRow.className = 'ai-timer-create-head';
        headRow.append(title);
        if (isCountdown) box.append(headRow, labelInput, secondsRow, foot);
        else box.append(headRow, labelInput, foot);
        box.appendChild(errEl);
        panel.appendChild(box);
        const composer = panel.querySelector('.ai-composer');
        const panelRect = panel.getBoundingClientRect();
        if (composer) {
            const composerRect = composer.getBoundingClientRect();
            box.style.bottom = Math.max(8, panelRect.bottom - composerRect.top + 8) + 'px';
            let left = composerRect.left - panelRect.left;
            left = Math.max(8, Math.min(left, panel.clientWidth - 258));
            box.style.left = left + 'px';
        } else {
            box.style.bottom = '60px';
            box.style.left = '12px';
        }
        createBox = box;
        labelInput.focus();
        const close = () => {
            if (createBox) {
                createBox.remove();
                createBox = null;
            }
            document.removeEventListener('mousedown', onOutside, true);
        };
        const onOutside = (e) => {
            if (createBox && !createBox.contains(e.target)) close();
        };
        document.addEventListener('mousedown', onOutside, true);
        cancelBtn.addEventListener('click', close);
        const submit = async () => {
            const label = labelInput.value.trim();
            if (!label) {
                errEl.textContent = '计时目的不能为空';
                labelInput.focus();
                return;
            }
            let seconds = 0;
            if (isCountdown && secondsRow) {
                const secondsInput = secondsRow.querySelector('input');
                const unitSelect = secondsRow.querySelector('select');
                const value = Math.round(Number(secondsInput.value) || 0);
                seconds = value * (Number(unitSelect.value) || 1);
                if (value < 1 || seconds < 1 || seconds > 86400) {
                    errEl.textContent = '时长须在 1 秒 – 24 小时之间';
                    return;
                }
            }
            try {
                const created = await start(isCountdown ? 'countdown' : 'countup', seconds, label);
                close();
                flash((isCountdown ? '倒计时「' : '正计时「') + created.label + '」已启动');
            } catch (e) {
                errEl.textContent = (e && e.message) || String(e);
            }
        };
        startBtn.addEventListener('click', () => { submit().catch(() => {}); });
        for (const input of [labelInput, isCountdown && secondsRow ? secondsRow.querySelector('input') : null].filter(Boolean)) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submit().catch(() => {});
                } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    close();
                }
            });
        }
    }

    function closeCreateDialog() {
        if (createBox) {
            createBox.remove();
            createBox = null;
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
        // 会话内上限（done 不计入——注册表里只有运行中的）：AI 工具与手动创建同走这里
        const sid = ctx.getSessionId ? ctx.getSessionId() : '';
        if (countSessionTimers(timers, (id) => sessions.get(id) || '', sid) >= AI_TIMER_SESSION_MAX) {
            throw new Error('本会话运行中的计时器已达上限（' + AI_TIMER_SESSION_MAX + ' 个），请先停止部分计时器');
        }
        // Go 返回 AITimerStartResult {list, created}；应用总上限（30）由 Go 侧 aiTimerMaxActive 把关
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

    // onStopped 计时器被停止（本窗口弹层/详情停止 / 另一窗口 / stop_timer 工具）。
    function onStopped(info) {
        if (!info || !info.id) return;
        sessions.delete(info.id);
        timers.delete(info.id);
        render();
    }

    // 头部胶囊点击开关弹层（chip 是静态 DOM，工厂时接线一次即可）
    const chip = chipEl();
    if (chip && typeof ctx.togglePop === 'function') {
        chip.addEventListener('click', () => ctx.togglePop(chip));
    }

    return {start, stop, sync, syncFromBackend, onFired, onStopped, renderPop, openCreateDialog, closeCreateDialog};
}
