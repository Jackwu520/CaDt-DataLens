// lifecycle-hooks.js：工作区生命周期钩子控制器——9 个事件自动执行 + AI 四动作（审批 / 写入）。
// 工作区级：workspace-open / workspace-close；AI 级：session-start（原 ai-session-start）
// / user-prompt-submit / pre-tool-use / post-tool-use / post-tool-use-failure / permission-request / stop。
// 工具级事件按 matchTools 过滤工具名；阻塞型（session-start / user-prompt-submit /
// pre-tool-use / permission-request）await 跑完才继续，其余 fire-and-forget。
// 纯函数在 core/lifecycle-hooks.js；存储在 settings.lifecycleHooks（localStorage，AI 没有任何
// 写通道，审批不可绕过）；执行走 AIRunShellCommand 绑定（envvars 合并 / GBK / 超时钳制）。
// 方案见 docs/finished-plans/workspace-lifecycle-hooks.md。
//
// 审批语义（本功能的核心）：四个 app_control 动作里的三个写动作**无条件**弹动作审批卡，
// 与权限档无关（完全权限也不例外）——刻意不做 pluginInstallRoute 那种档位路由；
// 刻意不提供 run 动作：AI 要验证命令直接走 run_command（full 档直通更快、工具卡更详
// 细），按条目执行没有独立价值；设置页列表行的「运行」按钮是用户手动验证入口（无审批）。
//
// 动作名 2026-11-21 由 get_pre_commands / add_pre_command / update_pre_command /
// remove_pre_command 改为 *_lifecycle_hook（旧名保留为静默别名：技能表不再下发，
// 但老会话/记忆里的调用仍能命中同一分支）。
import {
    LIFECYCLE_HOOK_EVENT,
    LIFECYCLE_HOOK_MAX_TOTAL,
    LIFECYCLE_HOOK_MAX_PER_WS,
    normalizeLifecycleHook,
    entriesForWorkspace,
    allEntriesForWorkspace,
    isToolEvent,
    toolMatches,
    countForWorkspace,
    buildLifecycleHookApprovalSpec,
    summarizeLifecycleHookRuns,
    eventLabel,
    wsDisplayName,
} from '../core/lifecycle-hooks.js';

