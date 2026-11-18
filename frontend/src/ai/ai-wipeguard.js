// ai-wipeguard.js：工作区破坏防护的检测控制器（docs/finished-plans/workspace-wipe-guard.md §5）。
//
// 两信号（canary 诱饵已砍——2026-11-19 作者裁定工作区零足迹，方案 §5.2）：
//   ① 主信号：workspace-changed 事件（watcher 内核级——AI 工具、run_command 子进程、
//      工具返回后存活的进程、用户的删除全部可见）→ 10s 滚动窗口删除计数；
//   ② 兜底：结构指纹（run_command / background_command 前后保底 + 10 分钟周期校准 +
//      overflow 重扫）。指纹的阈值判定单一来源在 Go（WipeGuardCompare），前端不复制。
//
// critical 且 AI 活跃 → 停会话 + 熔断本轮后续写命令（ai-panel 查询 isWriteBlocked，
// 下一回合 startSessionTurn 时解除）；critical 但会话空闲 → 只强提醒（用户手动批量删除
// 不误停）。备份 / L3 快照的触发不在本模块（ai-panel 写路径 + 设置页定时器）。

// ---- 常量（工程参数，方案 §3.4：不进设置 UI）----

export const WIPEGUARD_WINDOW_MS = 10 * 1000;       // 滚动窗口
export const WIPEGUARD_DELETE_THRESHOLD = 40;        // 窗口内删除事件阈值
export const WIPEGUARD_AI_ACTIVE_MS = 60 * 1000;     // AI 活跃窗口
export const WIPEGUARD_FINGERPRINT_DEBOUNCE_MS = 3 * 1000; // 指纹去抖
export const WIPEGUARD_FINGERPRINT_INTERVAL_MS = 10 * 60 * 1000; // 周期校准

// watcher 计数排除的目录：与 Go 侧 skipFingerprintDir 同口径（internal/search 的
// searchSkipDirs 忽略表 + .git + .cadt），另加构建输出与依赖目录（searchArtifactDirs
// 口径）——vite/wails 等构建链清空产物目录是合法 churn（dist 一轮就有几十个删除
// 事件），不能计入破坏判定。改 Go 侧忽略表时同步这里。
export const WIPEGUARD_SKIP_DIRS = [
    '.git', '.cadt', '.svn', '.hg', '.idea', '.vscode',
    'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle', '.cache',
    'dist', 'build', 'out', 'target', 'bin', 'obj',
    'vendor', 'coverage', 'bower_components', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo',
];

// ---- 纯函数（测试见 test/ai/ai-wipeguard.test.mjs）----

// wipeGuardSkipPath：路径前两段（顶层 / 二级目录）命中排除表 → 不计入删除窗口。
// 二级目录覆盖 frontend/dist 这类「产物挂在源码目录下」的布局；三级及以下不排除，
// 避免把主信号弄瞎。
// 目录口径之外再排**临时文件形态**（2026-11-19 补丁应用误报实录）：原子写（atomfile
// `<name>.<pid>.<nanos>.tmp` / `<name>.tmp.<pid>.<hash>`）、补丁写入（`.cadt-patch-*.tmp`）、
// 各类锁文件——它们的「消失」是写入流程的正常半程（temp→rename），不是文件被删；一次
// 7 文件的补丁应用能堆出 40+ 条删除事件直接爆阈值。
export function wipeGuardSkipPath(path) {
    const norm = String(path || '').replace(/\\/g, '/').toLowerCase();
    if (!norm) return true;
    const segments = norm.split('/');
    if (WIPEGUARD_SKIP_DIRS.includes(segments[0]) ||
        (segments.length > 1 && WIPEGUARD_SKIP_DIRS.includes(segments[1]))) {
        return true;
    }
    const base = segments[segments.length - 1];
    return WIPEGUARD_SKIP_BASE_RE.test(base);
}

// 临时/机械文件的 basename 形态：`.tmp` 结尾（atomfile / 补丁 tmp / 通用临时）、
// `.tmp.<pid>.<hash>`（带后缀的原子写变体）、`.cadt-patch-` 前缀（补丁写入 temp）、
// `.lock` / `.gate` 结尾（跨进程锁）。
const WIPEGUARD_SKIP_BASE_RE = /(\.tmp($|\.))|(^\.cadt-patch-)|(\.lock$)|(\.gate$)/;

// registerDeleteEvents：把一批 watcher 事件路径并入滚动窗口（丢弃窗外旧条目）。
// 同一路径在窗口内只计一次——ReadDirectoryChangesW 对一次 rename 会推多条 action
// （temp 消失 + 目标出现 + 父目录变更），重复计数会把量级抬高 3-5 倍（2026-11-19
// 补丁应用误报实录：41 条事件去重后其实只有 ~10 个文件）。
// 纯函数：返回新窗口，不改动入参。
export function registerDeleteEvents(win, paths, now) {
    const events = ((win && win.events) || [])
        .filter((e) => now - e.at < WIPEGUARD_WINDOW_MS);
    const seen = new Set(events.map((e) => e.path));
    for (const p of (Array.isArray(paths) ? paths : [])) {
        if (wipeGuardSkipPath(p)) continue;
        const path = String(p);
        if (seen.has(path)) continue;
        seen.add(path);
        events.push({at: now, path});
    }
    return {events};
}

