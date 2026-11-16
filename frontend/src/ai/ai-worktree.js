// ai-worktree.js：AI 隔离工作区（git worktree）域模块——worktree_manage 工具执行、
// 会话态（session.worktree）、<worktree> 注入块文本、头部状态胶囊。
// 设计见 docs/unfinished-plans/git-worktree.md：worktree 固定建在 <主根>/.cadt/worktree/<slug>，
// 一会话一个（独占）；回灌 = Go 导出 diff → PatchSave(主根) → patch 审批卡（全档必弹）→ 应用；
// 丢弃 = worktree remove --force + 删隔离分支。路径一律显式长路径，不做前缀注入。
import {aiTextOf} from './ai-constants.js';

export const WORKTREE_REL_DIR = '.cadt/worktree';
// 补丁超过此长度拒绝导出（与 propose_patch 的传输上限一致，防一次导出撑爆上下文）
export const WORKTREE_PATCH_LIMIT = 256 * 1024;

// 会话态归一（单一来源；ai-session-store 的 meta 序列化与 ai-panel 的 normalizeSession 共用）
export function normalizeWorktreeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = aiTextOf(raw.name).trim();
    if (!name) return null;
    return {
        name,
        branch: aiTextOf(raw.branch),
        path: aiTextOf(raw.path),
        baseSha: aiTextOf(raw.baseSha),
        createdAt: Number(raw.createdAt) || 0,
    };
}

// 隔离区相对路径前缀（AI 文案与提示词块用）
export function worktreeRelPath(name) {
    return WORKTREE_REL_DIR + '/' + name;
}

// 子代理隔离写闸（纯函数）：wt 为子代理会话登记的隔离区，relPath 为相对主根的路径。
// 前缀内 allow（自动应用——隔离区即审批边界），前缀外 deny（确定性拒绝，不进审批链）。
export function agentWorktreeWriteVerdict(wt, relPath) {
    if (!wt || !wt.name) {
        return {verdict: 'deny', message: '【worktree:error】WORKTREE_SCOPE：子代理没有隔离工作区登记，不能写文件。'};
    }
    const prefix = (WORKTREE_REL_DIR + '/' + wt.name).toLowerCase();
    const relLower = String(relPath || '').toLowerCase();
    if (relLower === prefix || relLower.startsWith(prefix + '/')) return {verdict: 'allow'};
    return {
        verdict: 'deny',
        message: '【worktree:error】WORKTREE_SCOPE：子代理只能写自己的隔离前缀 ' + worktreeRelPath(wt.name)
            + '/…（当前：' + relPath + '）。不要写其他路径，把该限制与未完成项写进结论上报主代理。',
    };
}

// worktree_manage by-name 目标解析（纯函数）：own 为会话自己的隔离区登记，subWorktrees
// 为本会话派生子代理的隔离区登记。缺省（不带 name）= 自己的；带 name 只认本会话拥有的；
// 其余（其他会话的隔离区）返回 null——归属外不可触碰。
export function resolveWorktreeTarget(own, subWorktrees, requestedName) {
    const ownNorm = normalizeWorktreeState(own);
    const wanted = String(requestedName || '').trim().toLowerCase();
    if (!wanted) return ownNorm ? {wt: ownNorm, own: true} : null;
    if (ownNorm && String(ownNorm.name).toLowerCase() === wanted) return {wt: ownNorm, own: true};
    const hit = (subWorktrees || []).find((w) => w && String(w.name).toLowerCase() === wanted && w.baseSha);
    if (hit) return {wt: {name: hit.name, baseSha: hit.baseSha}, own: false};
    return null;
}

// <worktree> 注入块（给模型看的稳定区提示词；仅 session.worktree 存在时注入）
export function worktreeBlockText(wt) {
    if (!wt || !wt.name) return '';
    return [
        '<worktree>',
        '本会话正在隔离工作区中改代码：所有文件改动写到 ' + worktreeRelPath(wt.name) + '/…（相对范围根），不要改主根同名文件。',
        '- run_command 的 cwd 传 ' + worktreeRelPath(wt.name) + '；git 命令会自动作用于该 worktree 的分支 ' + (wt.branch || '隔离分支') + '。',
        '- 依赖目录（node_modules / .venv / venv）已通过 junction 共享主根：npm / pip 可直接使用与安装（写的就是主根依赖目录）；Go 无需共享（模块与构建缓存在用户级）。测试仍可能因环境差异失败，不要反复重装依赖。',
        '- 完成后调 worktree_manage(action=export) 生成补丁交用户审阅回灌主根；应用成功后建议 discard 收尾。不要 commit 到隔离分支：worktree 是草稿区，分支不保留。',
        '</worktree>',
    ].join('\n');
}