export function createLifecycleHooks(deps) {
    // deps：settings / applySettings / backend / sessionPathKey / getWorkspace /
    //       addMessage / activityLog（getter 延迟求值，组合根接线）
    const runningByWs = new Set(); // 重入护栏：同工作区执行中时跳过新触发

    function entriesOf() {
        return Array.isArray(deps.settings.lifecycleHooks) ? deps.settings.lifecycleHooks : [];
    }

    function requireWorkspace() {
        const ws = String(deps.getWorkspace() || '');
        if (!ws) throw new Error('当前窗口没有打开工作区：命令绑定工作区，请先打开文件夹');
        return {ws, key: deps.sessionPathKey(ws), name: wsDisplayName(ws)};
    }

    async function requireApproval(requestActionApproval, spec) {
        if (typeof requestActionApproval !== 'function') {
            throw new Error('写入需要用户在界面审批；当前调用没有审批通道，拒绝执行');
        }
        return await requestActionApproval(spec);
    }

    // ---- AI 动作（app_control）----

    function listForAI() {
        const {ws, key} = requireWorkspace();
        const all = entriesOf();
        return {
            workspace: ws,
            // 全部事件条目（含停用）：AI 要能看到 9 事件的条目才能 update/remove（审查 P1-3）
            entries: allEntriesForWorkspace(all, key)
                .map((e) => ({
                    id: e.id,
                    event: e.event,
                    command: e.command,
                    timeoutMs: e.timeoutMs,
                    enabled: e.enabled !== false,
                    matchTools: Array.isArray(e.matchTools) ? e.matchTools : [],
                    origin: e.origin === 'ai' ? 'ai' : 'user',
                    createdAt: e.createdAt || 0,
                    lastRunAt: e.lastRunAt || 0,
                    lastCode: e.lastCode == null ? null : e.lastCode,
                })),
            totalAll: all.length,
            note: '写动作（add / update / remove）一律要用户在界面审批（完全权限也不例外）；'
                + 'event 共 9 个：workspace-open 打开 / workspace-close 关闭 / session-start 会话开始 / '
                + 'user-prompt-submit 提交输入 / stop 停止 / pre-tool-use 工具前 / post-tool-use 工具后 / '
                + 'post-tool-use-failure 工具失败 / permission-request 权限请求。'
                + '工具级事件用 matchTools（工具名数组，空=全部，mcp__* 通配）。'
                + '没有「立即执行」动作——要跑命令用 run_command。',
        };
    }

    async function addLifecycleHook(params, requestActionApproval) {
        const {key, name} = requireWorkspace();
        const all = entriesOf();
        if (all.length >= LIFECYCLE_HOOK_MAX_TOTAL) {
            throw new Error('已达全局上限 ' + LIFECYCLE_HOOK_MAX_TOTAL + ' 条，请先删除不用的条目');
        }
        if (countForWorkspace(all, key) >= LIFECYCLE_HOOK_MAX_PER_WS) {
            throw new Error('工作区「' + name + '」已达上限 ' + LIFECYCLE_HOOK_MAX_PER_WS + ' 条');
        }
        // id 一律新生成：AI 传 id 可与既有条目撞车（update/remove 只动第一个命中，审查 P2）
        const norm = normalizeLifecycleHook({...params, id: '', ws: key, origin: 'ai'});
        if (!norm.ok) throw new Error(norm.error);
        const answer = await requireApproval(requestActionApproval,
            buildLifecycleHookApprovalSpec('add', norm.entry, name));
        if (!answer || !answer.approved) {
            return {added: false, denied: true, note: '用户拒绝了本次新增'};
        }
        deps.settings.lifecycleHooks = all.concat([norm.entry]);
        deps.applySettings();
        deps.activityLog.log('lifecycle.config', norm.entry.id, {op: 'add', origin: 'ai', ws: name}, {noRel: true});
        return {
            added: true,
            id: norm.entry.id,
            command: norm.entry.command,
            timeoutMs: norm.entry.timeoutMs,
            event: norm.entry.event,
            origin: 'ai',
            note: '将在「' + eventLabel(norm.entry.event) + '」时自动执行。',
        };
    }

    async function updateLifecycleHook(params, requestActionApproval) {
        const {key, name} = requireWorkspace();
        const id = String(params.id == null ? '' : params.id).trim();
        const all = entriesOf();
        const idx = all.findIndex((e) => e && e.id === id);
        if (idx < 0) {
            throw new Error('找不到条目：' + id + '（用 get_lifecycle_hooks 查看当前工作区的条目）');
        }
        const prev = all[idx];
        if (String(prev.ws || '') !== key) {
            throw new Error('该条目属于其他工作区：AI 只能修改当前工作区的条目');
        }
        const norm = normalizeLifecycleHook(params, prev);
        if (!norm.ok) throw new Error(norm.error);
        // AI 不能改绑工作区：params.ws 一律忽略，沿用原绑定（= 当前工作区，防跨工作区投毒，审查 P1-1）
        norm.entry.ws = key;
        // AI 写入 = 最后写入方，origin 归 'ai'（用户在设置页保存会改回 'user'）
        norm.entry.origin = 'ai';
        const answer = await requireApproval(requestActionApproval,
            buildLifecycleHookApprovalSpec('update', norm.entry, name, prev));
        if (!answer || !answer.approved) {
            return {updated: false, denied: true, note: '用户拒绝了本次修改'};
        }
        deps.settings.lifecycleHooks = all.map((e, i) => (i === idx ? norm.entry : e));
        deps.applySettings();
        deps.activityLog.log('lifecycle.config', norm.entry.id, {op: 'update', origin: 'ai', ws: name}, {noRel: true});
        return {updated: true, id: norm.entry.id, command: norm.entry.command, enabled: norm.entry.enabled !== false};
    }

    async function removeLifecycleHook(params, requestActionApproval) {
        const {key, name} = requireWorkspace();
        const id = String(params.id == null ? '' : params.id).trim();
        const all = entriesOf();
        const prev = all.find((e) => e && e.id === id);
        if (!prev) {
            throw new Error('找不到条目：' + id + '（用 get_lifecycle_hooks 查看当前工作区的条目）');
        }
        if (String(prev.ws || '') !== key) {
            throw new Error('该条目属于其他工作区：AI 只能删除当前工作区的条目');
        }
        const answer = await requireApproval(requestActionApproval,
            buildLifecycleHookApprovalSpec('remove', prev, name));
        if (!answer || !answer.approved) {
            return {removed: false, denied: true, note: '用户拒绝了本次删除'};
        }
        deps.settings.lifecycleHooks = all.filter((e) => e.id !== id);
        deps.applySettings();
        deps.activityLog.log('lifecycle.config', id, {op: 'remove', origin: 'ai', ws: name}, {noRel: true});
        return {removed: true, id};
    }

    // 单条执行（设置页「运行」按钮的通路）：结果落 lastRunAt/lastCode +
    // 消息中心 + 留痕；重入键带 once 前缀，与事件批量执行互不阻塞
    async function executeOne(ws, name, prev, guardTag) {
        const key = deps.sessionPathKey(ws);
        const runningKey = (guardTag || 'run-once') + '\u0000' + key + '\u0000' + prev.id;
        if (runningByWs.has(runningKey)) {
            return {ran: false, skipped: 'running', note: '该条目正在执行，稍后再试'};
        }
        runningByWs.add(runningKey);
        try {
            let result = null;
            let error = '';
            try {
                result = await deps.backend.AIRunShellCommand(
                    prev.command, ws, prev.timeoutMs, 'lifecycle-' + prev.id, '');
            } catch (e) {
                error = String((e && e.message) || e) || '执行失败';
            }
            prev.lastRunAt = Date.now();
            prev.lastCode = result ? result.code : null;
            deps.applySettings();
            const failed = error || !result || result.timedOut || result.code !== 0;
            deps.activityLog.log('lifecycle.run', ws,
                {event: prev.event, tool: '', total: 1, failed: failed ? 1 : 0,
                 aiCount: prev.origin === 'ai' ? 1 : 0, runOnce: true},
                {noRel: true});
            deps.addMessage({
                kind: failed ? 'error' : 'success',
                title: '生命周期执行完成（' + eventLabel(prev.event) + ' · ' + name + '）',
                body: summarizeLifecycleHookRuns([{entry: prev, result, error}]),
            }, {toast: !!failed});
            return {ran: true, code: result ? result.code : null, failed};
        } finally {
            runningByWs.delete(runningKey);
        }
    }

    // 用户入口：设置页列表行「运行」按钮——按条目 id 单条执行一次（无审批，纯用户操作；
    // 仅用户入口）
    function runOnceForEntry(entryId, workspace) {
        const ws = String(workspace || '');
        if (!ws) return Promise.resolve({ran: 0, skipped: 'no-workspace'});
        const key = deps.sessionPathKey(ws);
        const entry = (Array.isArray(deps.settings.lifecycleHooks) ? deps.settings.lifecycleHooks : [])
            .find((e) => e && e.id === String(entryId || '') && String(e.ws || '') === key);
        if (!entry) return Promise.resolve({ran: 0, skipped: 'not-found'});
        return executeOne(ws, wsDisplayName(ws), entry, 'run-once');
    }

    // 动作分发：新名与旧名（pre-command 时代）走同一分支——旧名只做兼容，不再写进技能表
    async function handleAppAction(action, params, requestActionApproval) {
        const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
        switch (action) {
            case 'get_lifecycle_hooks':
            case 'get_pre_commands':
                return listForAI();
            case 'add_lifecycle_hook':
            case 'add_pre_command':
                return await addLifecycleHook(p, requestActionApproval);
            case 'update_lifecycle_hook':
            case 'update_pre_command':
                return await updateLifecycleHook(p, requestActionApproval);
            case 'remove_lifecycle_hook':
            case 'remove_pre_command':
                return await removeLifecycleHook(p, requestActionApproval);
            default:
                throw new Error('未知动作：' + action);
        }
    }

    // ---- 生命周期执行 ----

    /**
     * 通用执行入口：跑某工作区某事件的启用条目（顺序执行，列表序即依赖序）。
     * 重入护栏按「事件 + 工作区」分键：同工作区打开与关闭互不阻塞。
     * 单条失败（异常 / 超时 / 非零退出）不阻断后续；汇总进消息中心 + 留痕。
     */
    async function runEntries(root, event, toolName) {
        const dir = String(root || '');
        if (!dir) return {ran: 0};
        if (deps.settings.lifecycleHooksEnabled === false) return {ran: 0, skipped: 'disabled'};
        const key = deps.sessionPathKey(dir);
        // 事件兼容：老数据的 ai-session-start 等同 session-start
        const matchesEvent = (e) => e === event || (event === 'session-start' && e === 'ai-session-start');
        let list = (Array.isArray(deps.settings.lifecycleHooks) ? deps.settings.lifecycleHooks : [])
            .filter((e) => e && e.enabled !== false && String(e.ws || '') === key && matchesEvent(e.event));
        // 工具级事件：按工具名匹配器过滤（空匹配器 = 匹配全部工具）
        if (isToolEvent(event)) {
            list = list.filter((e) => toolMatches(e, toolName));
        }
        if (!list.length) return {ran: 0};
        // 重入护栏按「事件 + 工作区」分键；工具级事件把工具名也带上，
        // 避免同工作区不同工具的钩子互相阻塞
        const guard = event + '\u0000' + key + (isToolEvent(event) ? '\u0000' + String(toolName || '') : '');
        if (runningByWs.has(guard)) {
            deps.activityLog.log('lifecycle.run', dir, {skipped: 'already-running', event, tool: toolName || ''}, {noRel: true});
            return {ran: 0, skipped: 'running'};
        }
        runningByWs.add(guard);
        try {
            // 顺序执行：列表序即依赖序；单条失败不阻断后续与宿主流程
            const results = [];
            for (const entry of list) {
                let result = null;
                let error = '';
                try {
                    result = await deps.backend.AIRunShellCommand(
                        entry.command, dir, entry.timeoutMs, 'lifecycle-' + entry.id, '');
                } catch (e) {
                    error = String((e && e.message) || e) || '执行失败';
                }
                entry.lastRunAt = Date.now();
                entry.lastCode = result ? result.code : null;
                results.push({entry, result, error});
            }
            deps.applySettings(); // 回填 lastRunAt / lastCode（随设置落 localStorage）
            const failed = results.filter((r) => r.error || !r.result || r.result.timedOut || r.result.code !== 0).length;
            deps.activityLog.log('lifecycle.run', dir,
                {event, tool: toolName || '', total: results.length, failed,
                 aiCount: results.filter((r) => r.entry.origin === 'ai').length},
                {noRel: true});
            deps.addMessage({
                kind: failed ? 'error' : 'success',
                title: '生命周期执行完成（' + (event === LIFECYCLE_HOOK_EVENT ? '' : eventLabel(event) + ' · ') + wsDisplayName(dir) + '）',
                body: summarizeLifecycleHookRuns(results),
            }, {toast: failed > 0});
            return {ran: results.length, failed};
        } finally {
            runningByWs.delete(guard);
        }
    }

    // 通用入口：main.js 把 9 个事件都经此挂到 ai-panel / 工作区生命周期
    function runForEvent(root, event, toolName) {
        return runEntries(root, event, toolName);
    }

    // 打开工作区（openFolderWorkspace 挂点：对话框 / 启动恢复 / AI open_folder 全走这里）
    function runForWorkspace(dir) {
        return runEntries(dir, LIFECYCLE_HOOK_EVENT);
    }

    // 关闭工作区（closeFolder 显式关闭 + openFolderWorkspace 切走旧目录）。fire-and-forget：
    // 宿主流程不等它；应用整体退出没有可靠的等待窗口，close 条目可能被杀（方案 §6 已注明）。
    function runForWorkspaceClose(dir) {
        return runEntries(dir, 'workspace-close');
    }

    // AI 会话开始（ai-panel 空会话首轮流注入点）：起轮前 await，跑完才发首轮请求——
    // 「开始前」语义要求阻塞；每条自带超时上限，失败不阻塞起轮。控制器内部已兜错，
    // 调用方（ai-panel）另有 try/catch 双保险。
    function runForAISessionStart(ws) {
        return runEntries(ws, 'session-start');
    }

    return {runForEvent, runForWorkspace, runForWorkspaceClose, runForAISessionStart, runOnceForEntry, handleAppAction};
}