// shouldAlarmFromWatch：滚动窗口判定。删除数到阈值 → critical。返回 {level, reason,
// paths} 或 null。
export function shouldAlarmFromWatch(win, now) {
    const events = ((win && win.events) || [])
        .filter((e) => now - e.at < WIPEGUARD_WINDOW_MS);
    if (events.length >= WIPEGUARD_DELETE_THRESHOLD) {
        return {
            level: 'critical',
            reason: `10 秒内 ${events.length} 个文件被删除`,
            paths: events.map((e) => e.path),
        };
    }
    return null;
}

// normalizeWsKey：工作区根归一化（与后端 WorkspaceKey 的归一化语义一致：\→/、去尾斜杠、小写），
// 用于窗口与指纹基线的工作区切换判定。
export function normalizeWsKey(ws) {
    return String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ---- 控制器 ----

export function createAIWipeguard(deps) {
    // deps: {
    //   getBackend   () => 绑定集（WipeGuardFingerprint / WipeGuardCompare / WipeGuardAlarm / ...）
    //   getWsRoot    () => 当前工作区根
    //   getSettings  () => settings 对象（wipeGuard 段：enabled / snapshots / backupRoot）
    //   isAIActive   (root) => 指定工作区（归一化后）有会话最近 60s 在跑工具或正在流式——
    //               critical 是否停会话按工作区判定：别的后台会话不该被牵连（方案 §5.5）
    //   onCritical   (info) => critical 告警动作（状态栏红条 + AI 活跃时停会话）——main.js 提供
    //   onWarn       (info) => warn 提示（状态栏黄条）
    // }
    let watchWindow = null;
    let wsKey = '';
    let lastFingerprint = null;   // run_command 前的基线
    let lastFingerprintAt = 0;
    let lastAlarmAt = 0;
    let fingerprintTimer = null;
    let blocked = false;          // 熔断：本轮后续写命令
    let blockedRoot = '';         // 熔断作用的工作区（归一化 key）——只禁该工作区的写
    let calibrating = false;

    function settingsOf() {
        const wg = (deps.getSettings && deps.getSettings().wipeGuard) || {};
        return {
            enabled: wg.enabled !== false,
            snapshots: wg.snapshots !== false,
            backupRoot: wg.backupRoot || '',
        };
    }

    function backend() { return deps.getBackend(); }

    // ---- 设置同步：settings 对象 → Go 侧（启动与设置页变更后调用）----
    async function syncConfig() {
        const st = settingsOf();
        try {
            await backend().WipeGuardConfigure({
                enabled: st.enabled,
                snapshots: st.snapshots,
                backupRoot: st.backupRoot,
            });
        } catch (e) {
            console.warn('[wipeguard] 配置同步失败（后端不可用？）', e);
        }
    }

    // ---- 指纹兜底（run_command 前后 + 周期校准 + overflow 重扫）----
    async function takeFingerprint(root) {
        try {
            return await backend().WipeGuardFingerprint(root);
        } catch (e) {
            console.warn('[wipeguard] 指纹获取失败（尽力而为）', e);
            return null;
        }
    }

    function fireAlarm(verdict, source, root) {
        const now = Date.now();
        if (now - lastAlarmAt < WIPEGUARD_FINGERPRINT_DEBOUNCE_MS) return;
        lastAlarmAt = now;
        root = root || (deps.getWsRoot ? deps.getWsRoot() : '') || '';
        const aiActive = deps.isAIActive ? !!deps.isAIActive(root) : false;
        backend().WipeGuardAlarm(verdict.level, verdict.reason,
            `${source} · AI活跃=${aiActive} · 样例=${(verdict.paths || []).slice(0, 12).join(', ')}`)
            .catch(() => {}); // 告警日志尽力而为
        if (verdict.level === 'critical') {
            if (aiActive) {
                blocked = true;                    // 熔断本轮写命令（startSessionTurn 解除）
                blockedRoot = normalizeWsKey(root);
            }
            deps.onCritical && deps.onCritical({reason: verdict.reason, source, aiActive, root, paths: verdict.paths || []});
        } else {
            deps.onWarn && deps.onWarn({reason: verdict.reason, source, root});
        }
        // 告警后：重扫指纹兜底（尽力而为）
        takeFingerprint(root);
    }

    async function calibrateFingerprint(root, {force} = {}) {
        if (!root || calibrating) return;
        const now = Date.now();
        if (!force && now - lastFingerprintAt < WIPEGUARD_FINGERPRINT_DEBOUNCE_MS) return;
        calibrating = true;
        try {
            const after = await takeFingerprint(root);
            lastFingerprintAt = Date.now();
            if (after && lastFingerprint) {
                const verdict = await backend().WipeGuardCompare(lastFingerprint, after).catch(() => null);
                if (verdict && verdict.level) {
                    fireAlarm({level: verdict.level, reason: verdict.reason, paths: []}, '指纹校准', root);
                }
            }
            lastFingerprint = after; // 基线滚动（无论是否告警，旧基线已过时）
        } finally {
            calibrating = false;
        }
    }

    function startCalibrationLoop() {
        if (fingerprintTimer) return;
        fingerprintTimer = setInterval(() => {
            if (!settingsOf().enabled) return;
            const root = deps.getWsRoot ? deps.getWsRoot() : '';
            if (root) calibrateFingerprint(root, {force: true});
        }, WIPEGUARD_FINGERPRINT_INTERVAL_MS);
    }

    function stopCalibrationLoop() {
        if (fingerprintTimer) {
            clearInterval(fingerprintTimer);
            fingerprintTimer = null;
        }
    }

    // ---- 事件入口（main.js 的 workspace-changed 监听转发）----
    function handleWorkspaceEvent(payload) {
        if (!settingsOf().enabled) return;
        const root = (payload && payload.root) || (deps.getWsRoot ? deps.getWsRoot() : '') || '';
        const key = normalizeWsKey(root);
        if (key !== wsKey) {
            // 切工作区：窗口与指纹基线重置（防止跨工作区误判）
            watchWindow = {events: []};
            wsKey = key;
            lastFingerprint = null;
        }
        if (payload && payload.overflow) {
            // 内核丢事件：立即重扫指纹兜底
            calibrateFingerprint(root, {force: true});
        }
        const now = Date.now();
        // 只计「消失」类事件（payload.removed 由 Go 侧按 FILE_ACTION_REMOVED / RENAMED_OLD_NAME
        // 分组）：原子写与补丁回灌产生的是 added/renamed_new/modified，几十个文件的合法写入
        // 不该计入破坏判定（2026-11-19 补丁应用误报实录）。
        const removedPaths = (payload && Array.isArray(payload.removed)) ? payload.removed : [];
        watchWindow = registerDeleteEvents(watchWindow, removedPaths, now);
        const verdict = shouldAlarmFromWatch(watchWindow, now);
        if (verdict) fireAlarm(verdict, 'watcher', root);
    }

    // ---- run_command / background_command 前后保底（ai-panel 调用）----
    async function preCommand(root) {
        if (!settingsOf().enabled || !root) return null;
        return takeFingerprint(root);
    }

    async function postCommand(root, before) {
        if (!before || !root) return;
        const after = await takeFingerprint(root);
        if (!after) return;
        try {
            const verdict = await backend().WipeGuardCompare(before, after);
            if (verdict && verdict.level) {
                fireAlarm({level: verdict.level, reason: verdict.reason, paths: []}, '命令前后指纹', root);
            }
        } catch (e) {
            console.warn('[wipeguard] 指纹对比失败（尽力而为）', e);
        }
    }

    // ---- L3 定期快照（设置页 / main.js 的 10 分钟定时器调用）----
    async function snapshotTick() {
        const st = settingsOf();
        if (!st.enabled || !st.snapshots) return null;
        const root = deps.getWsRoot ? deps.getWsRoot() : '';
        if (!root) return null;
        try {
            return await backend().WipeGuardSnapshot(root);
        } catch (e) {
            console.warn('[wipeguard] 定期快照失败（下轮再试）', e);
            return null;
        }
    }

    // ---- 熔断（ai-panel 查询；startSessionTurn 解除）----
    // isWriteBlocked(ws)：按工作区匹配——熔断只禁「被告警的工作区」的写，别的后台会话不受牵连。
    function isWriteBlocked(ws) {
        if (!blocked) return false;
        if (!ws) return true; // 调用方没给工作区：保守拦截
        return normalizeWsKey(ws) === blockedRoot;
    }
    function clearBlocked() {
        blocked = false;
        blockedRoot = '';
    }

    // ---- L1 写前快照（ai-panel 的 write_file / edit_file 在落盘前调用；方案 §4.6）----
    // 原文本已在内存，这里只是转发给 Go 的内容寻址库。失败只进调试日志、绝不阻断写入——
    // 调用方可以 await 而不必再包 try/catch（本方法自身不抛）。
    async function backupWrite(call) {
        const st = settingsOf();
        if (!st.enabled || !call || !call.existed) return null; // 新建文件无原内容可备份
        try {
            return await backend().WipeGuardBackup({
                sessionId: call.sessionId || '',
                tool: call.tool || 'write_file',
                ws: call.ws || (deps.getWsRoot ? deps.getWsRoot() : '') || '',
                relPath: call.relPath || '',
                absPath: call.absPath || '',
                content: call.content || '',
                existed: true,
            });
        } catch (e) {
            console.warn('[wipeguard] 写前备份失败（继续写入，不影响保存）', e);
            return null;
        }
    }

    return {
        syncConfig,
        handleWorkspaceEvent,
        preCommand,
        postCommand,
        backupWrite,
        snapshotTick,
        startCalibrationLoop,
        stopCalibrationLoop,
        isWriteBlocked,
        clearBlocked,
    };
}