// worktree 列表格式化（list 工具的输出；orphan 由前端算——登记之外的 .cadt/worktree 条目）。
// sessions 为全量会话列表（含 _stub 占位：meta 里有 worktree 字段即可参与判定）。
// stats 为 relPath → git diff --stat 尾行（未提交改动量；对比多个隔离区用），缺失项不打统计。
export function formatWorktreeList(result, sessions, stats) {
    if (!result || !result.available) {
        return '【worktree】git 不可用或不在仓库内：' + ((result && result.reason) || '未知原因');
    }
    const registered = new Set();
    for (const session of sessions || []) {
        const wt = session && session.worktree;
        if (wt && wt.path) registered.add(String(wt.path).toLowerCase());
    }
    const lines = ['【worktree】仓库现有 worktree ' + ((result.items || []).length) + ' 个：'];
    for (const item of result.items || []) {
        const tags = [];
        if (item.underCadt) tags.push('隔离区');
        if (item.underCadt && item.path && !registered.has(String(item.path).toLowerCase())) tags.push('孤儿（无会话登记，可 discard 或手动删）');
        const stat = item.underCadt && stats && stats[item.relPath];
        lines.push('- ' + (item.relPath || item.path) + (item.branch ? '（分支 ' + item.branch + '）' : '（detached/bare）')
            + (tags.length ? ' [' + tags.join('，') + ']' : '')
            + (stat ? '\n    改动：' + stat : ''));
    }
    lines.push('说明：AI 隔离区固定在 ' + WORKTREE_REL_DIR + '/<slug>，分支前缀 cadt/wt/；改动统计对比的是各 worktree 自己的 HEAD（未提交量）；孤儿 worktree 一期不自动清理。');
    return lines.join('\n');
}

