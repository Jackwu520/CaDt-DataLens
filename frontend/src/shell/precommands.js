// precommands.js：工作区预指令控制器——生命周期自动执行 + AI 四动作（审批 / 写入）。
// 事件：workspace-open（打开工作区）/ workspace-close（关闭或切走）/ ai-session-start
// （AI 空会话首轮流起轮前，阻塞等待跑完）；纯函数在 core/precommands.js；存储在
// settings.preCommands（localStorage，AI 没有任何写通道，审批不可绕过）；执行走现成的
// AIRunShellCommand 绑定（envvars 合并 / GBK / 超时钳制 / procctl 可停）。
// 方案见 docs/finished-plans/workspace-precommands.md。
//
// 审批语义（本功能的核心）：四个 app_control 动作里的三个写动作**无条件**弹动作审批卡，
// 与权限档无关（完全权限也不例外）——刻意不做 pluginInstallRoute 那种档位路由；
// 刻意不提供 run_pre_command：AI 要立刻执行走 run_command 的正常审批链，不给借道旁路。

import {
    PRECMD_EVENT,
    PRECMD_MAX_TOTAL,
    PRECMD_MAX_PER_WS,
    normalizePreCommand,
    entriesForWorkspace,
    allEntriesForWorkspace,
    countForWorkspace,
    buildPreCommandApprovalSpec,
    summarizePreCommandRuns,
    eventLabel,
    wsDisplayName,
} from '../core/precommands.js';

