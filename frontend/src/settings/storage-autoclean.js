// storage-autoclean.js：设置 → 存储与清理 的「自动清理」驱动器（前端驱动，Go 侧零改动）。
// 检查时机：启动后 2 分钟 + 运行中每 6 小时（最小化被 WebView2 节流只意味着检查延后，无害）；
// 判定满足（距上次清理超过间隔 / 缓存总量超阈值，任一）就把 autoCleanScope 给出的
// 安全子集交给 StorageClear 执行——范围不含登录态与任何用户数据，无需确认。
// 浮窗 / 调试控制台窗口（__aiFloatWindow / __consoleWindowMode）不参与，避免重复检查；
// 多窗口并发时 StorageClear 有互斥锁且缓存直删幂等，最坏重复清一次，无害。
import {AUTO_CLEAN_LAST_KEY, autoCleanScope, clearReportText, shouldAutoClean} from './settings-pane-storage.js';
import {kvGet, kvSet} from '../core/kv-store.js';

const CHECK_DELAY_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createStorageAutoClean(deps) {
    let delayTimer = 0;
    let intervalTimer = 0;
    let running = false;

    function isAuxWindow() {
        return !!(window.__aiFloatWindow || window.__consoleWindowMode);
    }

    function config() {
        const s = (typeof deps.settings === 'function' ? deps.settings() : deps.settings) || {};
        return {
            enabled: s.storageAutoClean === true,
            intervalDays: Number(s.storageAutoCleanDays) || 0,
            thresholdBytes: (Number(s.storageAutoCleanMB) || 0) * 1024 * 1024,
        };
    }

    function lastAt() {
        const n = Number(kvGet(AUTO_CLEAN_LAST_KEY) || 0);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function markCleaned() {
        // 先记时间再清理：并发窗口里第二个检查者看到新鲜时间戳就跳过
        kvSet(AUTO_CLEAN_LAST_KEY, String(Date.now()));
    }

    async function check() {
        const cfg = config();
        if (!cfg.enabled || running || isAuxWindow()) return false;
        if (!deps.backend || !deps.backend.StorageScan || !deps.backend.StorageClear) return false;
        running = true;
        try {
            const report = await deps.backend.StorageScan('');
            const items = report && Array.isArray(report.items) ? report.items : [];
            const bytes = items.reduce((sum, item) => sum + (item.inCache && item.exists ? (Number(item.bytes) || 0) : 0), 0);
            const verdict = shouldAutoClean({
                now: Date.now(),
                lastAt: lastAt(),
                intervalDays: cfg.intervalDays,
                cacheBytes: bytes,
                thresholdBytes: cfg.thresholdBytes,
            });
            if (!verdict) return false;
            const ids = autoCleanScope(items);
            markCleaned();
            if (!ids.length) return false;
            const result = await deps.backend.StorageClear(ids, '');
            const trigger = verdict === 'size' ? '缓存超过阈值' : '距上次清理已到期';
            if (typeof deps.notify === 'function') {
                // 后台静默清理要主动可见：只进消息中心的话，用户不点状态栏角标就完全
                // 不知道清过。与其它后台事件（工作区防护 / 更新检查）一致弹右下角 toast。
                deps.notify({kind: 'success', title: '自动清理完成', body: trigger + ' · ' + clearReportText(result)}, {toast: true});
            }
            if (deps.activity) {
                deps.activity.log('storage.auto_clean', '', {
                    trigger,
                    ids,
                    freed: Number(result && result.freed) || 0,
                }, {actor: 'system', noRel: true});
            }
            return true;
        } catch (e) {
            try {
                deps.logFrontend('warn', '自动清理失败：' + ((e && (e.stack || e.message)) || e));
            } catch (e2) {}
            return false;
        } finally {
            running = false;
        }
    }

    function start() {
        if (delayTimer || intervalTimer || isAuxWindow()) return;
        delayTimer = setTimeout(() => { check(); }, CHECK_DELAY_MS);
        intervalTimer = setInterval(() => { check(); }, CHECK_INTERVAL_MS);
    }

    return {check, start};
}