export function createAIWorktree(deps) {
    const backend = deps.backend;
    const getScopeRoot = () => deps.getScopeRoot();
    const currentSession = () => deps.currentSession();
    const currentScopeOf = deps.currentScopeOf;
    const persistSessions = () => deps.persistSessions();
    const flash = deps.flash || (() => {});
    const requestPatchApproval = (...args) => deps.requestPatchApproval(...args);
    const patchResultText = (...args) => deps.patchResultText(...args);
    const recordChange = (...args) => deps.recordChange(...args);
    const notifyFileChanged = (...args) => deps.notifyFileChanged(...args);
    const refreshToolWrap = (...args) => deps.refreshToolWrap(...args);
    const toolHalted = (...args) => deps.toolHalted(...args);
    const logPermission = (...args) => deps.logPermission(...args);
    const getSessions = () => deps.getSessions();
    // 本会话派生的子代理隔离区 [{name, baseSha}]：export/discard by name 的归属判定
    const getSubWorktrees = (...args) => deps.getSubWorktrees ? deps.getSubWorktrees(...args) : [];
    const joinPath = (...args) => deps.joinPath(...args);
    const openDialog = deps.openDialog;
    const closeDialog = deps.closeDialog;
    const dialogNode = deps.dialogNode;
    const dialogButton = deps.dialogButton;
    const chip = deps.chip || null;

    // ---------- 确认弹窗（Promise 化；Esc / 关闭 / 取消都按放弃处理） ----------
    // message 可传字符串或 Promise<string>（如胶囊弹层先取改动统计再渲染文案）。
    function confirmDialog({title, message, messagePromise, confirmLabel, danger}) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (value) => {
                if (settled) return;
                settled = true;
                if (observer) observer.disconnect();
                resolve(value);
            };
            // 居中弹窗可能被 Esc / 右上角 × 关闭（ai-panel 直接加 hidden）：监听后按放弃收敛
            let observer = null;
            if (deps.dialogEl) {
                observer = new MutationObserver(() => {
                    if (deps.dialogEl.classList.contains('hidden')) done(false);
                });
                observer.observe(deps.dialogEl, {attributes: true, attributeFilter: ['class']});
            }
            Promise.resolve(messagePromise || message).then((text) => {
                if (settled) return;
                openDialog(title, [dialogNode('div', 'ai-dialog-text', text)], [
                    dialogButton('取消', 'dlg-btn', () => done(false)),
                    dialogButton(confirmLabel, 'dlg-btn ' + (danger ? 'danger' : 'primary'), () => done(true)),
                ]);
            }).catch(() => done(false));
        });
    }

    // ---------- 会话态与胶囊 ----------

    function syncChip(session) {
        if (!chip) return;
        const wt = session && session.worktree;
        if (!wt || !wt.name) {
            chip.classList.add('hidden');
            return;
        }
        chip.classList.remove('hidden');
        const label = chip.querySelector('.ai-chip-label');
        if (label) label.textContent = '隔离区 ' + wt.name;
    }

    function openChipDialog() {
        const session = currentSession();
        const wt = session && session.worktree;
        if (!wt || !wt.name) return;
        // 只读取一次改动统计（尽力而为）：让用户在弹层里先看隔离区改了什么再决定丢弃
        let statText = '';
        const statPromise = backend.GitWorktreeStat
            ? backend.GitWorktreeStat(getScopeRoot(), wt.name, wt.baseSha).catch(() => '')
            : Promise.resolve('');
        statPromise.then((stat) => {
            statText = stat;
        });
        confirmDialog({
            title: '隔离工作区',
            messagePromise: statPromise.then((stat) => '本会话的改动落在 ' + worktreeRelPath(wt.name) + '/（分支 ' + (wt.branch || '隔离分支') + '）。\n'
                + (stat ? '改动统计：\n' + stat + '\n\n' : '')
                + '让 AI 执行 worktree_manage(action=export) 生成补丁审阅回灌；丢弃将删除 worktree 与分支，未导出的改动会丢失。'),
            confirmLabel: '丢弃隔离区',
            danger: true,
        }).then(async (ok) => {
            if (!ok) return;
            const root = getScopeRoot();
            try {
                await backend.GitWorktreeRemove(root, wt.name, true);
            } catch (e) {
                flash('丢弃失败：' + ((e && e.message) || e), true);
                return;
            }
            const target = currentSession();
            if (target && target.worktree && target.worktree.name === wt.name) {
                target.worktree = null;
                persistSessions();
                syncChip(target);
            }
            flash('已丢弃隔离工作区 ' + wt.name);
        });
    }

    function mountChip() {
        if (!chip) return;
        chip.addEventListener('click', openChipDialog);
    }

    // 启动 reconcile：清 git 侧失效 worktree 记录（不动现存目录）。尽力而为。
    async function pruneStartup() {
        const root = getScopeRoot();
        if (!root || !backend.GitWorktreePrune) return;
        try {
            await backend.GitWorktreePrune(root);
        } catch (e) {} // 无 git / 非仓库时静默（这是尽力而为的清理）
    }

    // 恢复校验：会话登记的 worktree 目录已不存在（被手动删 / prune 过）时清字段，
    // 返回给注入块的提示；目录仍在时返回 <worktree> 块。由 assembleSystemContext 每轮调用。
    async function blockFor(session) {
        const wt = normalizeWorktreeState(session && session.worktree);
        if (!wt) return '';
        let exists = true;
        try {
            if (backend.GetPathInfo) await backend.GetPathInfo(wt.path);
        } catch (e) {
            exists = false;
        }
        if (!exists) {
            session.worktree = null;
            persistSessions();
            syncChip(currentSession() === session ? session : null);
            return [
                '<worktree>',
                '本会话此前登记的隔离工作区 ' + worktreeRelPath(wt.name) + ' 已不存在（被手动删除或清理），登记已清除。',
                '需要隔离时重新调 worktree_manage(action=create)。',
                '</worktree>',
            ].join('\n');
        }
        return worktreeBlockText(wt);
    }

    // ---------- worktree_manage 工具执行 ----------

    const deny = (code, message, detail) => '【worktree:error】' + code + '：' + message + (detail ? '\n' + detail : '');

    async function manageTool(ctx, input) {
        const action = aiTextOf(input && input.action).trim();
        const session = ctx && ctx.session;
        const toolMessage = ctx && ctx.toolMessage;
        switch (action) {
            case 'create':
                return manageCreate(session, toolMessage, input);
            case 'list':
                return manageList();
            case 'stat':
                return manageStat(session, input);
            case 'export':
                return manageExport(ctx, input);
            case 'discard':
                return manageDiscard(session, toolMessage, input);
            default:
                return deny('WORKTREE_ACTION', '未知 action：' + (action || '（空）') + '，可用 create / list / stat / export / discard');
        }
    }

    function requireWriteSession(session) {
        if (!session) return '缺少会话上下文';
        const root = getScopeRoot();
        if (!root) return '当前没有工作区范围：隔离工作区建在主根的 .cadt/worktree/ 下，请先打开文件夹';
        return '';
    }

    // 解析操作目标：默认本会话自己的隔离区；带 name 时允许「本会话派生的子代理隔离区」
    // （登记外的一律拒绝——别的会话的隔离区不可触碰）。返回 {wt, own} 或 null。
    function resolveTarget(session, requestedName) {
        return resolveWorktreeTarget(session && session.worktree, getSubWorktrees(session ? session.id : ''), requestedName);
    }

    async function manageCreate(session, toolMessage, input) {
        const missing = requireWriteSession(session);
        if (missing) return deny('WORKTREE_CONTEXT', missing);
        const root = getScopeRoot();
        if (session.worktree && normalizeWorktreeState(session.worktree)) {
            const wt = session.worktree;
            return deny('WORKTREE_EXISTS', '本会话已有隔离工作区 ' + worktreeRelPath(wt.name)
                + '（一会话一个）', '先 export 回灌或 discard 丢弃后再创建新的');
        }
        const label = aiTextOf(input && input.label).trim().slice(0, 80);
        // 确认卡：创建 = 大量写盘 + 建分支。full 档免（写 .cadt/worktree 在档位契约内），其余确认。
        const scope = currentScopeOf(session);
        let confirmed = true;
        if (scope !== 'full') {
            confirmed = await confirmDialog({
                title: '创建隔离工作区',
                message: 'AI 请求创建隔离 git worktree：改动将落在 ' + WORKTREE_REL_DIR + '/<slug>/（新分支 cadt/wt/<slug>），'
                    + '不影响主根；产物经补丁审批卡回灌。',
                confirmLabel: '创建',
                danger: false,
            });
            logPermission('worktree', WORKTREE_REL_DIR, confirmed ? 'approved' : 'denied', 'confirm', '');
            if (!confirmed) return '用户取消了隔离工作区创建。如仍有需要，请说明用途后再次请求。';
        }
        if (toolHalted(toolMessage)) return '用户已停止生成，创建已取消。';
        let added;
        try {
            added = await backend.GitWorktreeAdd(root, label, session.id || '');
        } catch (e) {
            return deny('WORKTREE_ADD', '创建失败', String((e && e.message) || e));
        }
        session.worktree = normalizeWorktreeState({
            name: added.name,
            branch: added.branch,
            path: added.path,
            baseSha: added.baseSha,
            createdAt: Date.now(),
        });
        persistSessions();
        syncChip(session);
        flash('已创建隔离工作区 ' + added.name);
        const depsNote = Array.isArray(added.deps) && added.deps.length
            ? '- 已 junction 共享主根依赖：' + added.deps.join('、') + '（npm / pip 可直接使用；写入的就是主根依赖目录）。\n'
            : '';
        const depErrNote = Array.isArray(added.depErrors) && added.depErrors.length
            ? '- 依赖共享失败项：' + added.depErrors.join('；') + '（不阻塞，可手动处理）。\n'
            : '';
        return [
            '已创建隔离工作区：' + worktreeRelPath(added.name) + '/（分支 ' + added.branch + '，基准 ' + added.baseSha.slice(0, 10) + '）。',
            '从现在起：',
            '- 所有文件改动写到 ' + worktreeRelPath(added.name) + '/…（相对范围根），不要改主根同名文件。',
            '- run_command 的 cwd 传 ' + worktreeRelPath(added.name) + '；git 命令会作用于该 worktree 的分支。',
            depsNote + depErrNote +
            '- 完成后调 worktree_manage(action=export) 生成补丁交用户审阅回灌；不要 commit 到隔离分支。',
        ].join('\n');
    }

    // 单个 worktree 的未提交改动统计尾行（尽力而为，失败返回空串）
    async function statLineOf(relPath) {
        if (!backend.GitWorktreeStat) return '';
        const slug = String(relPath || '').split('/').pop();
        try {
            const stat = await backend.GitWorktreeStat(getScopeRoot(), slug, '');
            const tail = String(stat || '').trim().split('\n').filter(Boolean).pop();
            return tail || '';
        } catch (e) {
            return '';
        }
    }

    async function manageList() {
        const root = getScopeRoot();
        if (!root) return deny('WORKTREE_CONTEXT', '当前没有工作区范围');
        try {
            const result = await backend.GitWorktreeList(root);
            // 对比 lite：给每个隔离区取一行未提交改动统计（外部 worktree 无基准，按 HEAD 对比）
            const stats = {};
            for (const item of result.items || []) {
                if (item.underCadt && item.relPath) {
                    stats[item.relPath] = await statLineOf(item.relPath);
                }
            }
            return formatWorktreeList(result, getSessions(), stats);
        } catch (e) {
            return deny('WORKTREE_LIST', '查询失败', String((e && e.message) || e));
        }
    }

    async function manageStat(session, input) {
        const root = getScopeRoot();
        if (!root) return deny('WORKTREE_CONTEXT', '当前没有工作区范围');
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管', '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区');
            return deny('WORKTREE_NONE', '本会话没有隔离工作区', '先 worktree_manage(action=create) 创建');
        }
        const wt = target.wt;
        try {
            const stat = await backend.GitWorktreeStat(root, wt.name, wt.baseSha);
            if (!String(stat || '').trim()) {
                return 'worktree 没有改动（相对创建基准无差异）。';
            }
            return '隔离区 ' + worktreeRelPath(wt.name) + ' 相对创建基准的改动统计：\n' + String(stat).trim();
        } catch (e) {
            return deny('WORKTREE_STAT', '统计失败', String((e && e.message) || e));
        }
    }

    async function manageExport(ctx, input) {
        const session = ctx && ctx.session;
        const toolMessage = ctx && ctx.toolMessage;
        const missing = requireWriteSession(session);
        if (missing) return deny('WORKTREE_CONTEXT', missing);
        const root = getScopeRoot();
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) {
                return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管',
                    '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区（可用 list 查看）');
            }
            return deny('WORKTREE_NONE', '本会话没有隔离工作区', '先 worktree_manage(action=create) 创建');
        }
        const wt = target.wt;
        let diffText = '';
        try {
            diffText = await backend.GitWorktreeDiff(root, wt.name, wt.baseSha);
        } catch (e) {
            const msg = String((e && e.message) || e);
            if (msg.includes('没有改动')) {
                return 'worktree 没有改动（相对创建基准无差异）：先在 ' + worktreeRelPath(wt.name) + '/ 里做修改，再导出。';
            }
            return deny('WORKTREE_DIFF', '导出 diff 失败', msg);
        }
        if (diffText.length > WORKTREE_PATCH_LIMIT) {
            return deny('WORKTREE_LIMIT', '改动太大（' + Math.round(diffText.length / 1024) + ' KB，上限 256 KB）',
                '请把批量改动拆成多轮，每轮 export 后 discard 再开新的隔离区');
        }
        if (toolHalted(toolMessage)) return '用户已停止生成，导出已取消。';
        let preview;
        try {
            preview = await backend.PatchSave(root, 'worktree 回灌：' + wt.name, diffText);
        } catch (e) {
            return deny('PATCH_PARSE', '补丁无法解析或路径不合法', String((e && e.message) || e));
        }
        const okFiles = (preview.files || []).filter((f) => f.status === 'ok');
        if (!okFiles.length) {
            const first = (preview.files || []).find((f) => f.reason) || {};
            return deny('PATCH_HUNK_CONFLICT', '补丁已保存但没有任何文件可直接应用：' + (first.relPath || '')
                    + (first.reason ? '（' + first.reason + '）' : ''),
                '主根在隔离期间被改过时会如实报错（严格匹配）；可重新导出或人工比对。补丁文件：' + (preview.patchPath || ''));
        }
        // 回灌闸门：全档必弹（含 full）——人工审阅是本功能的红线
        const decision = await requestPatchApproval(session, toolMessage, preview, true);
        if (!decision.approved) {
            return decision.cancelled
                ? deny('WORKTREE_DENIED', '用户停止了生成，补丁未应用', '补丁文件已保留：' + (preview.patchPath || ''))
                : deny('WORKTREE_DENIED', '用户放弃了本次回灌，主根未修改', '补丁文件已保留：' + (preview.patchPath || ''));
        }
        if (toolHalted(toolMessage)) return deny('WORKTREE_DENIED', '用户停止了生成，补丁未应用', '补丁文件已保留：' + (preview.patchPath || ''));
        const approvalRef = toolMessage.approval || {};
        const mode = approvalRef.mode === 'atomic' ? 'atomic' : 'partial';
        const selected = Array.isArray(approvalRef.selected) && approvalRef.selected.length
            ? approvalRef.selected
            : okFiles.map((f) => f.relPath);
        toolMessage.status = 'running';
        toolMessage.content = '正在把隔离区改动回灌主根…';
        refreshToolWrap(session, toolMessage);
        let result;
        try {
            result = await backend.PatchApply(approvalRef.planId, selected, null, mode);
        } catch (e) {
            return deny('PATCH_APPLY_IO', '回灌写入失败', String((e && e.message) || e));
        }
        if (toolMessage.approval) {
            toolMessage.approval.result = result;
            toolMessage.approval.state = 'approved';
        }
        let applied = 0;
        for (const f of result.files || []) {
            if (f.status === 'applied') {
                applied++;
                recordChange(session, {path: joinPath(root, f.relPath), relPath: f.relPath, tool: 'worktree_export', added: f.added || 0, removed: f.removed || 0});
                notifyFileChanged(joinPath(root, f.relPath));
            }
        }
        const lines = [patchResultText(result)];
        if (applied > 0) {
            lines.push('回灌来自隔离区 ' + worktreeRelPath(wt.name) + '（' + applied + ' 个文件）。改动已回主根，worktree 保留；'
                + '建议 worktree_manage(action=discard) 收尾——再次 export 是全量语义，已回灌的 hunk 会预检报「不可应用」。');
        }
        return lines.filter(Boolean).join('\n');
    }

    async function manageDiscard(session, toolMessage, input) {
        const missing = requireWriteSession(session);
        if (missing) return deny('WORKTREE_CONTEXT', missing);
        const target = resolveTarget(session, input && input.name);
        if (!target) {
            const wanted = String((input && input.name) || '').trim();
            if (wanted) return deny('WORKTREE_OWNERSHIP', '隔离区 ' + wanted + ' 不归本会话管', '只允许操作本会话自己的隔离区或本会话派生的子代理隔离区');
            return deny('WORKTREE_NONE', '本会话没有隔离工作区');
        }
        const wt = target.wt;
        // 销毁性动作全档确认（含 full），对齐 git-worktree-force 危险语义
        const confirmed = await confirmDialog({
            title: '丢弃隔离工作区',
            message: '删除 ' + worktreeRelPath(wt.name) + '/ 与分支 ' + (wt.branch || '隔离分支') + '？未导出的改动会丢失。',
            confirmLabel: '丢弃',
            danger: true,
        });
        logPermission('worktree', worktreeRelPath(wt.name), confirmed ? 'approved' : 'denied', 'confirm', '');
        if (!confirmed) return '用户保留了隔离工作区 ' + wt.name + '。';
        if (toolHalted(toolMessage)) return '用户已停止生成，丢弃已取消。';
        const root = getScopeRoot();
        try {
            await backend.GitWorktreeRemove(root, wt.name, true);
        } catch (e) {
            return deny('WORKTREE_REMOVE', '删除失败', String((e && e.message) || e));
        }
        if (target.own) {
            // 只清本会话自己的登记；丢的是子代理隔离区时不动 session.worktree
            session.worktree = null;
            persistSessions();
            syncChip(session);
        }
        flash('已丢弃隔离工作区 ' + wt.name);
        return '已丢弃隔离工作区 ' + worktreeRelPath(wt.name) + '（含分支）。主根不受影响；需要时重新 create。';
    }

    return {manageTool, mountChip, syncChip, pruneStartup, blockFor, openChipDialog};
}