export function createPrecommands(deps) {
    // deps：settings / applySettings / backend / sessionPathKey / getWorkspace /
    //       addMessage / activityLog（getter 延迟求值，组合根接线）
    const runningByWs = new Set(); // 重入护栏：同工作区执行中时跳过新触发

    function entriesOf() {
        return Array.isArray(deps.settings.preCommands) ? deps.settings.preCommands : [];
    }

    function requireWorkspace() {
        const ws = String(deps.getWorkspace() || '');
        if (!ws) throw new Error('当前窗口没有打开工作区：预指令绑定工作区，请先打开文件夹');
        return {ws, key: deps.sessionPathKey(ws), name: wsDisplayName(ws)};
    }

    async function requireApproval(requestActionApproval, spec) {
        if (typeof requestActionApproval !== 'function') {
            throw new Error('预指令写入需要用户在界面审批；当前调用没有审批通道，拒绝执行');
        }
        return await requestActionApproval(spec);
    }

    // ---- AI 动作（app_control）----

    function listForAI() {
        const {ws, key} = requireWorkspace();
        const all = entriesOf();
        return {
            workspace: ws,
            // 全部事件条目（含停用）：AI 要能看到三个时机的条目才能 update/remove（审查 P1-3）
            entries: allEntriesForWorkspace(all, key)
                .map((e) => ({
                    id: e.id,
                    event: e.event,
                    command: e.command,
                    timeoutMs: e.timeoutMs,
                    enabled: e.enabled !== false,
                    origin: e.origin === 'ai' ? 'ai' : 'user',
                    createdAt: e.createdAt || 0,
                    lastRunAt: e.lastRunAt || 0,
                    lastCode: e.lastCode == null ? null : e.lastCode,
                })),
            totalAll: all.length,
            note: '写动作（add / update / remove）一律要用户在界面审批（完全权限也不例外）；'
                + 'event 三选一：workspace-open（打开工作区）/ workspace-close（关闭或切走）/ ai-session-start（空会话第一轮流起前）。'
                + '没有「立即执行」动作——要跑命令用 run_command。',
        };
    }

    async function addPreCommand(params, requestActionApproval) {
        const {key, name} = requireWorkspace();
        const all = entriesOf();
        if (all.length >= PRECMD_MAX_TOTAL) {
            throw new Error('预指令已达全局上限 ' + PRECMD_MAX_TOTAL + ' 条，请先删除不用的条目');
        }
        if (countForWorkspace(all, key) >= PRECMD_MAX_PER_WS) {
            throw new Error('工作区「' + name + '」的预指令已达上限 ' + PRECMD_MAX_PER_WS + ' 条');
        }
        // id 一律新生成：AI 传 id 可与既有条目撞车（update/remove 只动第一个命中，审查 P2）
        const norm = normalizePreCommand({...params, id: '', ws: key, origin: 'ai'});
        if (!norm.ok) throw new Error(norm.error);
        const answer = await requireApproval(requestActionApproval,
            buildPreCommandApprovalSpec('add', norm.entry, name));
        if (!answer || !answer.approved) {
            return {added: false, denied: true, note: '用户拒绝了本次预指令新增'};
        }
        deps.settings.preCommands = all.concat([norm.entry]);
        deps.applySettings();
        deps.activityLog.log('precmd.config', norm.entry.id, {op: 'add', origin: 'ai', ws: name}, {noRel: true});
        return {
            added: true,
            id: norm.entry.id,
            command: norm.entry.command,
            timeoutMs: norm.entry.timeoutMs,
            event: norm.entry.event,
            origin: 'ai',
            note: '将在每次打开该工作区时自动执行。',
        };
    }

    async function updatePreCommand(params, requestActionApproval) {
        const {key, name} = requireWorkspace();
        const id = String(params.id == null ? '' : params.id).trim();
        const all = entriesOf();
        const idx = all.findIndex((e) => e && e.id === id);
        if (idx < 0) {
            throw new Error('找不到预指令条目：' + id + '（用 get_pre_commands 查看当前工作区的条目）');
        }
        const prev = all[idx];
        if (String(prev.ws || '') !== key) {
            throw new Error('该条目属于其他工作区：AI 只能修改当前工作区的预指令');
        }
        const norm = normalizePreCommand(params, prev);
        if (!norm.ok) throw new Error(norm.error);
        // AI 不能改绑工作区：params.ws 一律忽略，沿用原绑定（= 当前工作区，防跨工作区投毒，审查 P1-1）
        norm.entry.ws = key;
        // AI 写入 = 最后写入方，origin 归 'ai'（用户在设置页保存会改回 'user'）
        norm.entry.origin = 'ai';
        const answer = await requireApproval(requestActionApproval,
            buildPreCommandApprovalSpec('update', norm.entry, name, prev));
        if (!answer || !answer.approved) {
            return {updated: false, denied: true, note: '用户拒绝了本次预指令修改'};
        }
        deps.settings.preCommands = all.map((e, i) => (i === idx ? norm.entry : e));
        deps.applySettings();
        deps.activityLog.log('precmd.config', norm.entry.id, {op: 'update', origin: 'ai', ws: name}, {noRel: true});
        return {updated: true, id: norm.entry.id, command: norm.entry.command, enabled: norm.entry.enabled !== false};
    }

    async function removePreCommand(params, requestActionApproval) {
        const {key, name} = requireWorkspace();
        const id = String(params.id == null ? '' : params.id).trim();
        const all = entriesOf();
        const prev = all.find((e) => e && e.id === id);
        if (!prev) {
            throw new Error('找不到预指令条目：' + id + '（用 get_pre_commands 查看当前工作区的条目）');
        }
        if (String(prev.ws || '') !== key) {
            throw new Error('该条目属于其他工作区：AI 只能删除当前工作区的预指令');
        }
        const answer = await requireApproval(requestActionApproval,
            buildPreCommandApprovalSpec('remove', prev, name));
        if (!answer || !answer.approved) {
            return {removed: false, denied: true, note: '用户拒绝了本次预指令删除'};
        }
        deps.settings.preCommands = all.filter((e) => e.id !== id);
        deps.applySettings();
        deps.activityLog.log('precmd.config', id, {op: 'remove', origin: 'ai', ws: name}, {noRel: true});
        return {removed: true, id};
    }

    async function handleAppAction(action, params, requestActionApproval) {
        const p = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
        switch (action) {
            case 'get_pre_commands':
                return listForAI();
            case 'add_pre_command':
                return await addPreCommand(p, requestActionApproval);
            case 'update_pre_command':
                return await updatePreCommand(p, requestActionApproval);
            case 'remove_pre_command':
                return await removePreCommand(p, requestActionApproval);
            default:
                throw new Error('未知预指令动作：' + action);
        }
    }

    // ---- 生命周期执行 ----

    /**
     * 通用执行入口：跑某工作区某事件的启用条目（顺序执行，列表序即依赖序）。
     * 重入护栏按「事件 + 工作区」分键：同工作区打开与关闭互不阻塞。
     * 单条失败（异常 / 超时 / 非零退出）不阻断后续；汇总进消息中心 + 留痕。
     */
    async function runEntries(root, event) {
        const dir = String(root || '');
        if (!dir) return {ran: 0};
        if (deps.settings.preCommandsEnabled === false) return {ran: 0, skipped: 'disabled'};
        const key = deps.sessionPathKey(dir);
        const list = entriesForWorkspace(deps.settings.preCommands, key, event);
        if (!list.length) return {ran: 0};
        const guard = event + '\u0000' + key;
        if (runningByWs.has(guard)) {
            deps.activityLog.log('precmd.run', dir, {skipped: 'already-running', event}, {noRel: true});
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
                        entry.command, dir, entry.timeoutMs, 'precmd-' + entry.id, '');
                } catch (e) {
                    error = String((e && e.message) || e) || '执行失败';
                }
                entry.lastRunAt = Date.now();
                entry.lastCode = result ? result.code : null;
                results.push({entry, result, error});
            }
            deps.applySettings(); // 回填 lastRunAt / lastCode（随设置落 localStorage）
            const failed = results.filter((r) => r.error || !r.result || r.result.timedOut || r.result.code !== 0).length;
            deps.activityLog.log('precmd.run', dir,
                {event, total: results.length, failed, aiCount: results.filter((r) => r.entry.origin === 'ai').length},
                {noRel: true});
            deps.addMessage({
                kind: failed ? 'error' : 'success',
                title: '预指令执行完成（' + (event === PRECMD_EVENT ? '' : eventLabel(event) + ' · ') + wsDisplayName(dir) + '）',
                body: summarizePreCommandRuns(results),
            }, {toast: failed > 0});
            return {ran: results.length, failed};
        } finally {
            runningByWs.delete(guard);
        }
    }

    // 打开工作区（openFolderWorkspace 挂点：对话框 / 启动恢复 / AI open_folder 全走这里）
    function runForWorkspace(dir) {
        return runEntries(dir, PRECMD_EVENT);
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
        return runEntries(ws, 'ai-session-start');
    }

    return {runForWorkspace, runForWorkspaceClose, runForAISessionStart, handleAppAction};
}
