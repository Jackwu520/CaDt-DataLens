// ai-takeover.js：输入区接管卡（补丁审批 / 工具审批 / Env / Ask / 计划批准 + 计数徽标与折叠）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// approvalTakeoverKey/Collapsed、dismissedPlanApproval、stickBottom 经访问器读写（核心域他处亦写）。
import {iconSvg} from '../icons.js';
import {AI_WRITE_SCOPES, aiClampInt, aiNowId} from './ai-constants.js';
import {collectCommandFamilies, commandFamilySignature} from './ai-command-rules.js';

// 审批卡判定区的行描述（纯函数，ai-takeover.test.mjs 覆盖）：
// info = {engine: '线性'|'语义'|插件短名, score, threshold, aiReason}。
// 端侧引擎行只在 engine 有值时输出（分数按危险度着色：≥0.7 红，否则黄）；
// AI 复核行只在 aiReason 非空时输出。旧会话没有结构化字段时调用方回退拼接文案。
export function classifyVerdictRows(info) {
    const rows = [];
    if (info && info.engine) {
        const score = Math.min(1, Math.max(0, Number(info.score) || 0));
        const threshold = Math.max(0, Number(info.threshold) || 0);
        rows.push({
            chip: '端侧·' + String(info.engine),
            score,
            threshold,
            hot: score >= 0.7,
        });
    }
    const aiReason = info && info.aiReason ? String(info.aiReason) : '';
    if (aiReason) rows.push({chip: 'AI 复核', reason: aiReason});
    return rows;
}

// 判定区 DOM：行描述 → 来源 chip / 风险条（蓝刻度=阈值）/ 分数阈值 / 转人工箭头 / AI 复核理由
function buildClassifyVerdict(info) {
    const box = document.createElement('div');
    box.className = 'ai-classify';
    for (const row of classifyVerdictRows(info)) {
        const line = document.createElement('div');
        line.className = 'ai-classify-row';
        const chip = document.createElement('span');
        chip.className = 'ai-classify-chip ' + (row.reason ? 'remote' : 'local');
        chip.textContent = row.chip;
        line.appendChild(chip);
        if (row.reason) {
            const why = document.createElement('span');
            why.className = 'ai-classify-why';
            why.textContent = row.reason;
            line.appendChild(why);
        } else {
            const meter = document.createElement('span');
            meter.className = 'ai-classify-meter';
            const fill = document.createElement('i');
            fill.className = 'fill' + (row.hot ? '' : ' mid');
            fill.style.width = Math.round(row.score * 100) + '%';
            const tick = document.createElement('i');
            tick.className = 'tick';
            tick.style.left = Math.min(100, Math.round(row.threshold * 100)) + '%';
            meter.append(fill, tick);
            const num = document.createElement('span');
            num.className = 'ai-classify-num';
            const score = document.createElement('b');
            score.className = row.hot ? 'hot' : 'mid';
            score.textContent = row.score.toFixed(2);
            num.appendChild(score);
            num.append(' ≥ 阈值 ' + row.threshold.toFixed(2));
            const arrow = document.createElement('span');
            arrow.className = 'ai-classify-arrow';
            arrow.append('→ ');
            const hard = document.createElement('b');
            hard.textContent = '转人工';
            arrow.appendChild(hard);
            line.append(meter, num, arrow);
        }
        box.appendChild(line);
    }
    return box;
}

