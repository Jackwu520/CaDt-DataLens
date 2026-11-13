// ai-tool-cards.js：工具卡 / 审批卡渲染（命令审批、写审批、Env、Ask 卡、diff 预览、工具消息壳、助手消息更新）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// 折叠状态 Map 与转录 Map 经 ctx 注入（引用稳定）；dismissedPlanApproval 经 setDismissedPlanApproval 写。
import {iconSvg} from '../icons.js';
import {createFileIcon} from '../fileicons.js';
import {enhanceWidgets} from '../widget.js';
import {aiFormatTime, aiTextOf} from './ai-constants.js';

export function createAIToolCards(ctx) {
    const copyText = ctx.copyText;
    const flash = ctx.flash;
    const renderMarkdown = ctx.renderMarkdown;
    const openExternal = ctx.openExternal;
    const settings = ctx.settings;
    const getScopeRoot = ctx.getScopeRoot;
    const currentSession = ctx.currentSession;
    const currentScopeOf = ctx.currentScopeOf;
    const persistSessions = ctx.persistSessions;
    const renderMessages = ctx.renderMessages;
    const submitText = ctx.submitText;
    const streamOf = ctx.streamOf;
    const updateScopeUI = ctx.updateScopeUI;
    const addCommandApprovalRule = ctx.addCommandApprovalRule;
    const appendActions = ctx.appendActions;
    const renderPatchApprovalBody = ctx.renderPatchApprovalBody;
    const renderPendingApprovalPlaceholder = ctx.renderPendingApprovalPlaceholder;
    const renderThinkBody = ctx.renderThinkBody;
    const aiThinkKey = ctx.aiThinkKey;
    const aiThinkLabel = ctx.aiThinkLabel;
    const resolveAIImages = ctx.resolveAIImages;
    const toggleThink = ctx.toggleThink;
    const toolArgsSummary = ctx.toolArgsSummary;
    const toolStateText = ctx.toolStateText;
    const approvalTraceNote = ctx.approvalTraceNote;
    const renderMessageQueue = ctx.renderMessageQueue;
    const updateComposerTakeover = ctx.updateComposerTakeover;
    const thinkFoldState = ctx.thinkFoldState;
    const toolFoldState = ctx.toolFoldState;
    const subAgentTranscripts = ctx.subAgentTranscripts;
    const setDismissedPlanApproval = ctx.setDismissedPlanApproval;

    function renderCommandApprovalBody(container, message, approval) {
        if (approval.state === 'pending') {
            renderPendingApprovalPlaceholder(container, approval);
            return;
        }
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const label = document.createElement('span');
        label.className = 'ai-approval-path';
        label.textContent = '终端命令';
        meta.appendChild(label);
        if (approval.cwd) {
            const cwd = document.createElement('span');
            cwd.className = 'ai-command-cwd';
            cwd.textContent = approval.cwd;
            cwd.title = approval.cwd;
            meta.appendChild(cwd);
        }
        container.appendChild(meta);
        const line = document.createElement('pre');
        line.className = 'ai-command-line';
        line.textContent = approval.command;
        container.appendChild(line);
        if (approval.state === 'pending') {
            const actions = document.createElement('div');
            actions.className = 'ai-approval-actions';
            const deny = document.createElement('button');
            deny.type = 'button';
            deny.className = 'dlg-btn';
            deny.dataset.aiApprove = 'deny';
            deny.textContent = '放弃';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'dlg-btn primary';
            apply.dataset.aiApprove = 'apply';
            apply.textContent = '执行';
            actions.append(deny, apply);
            container.appendChild(actions);
            return;
        }
        const result = document.createElement('div');
        result.className = 'ai-approval-result ' + approval.state;
        result.textContent = approval.state === 'approved'
            ? (message.status === 'running' ? '正在执行命令…' : '命令已执行' + approvalTraceNote(approval))
            : approval.state === 'denied'
                ? '已放弃，命令未执行'
                : (approval.state === 'failed'
                    ? ('执行失败：' + (approval.error || '无法执行命令'))
                    : '审批已取消');
        container.appendChild(result);
        if (message.content) {
            const output = document.createElement('div');
            output.className = 'ai-approval-output';
            output.textContent = message.content;
            container.appendChild(output);
        }
    }

    function renderApprovalBody(container, message, approval, opts) {
        if (approval.state === 'pending') {
            renderPendingApprovalPlaceholder(container, approval);
            return;
        }
        if (approval.kind === 'command') {
            renderCommandApprovalBody(container, message, approval);
            return;
        }
        if (approval.kind === 'patch') {
            renderPatchApprovalBody(container, message, approval);
            return;
        }
        // skipMeta：工具卡头部已带路径与 diff 统计时，正文不再重复
        if (!(opts && opts.skipMeta)) {
            const meta = document.createElement('div');
            meta.className = 'ai-approval-meta';
            const path = document.createElement('span');
            path.className = 'ai-approval-path';
            path.textContent = approval.relPath || approval.path;
            path.title = approval.path || '';
            const stat = document.createElement('span');
            stat.className = 'ai-approval-stat';
            const add = document.createElement('span');
            add.className = 'add';
            add.textContent = '+' + approval.added;
            const del = document.createElement('span');
            del.className = 'del';
            del.textContent = '−' + approval.removed;
            stat.append(add, del);
            if (approval.newFile) {
                const tag = document.createElement('span');
                tag.className = 'ai-approval-tag';
                tag.textContent = '新文件';
                stat.appendChild(tag);
            }
            meta.append(path, stat);
            container.appendChild(meta);
        }

        if (approval.dirty) {
            const warn = document.createElement('div');
            warn.className = 'ai-approval-warn';
            warn.textContent = '该文件在编辑器中存在未保存修改；应用后不会自动重载，请手动重新加载。';
            container.appendChild(warn);
        }

        if (approval.diff && approval.diff.length) {
            renderDiffInto(container, approval);
            if (approval.truncated) {
                const more = document.createElement('div');
                more.className = 'ai-approval-more';
                more.textContent = '…（diff 预览已截断）';
                container.appendChild(more);
            }
        }

        if (approval.state === 'pending') {
            const options = document.createElement('div');
            options.className = 'ai-approval-remember';
            const sessionLabel = document.createElement('label');
            const sessionBox = document.createElement('input');
            sessionBox.type = 'checkbox';
            sessionBox.dataset.aiRemember = 'session';
            sessionLabel.append(sessionBox, document.createTextNode(' 本会话允许此文件'));
            const alwaysLabel = document.createElement('label');
            const alwaysBox = document.createElement('input');
            alwaysBox.type = 'checkbox';
            alwaysBox.dataset.aiRemember = 'always';
            alwaysLabel.append(alwaysBox, document.createTextNode(' 总是允许此文件'));
            options.append(sessionLabel, alwaysLabel);
            container.appendChild(options);

            const actions = document.createElement('div');
            actions.className = 'ai-approval-actions';
            const deny = document.createElement('button');
            deny.type = 'button';
            deny.className = 'dlg-btn';
            deny.dataset.aiApprove = 'deny';
            deny.textContent = '放弃';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'dlg-btn primary';
            apply.dataset.aiApprove = 'apply';
            apply.textContent = '应用';
            actions.append(deny, apply);
            container.appendChild(actions);
        } else {
            const result = document.createElement('div');
            result.className = 'ai-approval-result ' + approval.state;
            result.textContent = approval.state === 'approved'
                ? (message.status === 'running' ? '正在应用更改…' : '已应用更改' + approvalTraceNote(approval))
                : approval.state === 'denied'
                    ? '已放弃，文件未修改'
                    : (approval.state === 'failed'
                        ? ('应用失败：' + (approval.error || '写入文件失败'))
                        : '审批已取消');
            container.appendChild(result);
            if (message.content) {
                const output = document.createElement('div');
                output.className = 'ai-approval-output';
                output.textContent = message.content;
                container.appendChild(output);
            }
        }
    }

    function renderEnvAskBody(container, message, envAsk) {
        const meta = document.createElement('div');
        meta.className = 'ai-approval-meta';
        const name = document.createElement('span');
        name.className = 'ai-approval-path env-ask-name';
        name.textContent = envAsk.name;
        meta.appendChild(name);
        if (envAsk.description) {
            const desc = document.createElement('span');
            desc.className = 'ai-approval-stat env-ask-desc';
            desc.textContent = envAsk.description;
            meta.appendChild(desc);
        }
        container.appendChild(meta);

        if (envAsk.state === 'pending') {
            // 输入区已改为 composer 接管（renderEnvAskTakeover），消息流只留占位提示。
            const wait = document.createElement('div');
            wait.className = 'ai-approval-result pending';
            wait.textContent = '等待你在下方输入区填写变量值…';
            container.appendChild(wait);
        } else {
            const result = document.createElement('div');
            result.className = 'ai-approval-result ' + envAsk.state;
            result.textContent = envAsk.state === 'approved'
                ? (message.status === 'running' ? '正在创建变量…' : '已创建环境变量 ' + envAsk.name)
                : envAsk.state === 'failed'
                    ? '创建失败：' + (message.content || '保存失败')
                    : '已取消，未创建变量';
            container.appendChild(result);
            if (message.content) {
                const output = document.createElement('div');
                output.className = 'ai-approval-output';
                output.textContent = message.content;
                container.appendChild(output);
            }
        }
    }

    function askStateLabel(ask) {
        return {
            pending: '等待回答',
            answered: '已回答',
            skipped: '已跳过',
            timeout: '已超时',
            timeout_abort: '超时停止',
            cancelled: '已取消',
            expired: '已过期',
        }[ask.state] || ask.state;
    }

    function askResultText(ask) {
        if (ask.state === 'timeout' && ask.source === 'timeout_recommended') return '超时未回答，已自动采用推荐项';
        if (ask.state === 'timeout') return '超时未回答，已交给 AI 决定并继续';
        if (ask.state === 'timeout_abort') return '超时未回答，已停止本轮';
        if (ask.state === 'cancelled') return '问题已取消';
        if (ask.state === 'skipped') return '你跳过了回答';
        if (ask.state === 'expired') return '页面已关闭，问题未回答';
        return '';
    }

    function renderAskCard(wrap, message) {
        const ask = message.ask;
        const card = document.createElement('div');
        card.className = 'ai-ask-card ' + ask.state;
        const head = document.createElement('div');
        head.className = 'ai-ask-head';
        const icon = document.createElement('span');
        icon.className = 'ai-ask-icon';
        icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.7.6-.7 1.1v.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".75" fill="currentColor"/></svg>';
        const title = document.createElement('span');
        title.className = 'ai-ask-title';
        title.textContent = ask.questions.length > 1 ? 'AI 提问 · ' + ask.questions.length + ' 个问题' : 'AI 提问';
        const state = document.createElement('span');
        state.className = 'ai-ask-state';
        state.textContent = askStateLabel(ask);
        head.append(icon, title, state);
        card.appendChild(head);
        if (ask.state === 'pending') {
            const pending = document.createElement('div');
            pending.className = 'ai-ask-question';
            pending.textContent = '等待在底部输入框回答…';
            card.appendChild(pending);
            wrap.appendChild(card);
            return;
        }
        ask.questions.forEach((question, index) => {
            const block = document.createElement('div');
            block.className = 'ai-ask-record';
            const q = document.createElement('div');
            q.className = 'ai-ask-question';
            q.textContent = (ask.questions.length > 1 ? (index + 1) + '. ' : '') + question.question;
            block.appendChild(q);
            if (question.detail) {
                const detail = document.createElement('div');
                detail.className = 'ai-ask-detail';
                detail.textContent = question.detail;
                block.appendChild(detail);
            }
            const answer = (ask.answers || []).find((item) => item.id === question.id) || {};
            const lines = [];
            if (answer.selected && answer.selected.length) lines.push('选择：' + answer.selected.join('、'));
            if (answer.custom) lines.push('补充：' + answer.custom);
            const answerEl = document.createElement('div');
            answerEl.className = 'ai-ask-answer' + (lines.length ? '' : ' empty');
            answerEl.textContent = lines.length ? lines.join('；') : '未回答';
            block.appendChild(answerEl);
            card.appendChild(block);
        });
        const note = askResultText(ask);
        if (note) {
            const result = document.createElement('div');
            result.className = 'ai-ask-result';
            result.textContent = note;
            card.appendChild(result);
        }
        wrap.appendChild(card);
    }

    // 工具卡 ZCode 风格：动词 + 图标 + 主参数（文件名/路径/命令）+ 目录 + diff 统计 + 状态
    // 每个动作使用独立图标，便于一眼区分「读取 / 搜索 / 写入」等不同操作。
    function toolMeta(name, approval) {
        switch (name) {
            case 'read_file': return {verb: '读取', icon: 'eye'};
            case 'list_dir': return {verb: '列目录', icon: 'folder'};
            case 'search_text': return {verb: '搜索', icon: 'search'};
            case 'web_search': return {verb: '联网搜索', icon: 'web-search'};
            case 'web_fetch': return {verb: '读取网页', icon: 'globe'};
            case 'write_file': return {verb: (approval && approval.newFile) ? '新建' : '写入', icon: 'save'};
            case 'edit_file': return {verb: '编辑', icon: 'rename'};
            case 'propose_patch': return {verb: '补丁', icon: 'save'};
            case 'run_command': return {verb: '终端', icon: 'terminal'};
            case 'background_command': return {verb: '后台命令', icon: 'terminal'};
            case 'check_command': return {verb: '查询作业', icon: 'refresh'};
            case 'stop_command': return {verb: '停止作业', icon: 'close'};
            case 'schedule_create': return {verb: '创建定时任务', icon: 'clock'};
            case 'schedule_list': return {verb: '定时任务列表', icon: 'clock'};
            case 'schedule_delete': return {verb: '删除定时任务', icon: 'trash'};
            case 'schedule_toggle': return {verb: '启停定时任务', icon: 'refresh'};
            case 'spawn_agent': return {verb: '子代理', icon: 'agents'};
            case 'memory_list': return {verb: '记忆目录', icon: 'book'};
            case 'memory_read': return {verb: '读取记忆', icon: 'book-open'};
            case 'memory_write': return {verb: '写入记忆', icon: 'book-plus'};
            case 'preference_list': return {verb: '偏好列表', icon: 'bookmark'};
            case 'preference_write': return {verb: '记录偏好', icon: 'bookmark-plus'};
            case 'preference_remove': return {verb: '删除偏好', icon: 'trash'};
            case 'skill_use': return {verb: '技能', icon: 'star'};
            case 'plan_mode': return {verb: '计划模式', icon: 'compass'};
            case 'ask_user': return {verb: '提问', icon: 'info'};
            case 'app_control': return {verb: '应用操作', icon: 'gear'};
            case 'todo_write': return {verb: '任务', icon: 'check'};
            case 'env_list': return {verb: '环境变量', icon: 'shield'};
            case 'env_create': return {verb: '新建变量', icon: 'shield-plus'};
            case 'browser_navigate': return {verb: '打开网页', icon: 'browser'};
            case 'browser_back': return {verb: '后退', icon: 'back'};
            case 'browser_forward': return {verb: '前进', icon: 'forward'};
            case 'browser_reload': return {verb: '刷新页面', icon: 'refresh'};
            case 'browser_snapshot': return {verb: '页面快照', icon: 'doc'};
            case 'browser_screenshot': return {verb: '截图', icon: 'camera'};
            case 'browser_click': return {verb: '点击', icon: 'cursor'};
            case 'browser_type': return {verb: '输入', icon: 'keyboard'};
            case 'browser_press_key': return {verb: '按键', icon: 'keycap'};
            case 'browser_resize': return {verb: '调整视口', icon: 'maximize'};
            case 'browser_evaluate': return {verb: '执行脚本', icon: 'code'};
            case 'browser_close': return {verb: '关闭页面', icon: 'close'};
            default: return {verb: name || '工具', icon: 'doc'};
        }
    }

    function toolPrimary(message) {
        let args = {};
        try {
            args = JSON.parse(message.arguments || '{}') || {};
        } catch (e) {}
        const path = aiTextOf(args.path).trim();
        const base = path ? path.replace(/^.*[\\/]/, '') : '';
        const dir = base && path.length > base.length ? path.slice(0, path.length - base.length).replace(/[\\/]+$/, '') : '';
        switch (message.name) {
            case 'read_file': case 'write_file': case 'edit_file':
                return {primary: base || path || '—', dir};
            case 'list_dir':
                return {primary: aiTextOf(args.path).trim() || '.', dir: ''};
            case 'search_text':
                return {primary: aiTextOf(args.query).trim() || '—', dir: ''};
            case 'web_search':
                return {primary: aiTextOf(args.query).trim() || '—', dir: ''};
            case 'web_fetch':
                return {primary: aiTextOf(args.url).trim() || '—', dir: ''};
            case 'browser_navigate':
                return {primary: aiTextOf(args.url).trim() || '—', dir: ''};
            case 'browser_click': case 'browser_type':
                return {primary: aiTextOf(args.selector).trim() || '—', dir: ''};
            case 'browser_press_key':
                return {primary: aiTextOf(args.key).trim() || '—', dir: ''};
            case 'browser_resize':
                return {primary: (Math.round(Number(args.width)) || '?') + '×' + (Math.round(Number(args.height)) || '?'), dir: ''};
            case 'browser_evaluate':
                return {primary: aiTextOf(args.script).trim().replace(/\s+/g, ' ').slice(0, 80) || '—', dir: ''};
            case 'browser_back': case 'browser_forward': case 'browser_reload':
            case 'browser_snapshot': case 'browser_screenshot': case 'browser_close':
                return {primary: '', dir: ''};
            case 'plan_mode':
                return {primary: args.enabled === false ? '退出' : '进入', dir: ''};
            case 'run_command':
                return {primary: aiTextOf(args.command).trim().replace(/\s+/g, ' '), dir: ''};
            case 'background_command':
                return {primary: aiTextOf(args.command).trim().replace(/\s+/g, ' '), dir: ''};
            case 'check_command': case 'stop_command':
                return {primary: aiTextOf(args.jobId).trim() || '—', dir: ''};
            case 'schedule_create':
                return {primary: aiTextOf(args.name).trim() || aiTextOf(args.prompt).trim().slice(0, 40) || '—', dir: ''};
            case 'schedule_list':
                return {primary: '定时任务', dir: ''};
            case 'schedule_delete': case 'schedule_toggle':
                return {primary: aiTextOf(args.id).trim() || '—', dir: ''};
            case 'spawn_agent':
                return {primary: aiTextOf(args.name).trim() || '—', dir: ''};
            case 'memory_read': case 'memory_write':
                return {primary: aiTextOf(args.name).trim() || '—', dir: ''};
            case 'memory_list':
                return {primary: '记忆目录', dir: ''};
            case 'preference_write': case 'preference_remove':
                return {primary: aiTextOf(args.text || args.id).trim().slice(0, 80) || '—', dir: ''};
            case 'preference_list':
                return {primary: '用户偏好', dir: ''};
            case 'skill_use':
                return {primary: aiTextOf(args.name).trim() || '—', dir: ''};
            case 'app_control':
                return {primary: aiTextOf(args.action).trim() || '—', dir: ''};
            case 'ask_user': case 'todo_write': case 'env_list': case 'env_create':
                return {primary: '', dir: ''};
            default:
                return {primary: toolArgsSummary(message.arguments), dir: ''};
        }
    }

    function toolFileVerb(message) {
        return message.name === 'read_file' || message.name === 'write_file' || message.name === 'edit_file';
    }

    // diff 视图（带行号：− 行显示旧行号，+/空白行显示新行号）
    function renderDiffInto(container, approval) {
        if (!approval.diff || !approval.diff.length) return;
        const diff = document.createElement('div');
        diff.className = 'ai-diff';
        let oldLine = 1;
        let newLine = 1;
        for (const line of approval.diff) {
            if (line.t === '…') {
                const gap = document.createElement('div');
                gap.className = 'ai-diff-line gap';
                gap.textContent = '…';
                diff.appendChild(gap);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'ai-diff-line ' + (line.t === '+' ? 'add' : (line.t === '-' ? 'del' : 'ctx'));
            const no = document.createElement('span');
            no.className = 'ai-diff-no';
            no.textContent = line.t === '-' ? String(oldLine) : String(newLine);
            if (line.t === '-') oldLine++;
            else newLine++;
            const sign = document.createElement('span');
            sign.className = 'ai-diff-sign';
            sign.textContent = line.t === '+' ? '+' : (line.t === '-' ? '−' : ' ');
            const text = document.createElement('span');
            text.className = 'ai-diff-text';
            text.textContent = line.text || ' ';
            row.append(no, sign, text);
            diff.appendChild(row);
        }
        container.appendChild(diff);
    }

    function renderToolMessage(wrap, message) {
        if (message.ask) {
            renderAskCard(wrap, message);
            return;
        }
        const card = document.createElement('div');
        const approval = message.approval;
        const envAsk = message.envAsk;
        const isCommand = message.name === 'run_command' || message.name === 'background_command';
        const agentRunning = message.name === 'spawn_agent' && message.agent && message.agent.state === 'running';
        const bgRunning = message.name === 'background_command' && message.bg && message.bg.state === 'running';
        card.className = 'ai-tool-card ' + (agentRunning || bgRunning ? 'running' : (message.status || 'done')) + (approval ? ' has-approval' : '') + (envAsk ? ' has-approval' : '') + (isCommand ? ' command' : '') + (message.name === 'spawn_agent' ? ' agent' : '') + (message.interrupted ? ' interrupted' : '');
        if ((approval && approval.state === 'pending') || (envAsk && envAsk.state === 'pending')) card.classList.add('approval-pending');
        wrap.appendChild(card);
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-tool-head';
        const chev = document.createElement('span');
        chev.className = 'ai-tool-chev';
        chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        // 动作词 + 图标 + 主参数（ZCode 风格）
        const meta = toolMeta(message.name, approval);
        const info = toolPrimary(message);
        const icon = document.createElement('span');
        icon.className = 'ai-tool-icon';
        icon.innerHTML = iconSvg(meta.icon, 13);
        const verb = document.createElement('span');
        verb.className = 'ai-tool-verb';
        verb.textContent = meta.verb;
        // 执行中：头部最前放旋转加载图标（替代旧 border-left 指示）
        if (message.status === 'running') {
            const spinner = document.createElement('span');
            spinner.className = 'ai-tool-spinner';
            head.appendChild(spinner);
        }
        head.append(chev, icon, verb);
        if (toolFileVerb(message) && info.primary && info.primary !== '—') {
            head.appendChild(createFileIcon(info.primary, 'ai-tool-fileicon'));
        }
        if (info.primary) {
            const primary = document.createElement('span');
            primary.className = 'ai-tool-primary';
            primary.textContent = info.primary;
            primary.title = info.primary;
            head.appendChild(primary);
        }
        if (info.dir) {
            const dir = document.createElement('span');
            dir.className = 'ai-tool-dir';
            dir.textContent = info.dir;
            dir.title = info.dir;
            head.appendChild(dir);
        }
        if (approval && toolFileVerb(message) && message.name !== 'read_file' && (approval.added || approval.removed)) {
            const add = document.createElement('span');
            add.className = 'ai-tool-stat add';
            add.textContent = '+' + approval.added;
            const del = document.createElement('span');
            del.className = 'ai-tool-stat del';
            del.textContent = '−' + approval.removed;
            head.append(add, del);
        }
        const state = document.createElement('span');
        state.className = 'ai-tool-state';
        state.textContent = toolStateText(message);
        head.append(state);
        head.addEventListener('click', () => {
            card.dataset.userToggled = '1';
            card.classList.toggle('collapsed');
            if (message.toolCallId) toolFoldState.set(message.toolCallId, card.classList.contains('collapsed'));
        });
        const body = document.createElement('div');
        body.className = 'ai-tool-body';
        if (message.name === 'spawn_agent' && message.agent) {
            // 子代理卡片：任务 + 轮次用时 + 实时转录（内存态）/ 最终摘要
            const agent = message.agent;
            const task = document.createElement('div');
            task.className = 'ai-agent-task';
            task.textContent = agent.task || '';
            task.title = agent.task || '';
            body.appendChild(task);
            const transcript = subAgentTranscripts.get(agent.key || message.toolCallId);
            if (transcript && transcript.length) {
                const list = document.createElement('div');
                list.className = 'ai-agent-transcript';
                for (const entry of transcript.slice(-40)) {
                    const item = document.createElement('div');
                    item.className = 'ai-agent-entry ' + entry.role;
                    const tag = document.createElement('span');
                    tag.className = 'ai-agent-entry-tag';
                    tag.textContent = entry.role === 'tool' ? (entry.name || '工具') : '子代理';
                    const text = document.createElement('span');
                    text.className = 'ai-agent-entry-text';
                    text.textContent = entry.text || '';
                    item.append(tag, text);
                    list.appendChild(item);
                }
                body.appendChild(list);
            } else if (agent.state !== 'running') {
                const archived = document.createElement('div');
                archived.className = 'ai-agent-archived';
                archived.textContent = '子对话已归档（不随会话持久化）';
                body.appendChild(archived);
            }
            if (agent.state !== 'running' && agent.summary) {
                const meta = document.createElement('div');
                meta.className = 'ai-agent-meta';
                meta.textContent = (agent.depth > 1 ? '第 ' + agent.depth + ' 层 · ' : '') +
                    '轮次 ' + (agent.rounds || 0) + ' · 用时 ' + Math.round((agent.ms || 0) / 1000) + 's' +
                    (agent.tokens ? ' · ' + agent.tokens + ' tokens' : '') +
                    (agent.state === 'error' ? ' · 失败' : (agent.state === 'stopped' ? ' · 已停止' : ''));
                const summary = document.createElement('div');
                summary.className = 'ai-agent-summary';
                summary.textContent = agent.summary;
                body.append(meta, summary);
            }
        } else if (approval) {
            body.classList.add('ai-tool-approval-body');
            // 已执行的写文件/编辑：头部已带路径与 diff 统计，正文只渲染 diff 视图
            renderApprovalBody(body, message, approval, {skipMeta: message.name === 'write_file' || message.name === 'edit_file'});
        } else if (envAsk) {
            body.classList.add('ai-tool-approval-body');
            renderEnvAskBody(body, message, envAsk);
        } else if (isCommand) {
            // $ 命令块（长命令折叠「展开命令」）+ 输出
            let command = '';
            try {
                command = aiTextOf(JSON.parse(message.arguments || '{}').command).trim();
            } catch (e) {}
            if (command) {
                const cmdLine = document.createElement('div');
                cmdLine.className = 'ai-cmd-line';
                const dollar = document.createElement('span');
                dollar.className = 'ai-cmd-dollar';
                dollar.textContent = '$';
                const cmdText = document.createElement('span');
                cmdText.className = 'ai-cmd-text';
                cmdText.textContent = command;
                cmdText.title = command;
                cmdLine.append(dollar, cmdText);
                if (command.length > 120 || /\n/.test(command)) {
                    cmdLine.classList.add('clamped');
                    const more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'ai-cmd-more';
                    more.textContent = '展开命令';
                    more.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const clamped = cmdLine.classList.toggle('clamped');
                        more.textContent = clamped ? '展开命令' : '收起命令';
                    });
                    body.append(cmdLine, more);
                } else {
                    body.appendChild(cmdLine);
                }
            }
            const output = document.createElement('div');
            output.className = 'ai-cmd-output';
            output.textContent = message.content || (message.status === 'running' ? '执行中…' : '（无输出）');
            body.appendChild(output);
            // 后台命令：命令下方实时追加输出（cmd-out 广播驱动；重新渲染时从 bgLog 恢复）
            if (message.name === 'background_command') {
                const live = document.createElement('div');
                live.className = 'ai-cmd-output ai-bg-live';
                live.textContent = message.bgLog || '（等待输出…）';
                body.appendChild(live);
            }
        } else {
            body.textContent = message.content || (message.status === 'running' ? '执行中…' : '（无输出）');
        }
        card.append(head, body);
        if ((approval && approval.state === 'pending') || (envAsk && envAsk.state === 'pending')) return;
        // 终端命令默认只显示一行摘要（命令 + 状态），点击展开完整输出。
        if (isCommand) {
            card.classList.add('collapsed');
        }
        if (message.status !== 'running' && message.status !== 'error') card.classList.add('collapsed');
        // 用户手动展开/收起过的卡片以偏好为准，覆盖上面的默认折叠规则。
        if (message.toolCallId) {
            const storedFold = toolFoldState.get(message.toolCallId);
            if (storedFold !== undefined) card.classList.toggle('collapsed', storedFold);
        }
    }

    function enhanceAICodeBlocks(root) {
        if (!root) return;
        const blocks = [];
        root.querySelectorAll('.md-code-frame').forEach((frame) => blocks.push(frame));
        root.querySelectorAll('pre').forEach((pre) => {
            // 可视化卡片的源码面板自带复制按钮，不再包一层 ai-code-wrap
            if (!pre.closest('.md-code-frame') && !pre.closest('.ai-widget')) blocks.push(pre);
        });
        for (const block of blocks) {
            const code = block.querySelector('code') || block;
            const wrap = document.createElement('div');
            wrap.className = 'ai-code-wrap';
            block.parentNode.insertBefore(wrap, block);
            wrap.appendChild(block);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ai-code-copy';
            button.title = '复制代码';
            button.textContent = '复制';
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                copyText(code.textContent || '', '代码');
            });
            wrap.appendChild(button);
        }
    }

    function updateAssistantElement(wrap, message, streaming, options) {
        if (!wrap) return;
        const hideThinking = !!(options && options.hideThinking);
        const expandThinking = !!(options && options.expandThinking);
        wrap.classList.toggle('streaming', !!streaming);
        if (!streaming) wrap.classList.remove('actions-visible');
        const meta = wrap.querySelector('.ai-msg-meta');
        if (meta) {
            meta.innerHTML = '';
            const who = document.createElement('span');
            who.textContent = 'AI';
            const model = document.createElement('span');
            model.className = 'ai-model';
            model.textContent = message.model || '';
            const time = document.createElement('span');
            time.textContent = aiFormatTime(message.ts);
            meta.append(who);
            if (model.textContent) meta.appendChild(model);
            meta.appendChild(time);
        }

        let think = wrap.querySelector('.ai-think');
        if (settings.aiShowThinking !== false && !hideThinking && (message.reasoning || streaming)) {
            const thinkKey = aiThinkKey(message, Number(wrap.dataset.aiIdx));
            if (!think) {
                think = document.createElement('div');
                think.className = 'ai-think';
                think.dataset.thinkKey = thinkKey;
                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'ai-think-head';
                const chev = document.createElement('span');
                chev.className = 'ai-think-chev';
                chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                const label = document.createElement('span');
                label.className = 'ai-think-label';
                head.append(chev, label);
                head.addEventListener('click', () => toggleThink(think));
                const body = document.createElement('div');
                body.className = 'ai-think-body';
                think.append(head, body);
                wrap.insertBefore(think, wrap.querySelector('.ai-bubble'));
            }
            think.dataset.thinkKey = thinkKey;
            think.classList.toggle('thinking', !!streaming);
            const head = think.querySelector('.ai-think-head');
            const label = think.querySelector('.ai-think-label');
            if (label) label.textContent = aiThinkLabel(message, !!streaming);
            renderThinkBody(think.querySelector('.ai-think-body'), message, !!streaming);
            const storedThink = thinkFoldState.get(thinkKey);
            if (storedThink !== undefined) think.classList.toggle('collapsed', storedThink);
            else if (!streaming && !expandThinking) think.classList.add('collapsed');
            else think.classList.remove('collapsed');
            if (head) head.title = '展开 / 收起思考过程';
        } else if (think) {
            think.remove();
        }

        // 只找正文容器的 markdown 区：think body 也带 ai-md class 且在 DOM 序上先于 bubble，
        // 裸查 '.ai-md' 会命中它——content 为空时 textContent='' 会清掉刚渲染好的思考内容。
        const md = wrap.querySelector('.ai-bubble .ai-md');
        if (md) {
            md.classList.toggle('error-text', message.status === 'error' && !message.content);
            if (message.status === 'error' && !message.content) {
                md.textContent = message.error ? ('请求失败：' + message.error) : '请求失败';
            } else if (message.content) {
                md.innerHTML = renderMarkdown(message.content);
                enhanceAICodeBlocks(md);
                resolveAIImages(md);
                // svg / html 围栏 → 可视化卡片；流式期间只占位，整轮结束后再挂载
                enhanceWidgets(md, {streaming: !!streaming, copyText, openExternal});
            } else if (streaming) {
                md.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
            } else if (message.status === 'stopped') {
                md.textContent = '（已停止生成）';
            } else {
                md.textContent = '';
            }
            const oldError = wrap.querySelector('.ai-error-box');
            if (oldError) oldError.remove();
            if (message.status === 'error' && message.error && message.content) {
                const error = document.createElement('div');
                error.className = 'ai-error-box';
                error.textContent = message.error;
                wrap.querySelector('.ai-bubble').appendChild(error);
            }
        }
        wrap.classList.toggle('error', message.status === 'error');

        // 用量不再单独占一行：并进操作行的「用量」徽标（点开是本轮明细）
        if (!streaming) appendActions(wrap, message, Number(wrap.dataset.aiIdx), currentSession());
    }

    async function acceptPlan(session, message, families) {
        if (!session || streamOf(session.id) || !session.planMode || !message || !message.planMode) return;
        if (currentScopeOf(session) === 'read') {
            flash('当前为「只读访问」，执行阶段无法修改文件；请先在下方切换权限', true);
            return;
        }
        const cwd = getScopeRoot() || '';
        if (Array.isArray(families) && cwd) {
            for (const signature of families) {
                if (signature) addCommandApprovalRule(session, {mode: 'family', signature, cwd});
            }
        }
        session.planMode = false;
        setDismissedPlanApproval('');
        persistSessions();
        updateScopeUI();
        updateComposerTakeover(true);
        renderMessageQueue();
        renderMessages(true);
        const ok = await submitText('计划已批准，请立即按上面的计划开始执行，不要重复计划内容。');
        if (!ok) {
            session.planMode = true;
            persistSessions();
            updateScopeUI();
            updateComposerTakeover(true);
            renderMessages(true);
        }
    }
    return {
        renderCommandApprovalBody,
        renderApprovalBody,
        renderEnvAskBody,
        renderAskCard,
        renderDiffInto,
        renderToolMessage,
        updateAssistantElement,
        toolMeta,
        acceptPlan,
        askStateLabel,
        askResultText,
        enhanceAICodeBlocks,
    };
}