export function createAITakeover(ctx) {
    const el = ctx.el;
    const flash = ctx.flash;
    const openPath = ctx.openPath;
    const compactOf = ctx.compactOf;
    const currentSession = ctx.currentSession;
    const currentScopeOf = ctx.currentScopeOf;
    const persistSessions = ctx.persistSessions;
    const decideApproval = ctx.decideApproval;
    const decideEnvCreation = ctx.decideEnvCreation;
    const currentPendingApprovalEntry = ctx.currentPendingApprovalEntry;
    const currentPendingAskEntry = ctx.currentPendingAskEntry;
    const currentPendingEnvEntry = ctx.currentPendingEnvEntry;
    const refreshToolWrap = ctx.refreshToolWrap;
    const projectRulesPath = ctx.projectRulesPath;
    const lastAssistantIndex = ctx.lastAssistantIndex;
    const scrollToBottom = ctx.scrollToBottom;
    const setScope = ctx.setScope;
    const skipAsk = ctx.skipAsk;
    const submitAskAnswers = ctx.submitAskAnswers;
    const askCountdownText = ctx.askCountdownText;
    const streamOf = ctx.streamOf;
    const positionOverlays = ctx.positionOverlays;
    const pendingApprovals = ctx.pendingApprovals;
    const askDrafts = ctx.askDrafts;
    const AI_CHEVRON_SVG = ctx.AI_CHEVRON_SVG;
    const renderDiffInto = ctx.renderDiffInto;
    const renderMessageQueue = ctx.renderMessageQueue;
    const renderSessionList = ctx.renderSessionList;
    const getApprovalTakeoverKey = ctx.getApprovalTakeoverKey;
    const setApprovalTakeoverKey = ctx.setApprovalTakeoverKey;
    const getApprovalTakeoverCollapsed = ctx.getApprovalTakeoverCollapsed;
    const setApprovalTakeoverCollapsed = ctx.setApprovalTakeoverCollapsed;
    const getDismissedPlanApproval = ctx.getDismissedPlanApproval;
    const setDismissedPlanApproval = ctx.setDismissedPlanApproval;
    const getStickBottom = ctx.getStickBottom;
    const toolMeta = ctx.toolMeta;
    const acceptPlan = ctx.acceptPlan;

    function requestPatchApproval(session, toolMessage, preview, allowApply) {
        const approval = {
            kind: 'patch',
            state: 'pending',
            summary: preview.summary || toolMessage.name,
            relPath: preview.summary || '补丁',
            planId: preview.planId,
            patchId: preview.patchId,
            patchPath: preview.patchPath,
            root: preview.root,
            mode: 'partial', // AI 侧默认允许部分成功（§9.7.1）
            selected: (preview.files || []).filter((f) => f.status === 'ok').map((f) => f.relPath),
            preview,
            allowApply: allowApply !== false,
        };
        toolMessage.approval = approval;
        toolMessage.status = 'pending';
        toolMessage.content = '等待用户审批补丁…';
        persistSessions();
        refreshToolWrap(session, toolMessage);
        const key = toolMessage.toolCallId || aiNowId('patch-');
        const entry = {session, toolMessage, resolve: null, approval};
        pendingApprovals.set(key, entry);
        updateComposerTakeover(true);
        renderSessionList();
        return new Promise((resolve) => {
            entry.resolve = resolve;
        });
    }

    function renderPatchTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const approval = entry.approval;
        const preview = approval.preview || {files: []};
        const files = preview.files || [];
        const takeoverKey = 'patch:' + (toolMessage.toolCallId || aiNowId('patch-'));
        el.takeover.dataset.takeoverKey = takeoverKey;
        // 与单文件审批一致：临时收起只影响显示，审批本身不取消
        if (getApprovalTakeoverKey() !== takeoverKey) {
            setApprovalTakeoverKey(takeoverKey);
            setApprovalTakeoverCollapsed(false);
        }
        el.takeover.textContent = '';
        if (getApprovalTakeoverCollapsed()) {
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-takeover-icon';
            barIcon.innerHTML = iconSvg('diff', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = '补丁待审批 · ' + (approval.summary || '未命名') + '（点击展开）';
            const barStat = document.createElement('span');
            barStat.className = 'ai-approval-stat';
            barStat.append(el0('span', 'add', '+' + (preview.added || 0)), el0('span', 'del', '−' + (preview.removed || 0)));
            const chev = document.createElement('span');
            chev.className = 'ai-takeover-collapse';
            chev.innerHTML = AI_CHEVRON_SVG;
            bar.append(barIcon, barText, barStat, chev);
            bar.addEventListener('click', () => {
                setApprovalTakeoverCollapsed(false);
                updateComposerTakeover(true);
            });
            el.takeover.appendChild(bar);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-patch-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg('diff', 13);
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '补丁审批 · ' + (approval.summary || '未命名');
        title.title = (approval.summary || '') + (approval.root ? '（目标：' + approval.root + '）' : '');
        const stat = document.createElement('span');
        stat.className = 'ai-takeover-stat';
        stat.append(
            el0('span', 'add', '+' + (preview.added || 0)),
            el0('span', 'del', '−' + (preview.removed || 0)),
            el0('span', 'files', files.length + ' 文件'),
        );
        // 临时收起：折叠整卡为细条，方便继续查看上方消息；审批本身不受影响
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.title = '临时收起（审批保留，点击细条恢复）';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            setApprovalTakeoverCollapsed(true);
            updateComposerTakeover(true);
        });
        head.append(icon, title, stat, collapse);
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const list = document.createElement('div');
        list.className = 'ai-patch-filelist';
        for (const f of files) {
            const row = document.createElement('label');
            row.className = 'ai-patch-filerow ' + (f.status || '');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = approval.selected.includes(f.relPath);
            box.disabled = f.status !== 'ok' && approval.mode === 'atomic';
            box.addEventListener('change', () => {
                const set = new Set(approval.selected);
                if (box.checked) set.add(f.relPath);
                else set.delete(f.relPath);
                approval.selected = Array.from(set);
                persistSessions();
                updateComposerTakeover(true);
            });
            const path = document.createElement('span');
            path.className = 'ai-patch-path';
            path.textContent = f.relPath;
            const statEl = document.createElement('span');
            statEl.className = 'ai-patch-stat';
            statEl.append(el0('span', 'add', '+' + (f.added || 0)), el0('span', 'del', '−' + (f.removed || 0)));
            const badge = document.createElement('span');
            badge.className = 'ai-patch-badge ' + (f.status || '');
            badge.textContent = {ok: '可应用', conflict: '冲突', blocked: '不可用', unsupported: '不支持'}[f.status] || f.status;
            row.append(box, path);
            if (f.kind === 'add') row.appendChild(el0('span', 'ai-patch-kind', '新建'));
            else if (f.kind === 'delete') row.appendChild(el0('span', 'ai-patch-kind danger', '删除'));
            row.append(statEl, badge);
            if (f.reason) row.title = f.reason;
            list.appendChild(row);
            if (f.reason) {
                const reason = document.createElement('div');
                reason.className = 'ai-patch-reason';
                reason.textContent = '→ ' + f.reason;
                list.appendChild(reason);
            }
        }
        body.appendChild(list);

        const modeRow = document.createElement('div');
        modeRow.className = 'ai-approval-remember ai-patch-moderow';
        const modeLabel = document.createElement('label');
        const modeText = document.createElement('span');
        modeText.textContent = '应用模式：';
        const select = document.createElement('select');
        select.className = 'patch-mode-select';
        for (const [value, label] of [['partial', '允许部分成功'], ['atomic', '整体成功']]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (approval.mode === value) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            approval.mode = select.value;
            persistSessions();
            updateComposerTakeover(true);
        });
        modeLabel.append(modeText, select);
        modeRow.appendChild(modeLabel);
        body.appendChild(modeRow);
        card.appendChild(body);

        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-approval-takeover-foot';
        // 详情入口：打开 .patch 的补丁视图（逐文件状态、逐行 diff、撤销都在那边）
        const detail = document.createElement('button');
        detail.type = 'button';
        detail.className = 'dlg-btn';
        detail.textContent = '查看详情';
        detail.disabled = !approval.patchPath;
        detail.title = approval.patchPath
            ? '在新标签页打开补丁视图：逐文件状态、逐行 diff，应用后可随时撤销\n' + approval.patchPath
            : '补丁文件路径缺失，无法打开详情';
        detail.addEventListener('click', () => {
            if (approval.patchPath) openPath(approval.patchPath);
        });
        foot.appendChild(detail);
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = '放弃';
        deny.addEventListener('click', () => decideApproval(toolMessage, false, ''));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn primary';
        const okCount = files.filter((f) => f.status === 'ok' && approval.selected.includes(f.relPath)).length;
        apply.textContent = '应用（' + okCount + ' 个' + (approval.mode === 'partial' ? '，其余跳过' : '') + '）';
        apply.disabled = okCount === 0;
        apply.addEventListener('click', () => decideApproval(toolMessage, true, ''));
        actions.append(deny, apply);
        foot.appendChild(actions);
        card.appendChild(foot);
        el.takeover.appendChild(card);
    }

    // 结果态（已裁决）：展示逐文件结果与撤销提示
    function renderPatchApprovalBody(container, message, approval) {
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const path = document.createElement('span');
        path.className = 'ai-approval-path';
        path.textContent = approval.summary || '补丁';
        meta.appendChild(path);
        const stat = document.createElement('span');
        stat.className = 'ai-approval-stat';
        stat.textContent = '模式：' + (approval.mode === 'partial' ? '允许部分成功' : '整体成功');
        meta.appendChild(stat);
        container.appendChild(meta);

        const res = approval.result;
        // 已裁决后仍可跳回补丁视图：逐文件状态、逐行 diff、撤销都在那边
        const appendDetailLink = (applied) => {
            if (!approval.patchPath) return;
            const more = el0('div', 'ai-approval-more');
            const link = el0('button', 'patch-link', applied ? '在补丁视图中查看 / 撤销' : '在补丁视图中查看详情');
            link.type = 'button';
            link.title = approval.patchPath;
            link.addEventListener('click', () => openPath(approval.patchPath));
            more.appendChild(link);
            container.appendChild(more);
        };
        if (approval.state === 'denied') {
            container.appendChild(el0('div', 'ai-approval-result denied', '已放弃，文件未修改'));
            appendDetailLink(false);
            return;
        }
        if (approval.state === 'cancelled') {
            container.appendChild(el0('div', 'ai-approval-result cancelled', '审批已取消'));
            appendDetailLink(false);
            return;
        }
        if (!res) {
            container.appendChild(el0('div', 'ai-approval-result', '正在应用补丁…'));
            return;
        }
        const box = el0('div', 'ai-approval-result ' + (res.applied > 0 ? 'approved' : 'failed'));
        if (res.applied > 0) {
            box.textContent = '已应用 ' + res.applied + ' 个文件' + (res.skipped ? '，跳过 ' + res.skipped + ' 个' : '') + (res.mode === 'partial' && res.skipped ? '（可在补丁视图里撤销）' : '');
        } else {
            box.textContent = '未应用任何更改' + (res.message ? '：' + res.message : '');
        }
        container.appendChild(box);
        if (res.files && res.files.length) {
            const list = el0('div', 'ai-approval-output');
            list.textContent = res.files.map((f) => {
                const label = {applied: '✓ 已应用', skipped: '⚠ 已跳过', failed: '✗ 失败', notapplied: '· 未执行'}[f.status] || f.status;
                return label + ' ' + f.relPath + (f.reason ? '（' + f.reason + '）' : '');
            }).join('\n');
            container.appendChild(list);
        }
        appendDetailLink(res.applied > 0);
    }

    function el0(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function renderApprovalTakeover(entry) {
        if (entry && entry.approval && entry.approval.kind === 'patch') {
            renderPatchTakeover(entry);
            return;
        }
        const toolMessage = entry.toolMessage;
        const approval = entry.approval;
        const isCommand = approval.kind === 'command';
        const commandFamily = isCommand ? commandFamilySignature(approval.command) : null;
        const takeoverKey = 'approval:' + (toolMessage.toolCallId || '');
        el.takeover.dataset.takeoverKey = takeoverKey;
        if (getApprovalTakeoverKey() !== takeoverKey) {
            setApprovalTakeoverKey(takeoverKey);
            setApprovalTakeoverCollapsed(false);
        }
        el.takeover.textContent = '';
        if (getApprovalTakeoverCollapsed()) {
            // 收起态：单行细条，保持「有待审批」的可见性，点击恢复
            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'ai-takeover-bar';
            const barIcon = document.createElement('span');
            barIcon.className = 'ai-takeover-icon';
            barIcon.innerHTML = iconSvg('diff', 13);
            const barText = document.createElement('span');
            barText.className = 'ai-takeover-bar-text';
            barText.textContent = isCommand
                ? '命令待审批（已收起，点击展开）'
                : '更改待审批 · ' + (approval.relPath || approval.path || '') + '（点击展开）';
            const barStat = document.createElement('span');
            barStat.className = 'ai-approval-stat';
            if (!isCommand) {
                const add = document.createElement('span');
                add.className = 'add';
                add.textContent = '+' + (approval.added || 0);
                const del = document.createElement('span');
                del.className = 'del';
                del.textContent = '−' + (approval.removed || 0);
                barStat.append(add, del);
            }
            const chev = document.createElement('span');
            chev.className = 'ai-takeover-collapse';
            chev.innerHTML = AI_CHEVRON_SVG;
            bar.append(barIcon, barText, barStat, chev);
            bar.addEventListener('click', () => {
                setApprovalTakeoverCollapsed(false);
                updateComposerTakeover(true);
            });
            el.takeover.appendChild(bar);
            return;
        }
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-approval-takeover' + (isCommand ? ' command' : '');
        // 头部：动作词 + 图标 + 路径 + diff 统计 + 收起按钮
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const meta = toolMeta(toolMessage.name, approval);
        const icon = document.createElement('span');
        icon.className = 'ai-takeover-icon';
        icon.innerHTML = iconSvg(meta.icon, 13);
        const verb = document.createElement('span');
        verb.className = 'ai-takeover-title';
        verb.textContent = meta.verb;
        head.append(icon, verb);
        if (isCommand) {
            const cwd = document.createElement('span');
            cwd.className = 'ai-command-cwd';
            cwd.textContent = approval.cwd || '终端命令';
            cwd.title = approval.cwd || '';
            head.appendChild(cwd);
        } else {
            const path = document.createElement('span');
            path.className = 'ai-takeover-path';
            path.textContent = approval.relPath || approval.path || '';
            path.title = approval.path || '';
            head.appendChild(path);
            const stat = document.createElement('span');
            stat.className = 'ai-approval-stat';
            const add = document.createElement('span');
            add.className = 'add';
            add.textContent = '+' + (approval.added || 0);
            const del = document.createElement('span');
            del.className = 'del';
            del.textContent = '−' + (approval.removed || 0);
            stat.append(add, del);
            if (approval.newFile) {
                const tag = document.createElement('span');
                tag.className = 'ai-approval-tag';
                tag.textContent = '新文件';
                stat.appendChild(tag);
            }
            head.appendChild(stat);
        }
        // 临时收起：折叠整卡为细条，方便继续查看上方消息；审批本身不受影响
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ai-takeover-collapse';
        collapse.title = '临时收起（审批保留，点击细条恢复）';
        collapse.innerHTML = AI_CHEVRON_SVG;
        collapse.addEventListener('click', () => {
            setApprovalTakeoverCollapsed(true);
            updateComposerTakeover(true);
        });
        head.appendChild(collapse);
        // 正文：diff / 命令内容占满剩余高度并内部滚动
        const body = document.createElement('div');
        body.className = 'ai-takeover-body ai-approval-takeover-body';
        if (approval.dirty) {
            const warn = document.createElement('div');
            warn.className = 'ai-approval-warn';
            warn.textContent = '该文件在编辑器中存在未保存修改；应用后不会自动重载，请手动重新加载。';
            body.appendChild(warn);
        }
        if (isCommand) {
            if (approval.danger) {
                const danger = document.createElement('div');
                danger.className = 'ai-approval-danger';
                danger.textContent = '高风险操作：' + (approval.danger.label || approval.danger.ruleId) +
                    '。该命令只执行这一次，不会写入任何长期授权。';
                body.appendChild(danger);
            }
            const line = document.createElement('pre');
            line.className = 'ai-command-line ai-command-line-fill';
            line.textContent = approval.command || '';
            body.appendChild(line);
            if (approval.classifyInfo && !(approval.danger || approval.singleUse)) {
                // 结构化判定区（2026-11-14 提案）：端侧引擎行 + AI 复核行，取代拼接文案；
                // 旧会话恢复的审批对象没有该字段，走下方 classifyNote 纯文本回退
                body.appendChild(buildClassifyVerdict(approval.classifyInfo));
            } else {
                const note = document.createElement('div');
                note.className = 'ai-approval-more';
                note.textContent = toolMessage.name === 'web_fetch'
                    ? '将向该地址发起网络请求；域名规则可在 .cadt/permissions.json 的 Web(...) 中预先配置。'
                    : (approval.danger || approval.singleUse
                        ? '命令将在工作目录中执行；危险命令不提供「本会话 / 本项目允许」。'
                        : (approval.classifyNote
                            ? (approval.askSource === 'local-classifier'
                                ? '端侧分类器转人工：' + approval.classifyNote
                                : '分类器建议人工确认：' + approval.classifyNote)
                            : (commandFamily
                                ? '命令将在工作目录中执行；同类命令授权可保存到本会话或本项目，且不含管道、重定向或命令串联。'
                                : '命令将在工作目录中执行；授权仅本次对话。')));
                body.appendChild(note);
            }
        } else if (approval.diff && approval.diff.length) {
            renderDiffInto(body, approval);
            if (approval.truncated) {
                const more = document.createElement('div');
                more.className = 'ai-approval-more';
                more.textContent = '…（diff 预览已截断）';
                body.appendChild(more);
            }
        } else {
            const empty = document.createElement('div');
            empty.className = 'ai-approval-more';
            empty.textContent = '（无内容变化）';
            body.appendChild(empty);
        }
        // 底部操作条：勾选框 + 固定按钮
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot ai-approval-takeover-foot';
        const options = document.createElement('div');
        options.className = 'ai-approval-remember';
        let alwaysBox = null;
        let sessionBox = null;
        let familyBox = null;
        let projectFamilyBox = null;
        let projectFileBox = null;
        if (!isCommand) {
            const sessionLabel = document.createElement('label');
            sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionLabel.append(sessionBox, document.createTextNode(' 本会话允许此文件'));
            const alwaysLabel = document.createElement('label');
            alwaysBox = document.createElement('input');
            alwaysBox.type = 'checkbox';
            alwaysLabel.append(alwaysBox, document.createTextNode(' 总是允许此文件'));
            options.append(sessionLabel, alwaysLabel);
            if (projectRulesPath()) {
                const projectLabel = document.createElement('label');
                projectLabel.title = '写入 .cadt/permissions.json，随工作区共享';
                projectFileBox = document.createElement('input');
                projectFileBox.type = 'checkbox';
                projectFileBox.dataset.aiWriteRemember = 'project';
                projectLabel.append(projectFileBox, document.createTextNode(' 本项目允许此文件'));
                options.appendChild(projectLabel);
            }
            foot.appendChild(options);
        } else if (!approval.danger && !approval.singleUse) {
            const exactLabel = document.createElement('label');
            exactLabel.title = '相同命令 + 相同工作目录才自动执行；授权仅本次对话';
            sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionBox.dataset.aiCommandRemember = 'exact';
            exactLabel.append(sessionBox, document.createTextNode(toolMessage.name === 'web_fetch' ? ' 本会话允许该网址' : ' 本会话允许相同命令'));
            options.appendChild(exactLabel);
            if (commandFamily) {
                const familyLabel = document.createElement('label');
                familyLabel.title = '同类命令：' + commandFamily.signature + '（同目录；不含管道、重定向或命令串联）';
                familyBox = document.createElement('input');
                familyBox.type = 'checkbox';
                familyBox.dataset.aiCommandRemember = 'family';
                familyLabel.append(familyBox, document.createTextNode(' 本会话允许同类命令（' + commandFamily.signature + '）'));
                options.appendChild(familyLabel);
                if (projectRulesPath()) {
                    const projectLabel = document.createElement('label');
                    projectLabel.title = '写入 .cadt/permissions.json：Bash(' + commandFamily.signature + ':*)';
                    projectFamilyBox = document.createElement('input');
                    projectFamilyBox.type = 'checkbox';
                    projectFamilyBox.dataset.aiCommandRemember = 'projectFamily';
                    projectLabel.append(projectFamilyBox, document.createTextNode(' 本项目允许同类命令'));
                    options.appendChild(projectLabel);
                }
            }
            foot.appendChild(options);
        }
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const readRemember = () => {
            if (!isCommand) {
                return alwaysBox && alwaysBox.checked
                    ? 'always'
                    : (projectFileBox && projectFileBox.checked
                        ? 'project'
                        : (sessionBox && sessionBox.checked ? 'session' : ''));
            }
            if (approval.danger || approval.singleUse) return {};
            return {
                exact: !!(sessionBox && sessionBox.checked),
                family: !!(familyBox && familyBox.checked),
                projectFamily: !!(projectFamilyBox && projectFamilyBox.checked),
            };
        };
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = '放弃';
        deny.addEventListener('click', () => decideApproval(toolMessage, false, readRemember()));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn primary';
        apply.textContent = isCommand ? '执行' : '应用';
        apply.addEventListener('click', () => decideApproval(toolMessage, true, readRemember()));
        actions.append(deny, apply);
        foot.appendChild(actions);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    function renderEnvAskTakeover(entry) {
        const toolMessage = entry.toolMessage;
        const envAsk = toolMessage.envAsk;
        el.takeover.dataset.takeoverKey = 'env:' + (toolMessage.toolCallId || aiNowId('env-ask-'));
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-env-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.8" width="11.6" height="8.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.6 8h4.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '创建环境变量 · ' + envAsk.name;
        head.append(icon, title);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        if (envAsk.description) {
            const desc = document.createElement('div');
            desc.className = 'ai-ask-detail';
            desc.textContent = envAsk.description;
            body.appendChild(desc);
        }
        const row = document.createElement('div');
        row.className = 'env-ask-row';
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'ai-settings-input env-ask-input';
        input.placeholder = '输入变量值（仅你可见）';
        input.spellcheck = false;
        input.autocomplete = 'off';
        const submit = (approved) => decideEnvCreation(toolMessage, approved, input.value);
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); submit(true); }
            else if (e.key === 'Escape') { e.preventDefault(); submit(false); }
        });
        row.appendChild(input);
        const hint = document.createElement('div');
        hint.className = 'ai-approval-more';
        hint.textContent = '值由你亲自输入，AI 看不到；保存后注入终端与命令桥。Enter 创建 · Esc 放弃。';
        const actions = document.createElement('div');
        actions.className = 'ai-approval-actions';
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'dlg-btn';
        deny.textContent = '放弃';
        deny.addEventListener('click', () => submit(false));
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dlg-btn primary';
        apply.textContent = '创建';
        apply.addEventListener('click', () => submit(true));
        actions.append(deny, apply);
        body.append(row, hint, actions);
        card.append(head, body);
        el.takeover.appendChild(card);
        setTimeout(() => {
            if (input.isConnected) input.focus();
        }, 50);
    }

    function planApprovalMessage(session) {
        if (!session || streamOf(session.id) || compactOf(session.id) || !session.planMode) return null;
        const index = lastAssistantIndex(session);
        if (index < 0 || index !== session.messages.length - 1) return null;
        const message = session.messages[index];
        if (!message || message.role !== 'assistant' || !message.planMode || message.status !== 'done' ||
            !String(message.content || '').trim()) return null;
        return message;
    }

    function planApprovalKey(session, message) {
        return session.id + ':' + (Number(message.ts) || 0) + ':' + String(message.content || '').length;
    }

    function askTakeoverKey(entry) {
        return entry.toolMessage.toolCallId || entry.key;
    }

    function askDraftFor(entry) {
        const key = askTakeoverKey(entry);
        let draft = askDrafts.get(key);
        if (draft) return draft;
        draft = {
            idx: 0,
            // 推荐项只显示「推荐」角标不预选：预选会和「点选自动下一题」冲突（点推荐=取消选中）。
            answers: entry.ask.questions.map(() => ({selected: [], custom: ''})),
        };
        askDrafts.set(key, draft);
        return draft;
    }

    function renderAskTakeover(entry) {
        const ask = entry.ask;
        const draft = askDraftFor(entry);
        const key = askTakeoverKey(entry);
        const multi = ask.questions.length > 1;
        draft.idx = multi ? aiClampInt(draft.idx, 0, ask.questions.length - 1, 0) : 0;
        el.takeover.dataset.takeoverKey = 'ask:' + key;
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-ask-takeover' + (multi ? ' multi' : '');
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.7.6-.7 1.1v.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".75" fill="currentColor"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = 'AI 提问' + (multi ? ' · ' + ask.questions.length + ' 个问题' : '');
        head.append(icon, title);
        // 有倒计时用倒计时文案；wait（无 deadline）时也可能有"已忽略 N 秒"的提示
        const countdownText = askCountdownText(ask);
        if (countdownText) {
            const countdown = document.createElement('span');
            countdown.className = 'ai-ask-countdown';
            countdown.dataset.askKey = key;
            countdown.textContent = countdownText;
            head.appendChild(countdown);
        }
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const qi = draft.idx;
        const question = ask.questions[qi];
        const answerDraft = draft.answers[qi];
        const block = document.createElement('div');
        block.className = 'ai-ask-form-q single';
        const qrow = document.createElement('div');
        qrow.className = 'ai-ask-qrow';
        if (question.header) {
            const header = document.createElement('span');
            header.className = 'ai-ask-header';
            header.textContent = question.header;
            qrow.appendChild(header);
        }
        const q = document.createElement('span');
        q.className = 'ai-ask-question';
        q.textContent = question.question;
        qrow.appendChild(q);
        if (multi) {
            const pager = document.createElement('span');
            pager.className = 'ai-ask-pager';
            const prev = document.createElement('button');
            prev.type = 'button';
            prev.className = 'ai-ask-page-btn';
            prev.title = '上一个问题';
            prev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            prev.disabled = qi <= 0;
            prev.addEventListener('click', () => {
                draft.idx = Math.max(0, draft.idx - 1);
                renderAskTakeover(entry);
            });
            const pos = document.createElement('span');
            pos.className = 'ai-ask-page-pos';
            pos.textContent = (qi + 1) + ' / ' + ask.questions.length;
            const next = document.createElement('button');
            next.type = 'button';
            next.className = 'ai-ask-page-btn';
            next.title = '下一个问题';
            next.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            next.disabled = qi >= ask.questions.length - 1;
            next.addEventListener('click', () => {
                draft.idx = Math.min(ask.questions.length - 1, draft.idx + 1);
                renderAskTakeover(entry);
            });
            pager.append(prev, pos, next);
            qrow.appendChild(pager);
        }
        block.appendChild(qrow);
        if (question.detail) {
            const detail = document.createElement('div');
            detail.className = 'ai-ask-detail';
            detail.textContent = question.detail;
            block.appendChild(detail);
        }
        const options = document.createElement('div');
        options.className = 'ai-ask-options';
        for (let oi = 0; oi < question.options.length; oi++) {
            const option = question.options[oi];
            const selected = answerDraft.selected.includes(option.label);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ai-ask-option' + (option.recommended ? ' recommended' : '') + (selected ? ' selected' : '');
            if (question.multiSelect) {
                const check = document.createElement('span');
                check.className = 'ai-ask-check';
                check.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.4l3.1 3.1 6.1-6.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                button.appendChild(check);
            }
            const num = document.createElement('span');
            num.className = 'ai-ask-num';
            num.textContent = (oi + 1) + '.';
            const label = document.createElement('span');
            label.className = 'ai-ask-option-label';
            label.textContent = option.label;
            button.append(num, label);
            if (option.recommended) {
                const badge = document.createElement('span');
                badge.className = 'ai-ask-badge';
                badge.textContent = '推荐';
                button.appendChild(badge);
            }
            if (option.description) {
                const desc = document.createElement('span');
                desc.className = 'ai-ask-option-desc';
                desc.textContent = option.description;
                button.appendChild(desc);
            }
            button.addEventListener('click', () => {
                if (question.multiSelect) {
                    const at = answerDraft.selected.indexOf(option.label);
                    if (at >= 0) answerDraft.selected.splice(at, 1);
                    else answerDraft.selected.push(option.label);
                } else {
                    answerDraft.selected = selected ? [] : [option.label];
                    answerDraft.custom = '';
                    if (answerDraft.selected.length && qi < ask.questions.length - 1) draft.idx = qi + 1;
                }
                renderAskTakeover(entry);
            });
            options.appendChild(button);
        }
        if (options.childNodes.length) block.appendChild(options);
        if (question.allowCustom) {
            const custom = document.createElement('div');
            custom.className = 'ai-ask-custom';
            const num = document.createElement('span');
            num.className = 'ai-ask-num';
            num.textContent = (question.options.length + 1) + '.';
            const input = document.createElement('input');
            input.className = 'ai-ask-input';
            input.type = 'text';
            input.placeholder = question.options.length ? '其他：自己输入回答…' : '输入你的回答…';
            input.spellcheck = false;
            input.value = answerDraft.custom;
            input.addEventListener('input', () => {
                answerDraft.custom = input.value;
            });
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (qi < ask.questions.length - 1) {
                    draft.idx = qi + 1;
                    renderAskTakeover(entry);
                } else {
                    submitAskAnswers(entry, draft.answers);
                }
            });
            custom.append(num, input);
            block.appendChild(custom);
        }
        body.appendChild(block);
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = multi
            ? 'Tab / 上下键选择，回车或空格选中；左右方向键切换问题'
            : '不确定可点「跳过」，不回答但继续；超时按设置处理';
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'dlg-btn';
        skip.textContent = '跳过';
        skip.title = '不回答本轮提问，让 AI 继续';
        skip.addEventListener('click', () => skipAsk(entry));
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'dlg-btn primary';
        if (multi && qi < ask.questions.length - 1) {
            main.textContent = '继续';
            main.addEventListener('click', () => {
                draft.idx = qi + 1;
                renderAskTakeover(entry);
            });
        } else {
            main.textContent = '提交回答';
            main.addEventListener('click', () => submitAskAnswers(entry, draft.answers));
        }
        foot.append(hint, skip, main);
        card.append(head, body, foot);
        if (multi) {
            card.addEventListener('keydown', (e) => {
                const tag = e.target && e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                if (e.key === 'ArrowLeft' && qi > 0) {
                    e.preventDefault();
                    draft.idx = qi - 1;
                    renderAskTakeover(entry);
                } else if (e.key === 'ArrowRight' && qi < ask.questions.length - 1) {
                    e.preventDefault();
                    draft.idx = qi + 1;
                    renderAskTakeover(entry);
                }
            });
        }
        el.takeover.appendChild(card);
    }

    function renderPlanTakeover(session, message) {
        const key = planApprovalKey(session, message);
        el.takeover.dataset.takeoverKey = 'plan:' + key;
        el.takeover.textContent = '';
        const card = document.createElement('div');
        card.className = 'ai-takeover-card ai-plan-takeover';
        const head = document.createElement('div');
        head.className = 'ai-takeover-head';
        const icon = document.createElement('span');
        icon.className = 'ai-plan-takeover-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5h9v9h-9z" fill="none" stroke="currentColor" stroke-width="1.2" rx="1"/><path d="M5.5 6h5M5.5 8.4h5M5.5 10.8h3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-takeover-title';
        title.textContent = '计划等待批准';
        const mode = document.createElement('span');
        mode.className = 'ai-takeover-mode';
        mode.textContent = '计划模式';
        head.append(icon, title, mode);
        const body = document.createElement('div');
        body.className = 'ai-takeover-body';
        const preview = document.createElement('div');
        preview.className = 'ai-plan-preview';
        const text = String(message.content || '').trim();
        preview.textContent = text.length > 1600 ? text.slice(0, 1600) + '\n…' : text;
        body.appendChild(preview);
        // 计划里出现的同类命令可在批准时一并授权，减少执行期的重复审批。
        const families = collectCommandFamilies(text);
        const selectedFamilies = new Set(families);
        if (families.length && AI_WRITE_SCOPES.includes(currentScopeOf(session))) {
            const grant = document.createElement('div');
            grant.className = 'ai-plan-grant';
            const grantTitle = document.createElement('div');
            grantTitle.className = 'ai-plan-grant-title';
            grantTitle.textContent = '批准后本会话允许同类命令（可取消勾选）';
            grant.appendChild(grantTitle);
            for (const signature of families) {
                const label = document.createElement('label');
                label.className = 'ai-plan-grant-item';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = true;
                box.addEventListener('change', () => {
                    if (box.checked) selectedFamilies.add(signature);
                    else selectedFamilies.delete(signature);
                });
                const code = document.createElement('code');
                code.textContent = signature;
                label.append(box, code);
                grant.appendChild(label);
            }
            const grantHint = document.createElement('div');
            grantHint.className = 'ai-approval-more';
            grantHint.textContent = '只对同工作目录、不含管道 / 重定向 / 命令串联的简单命令生效。';
            grant.appendChild(grantHint);
            body.appendChild(grant);
        }
        const foot = document.createElement('div');
        foot.className = 'ai-takeover-foot';
        const hint = document.createElement('span');
        hint.className = 'ai-takeover-hint';
        hint.textContent = currentScopeOf(session) === 'read' ? '执行计划前请切换到「每次询问」或更高权限' : '批准后开始执行';
        if (currentScopeOf(session) === 'read') {
            const permission = document.createElement('button');
            permission.type = 'button';
            permission.className = 'dlg-btn';
            permission.textContent = '切换到每次询问';
            permission.addEventListener('click', () => {
                setScope('edit');
                updateComposerTakeover(true);
                renderMessageQueue();
            });
            foot.appendChild(permission);
        }
        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'dlg-btn';
        continueBtn.textContent = '继续规划';
        continueBtn.addEventListener('click', () => {
            setDismissedPlanApproval(key);
            updateComposerTakeover(true);
            renderMessageQueue();
            if (el.input) el.input.focus();
            flash('输入补充意见后发送，AI 会继续完善计划');
        });
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'dlg-btn primary';
        accept.textContent = '执行计划';
        accept.addEventListener('click', () => acceptPlan(session, message, Array.from(selectedFamilies)));
        foot.append(hint, continueBtn, accept);
        card.append(head, body, foot);
        el.takeover.appendChild(card);
    }

    function updateComposerTakeover(force) {
        if (!el.takeover || !el.composer) return;
        const ask = currentPendingAskEntry();
        const env = ask ? null : currentPendingEnvEntry();
        const approvalEntry = (ask || env) ? null : currentPendingApprovalEntry();
        const session = currentSession();
        const plan = (ask || env || approvalEntry) ? null : planApprovalMessage(session);
        const planKey = plan ? planApprovalKey(session, plan) : '';
        let key = '';
        if (ask) key = 'ask:' + askTakeoverKey(ask);
        else if (env) key = 'env:' + ((env.toolMessage && env.toolMessage.toolCallId) || '');
        else if (approvalEntry) key = 'approval:' + ((approvalEntry.toolMessage && approvalEntry.toolMessage.toolCallId) || '');
        else if (plan && getDismissedPlanApproval() !== planKey) key = 'plan:' + planKey;
        if (!force && key && el.takeover.dataset.takeoverKey === key) return;
        if (!key) {
            el.takeover.dataset.takeoverKey = '';
            el.takeover.classList.add('hidden');
            el.takeover.textContent = '';
            el.composer.classList.remove('ai-takeover-active');
            positionOverlays();
            return;
        }
        el.takeover.dataset.takeoverKey = key;
        el.takeover.classList.remove('hidden');
        el.composer.classList.add('ai-takeover-active');
        if (ask) renderAskTakeover(ask);
        else if (env) renderEnvAskTakeover(env);
        else if (approvalEntry) renderApprovalTakeover(approvalEntry);
        else if (plan) renderPlanTakeover(session, plan);
        positionOverlays();
        if (getStickBottom()) scrollToBottom(false);
    }
    return {
        requestPatchApproval,
        planApprovalMessage,
        planApprovalKey,
        renderPatchTakeover,
        renderPatchApprovalBody,
        renderApprovalTakeover,
        renderAskTakeover,
        renderPlanTakeover,
        updateComposerTakeover,
    };
}
