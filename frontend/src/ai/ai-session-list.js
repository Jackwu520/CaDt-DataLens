// ai-session-list.js：会话列表域（侧栏列表/工作区分组/未读标记 + 会话搜索 + 列表与会话右键菜单）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// sessions 为重赋值 let 且模块内只读（经 getSessions()），stickBottom 经 setStickBottom 写。
// 列表分组状态与搜索状态为域私有，随域迁入本模块。
import {iconSvg} from '../core/icons.js';
import {aiTextOf, aiFormatSessionTime} from './ai-constants.js';
import {sessionActivityTs} from './ai-session-store.js';

// 活动栏「AI 会话」图标状态点的聚合（纯函数，env 注入判定，便于单测）：
// 只统计当前工作区的非归档会话，按 error > pending > done 取最高优先级的一个；
// running / '' 不产生点。当前工作区键为空时一律不显示（未打开工作区）。
export function aggregateSessionBadge(sessions, env) {
    const list = Array.isArray(sessions) ? sessions : [];
    const statusOf = typeof env.sessionStatus === 'function' ? env.sessionStatus : () => '';
    const keyOf = typeof env.workspaceKeyOf === 'function' ? env.workspaceKeyOf : () => '';
    const currentKey = typeof env.currentWorkspaceKey === 'function' ? env.currentWorkspaceKey() : '';
    if (!currentKey) return '';
    let hasError = false;
    let hasPending = false;
    let hasDone = false;
    for (const session of list) {
        if (!session || session.archivedAt) continue;
        if (keyOf(session) !== currentKey) continue;
        const status = statusOf(session);
        if (status === 'error') hasError = true;
        else if (status === 'pending') hasPending = true;
        else if (status === 'done') hasDone = true;
    }
    if (hasError) return 'error';
    if (hasPending) return 'pending';
    if (hasDone) return 'done';
    return '';
}

// 计划待批准是否需要用户注意（会话列表 pending/info 角标的判定之一，纯函数便于单测）。
// AI 正在为这份计划工作时（用户点「继续规划」发来修订意见、新一轮在跑），流挂着就不算
// 「等用户动手」——列表应显示 running 而非 pending。与 planApprovalMessage 的 streamOf
// 前置判定同源：流在跑时审批卡也隐藏。
export function planPendingNeedsAttention(session, hasStream) {
    return !!(session && session.planMode && session.activePlan &&
        session.activePlan.status === 'pending' && !hasStream);
}

// 支线紧跟母会话：按传入顺序（已按活跃度排序）铺平，再把每条支线插到它的母会话之后。
// 母会话已删除、或 sideOf 成环时按普通会话处理——渲染不能因为元数据坏了就少一条会话。
export function orderSessionsWithSides(list) {
    const source = Array.isArray(list) ? list : [];
    const byId = new Map(source.map((session) => [session.id, session]));
    const children = new Map();
    const roots = [];
    for (const session of source) {
        const parent = session && session.sideOf ? byId.get(session.sideOf) : null;
        if (parent && parent !== session) {
            if (!children.has(parent.id)) children.set(parent.id, []);
            children.get(parent.id).push(session);
        } else {
            roots.push(session);
        }
    }
    const out = [];
    const seen = new Set();
    const walk = (session) => {
        if (!session || seen.has(session.id)) return;
        seen.add(session.id);
        out.push(session);
        for (const child of children.get(session.id) || []) walk(child);
    };
    for (const session of roots) walk(session);
    for (const session of source) walk(session);
    return out;
}

// 工作区分组默认展开判定（纯函数，配 ai-session-list.test.mjs）：
// - 用户手动切换过该分组（override 有布尔值）→ 尊重显式选择；
// - 否则默认只展开当前工作区，其余收起；
// - 未打开工作区（currentKey 为空）时展开第一个分组，避免所有会话都藏在收起的分组里。
export function workspaceGroupExpanded(key, group, env) {
    const override = env && env.override && typeof env.override.get === 'function'
        ? env.override.get(key) : undefined;
    if (typeof override === 'boolean') return override;
    const currentKey = typeof env.currentKey === 'function' ? env.currentKey() : (env && env.currentKey) || '';
    if (currentKey) return !!(group && group.current);
    return key === (env && env.firstKey);
}

// 会话右键菜单项组装（纯函数，配 ai-session-list.test.mjs）：act 是符号动作键，
// showSessionMenu 负责映射成真实闭包。显隐规则——不适用的项直接不出现：
// 支线才有「提升为独立会话」、信箱有积压才有「清空信箱」、
// 磁盘存储才有「复制会话路径」（内存/legacy 模式没有磁盘路径可复制）。
export function buildSessionMenuItems(session, env) {
    const pending = Math.max(0, Number(env.pendingNoticeCount(session.id)) || 0);
    const archived = !!session.archivedAt;
    const items = [
        {label: '新建会话', icon: 'plus', act: 'new'},
        {label: '新建支线对话', icon: 'sidechat', act: 'newSide'},
        {sep: true},
        {label: session.pinned ? '取消置顶' : '置顶会话', icon: 'pin', disabled: archived, act: 'togglePin'},
        {label: '重命名会话…', icon: 'rename', act: 'rename'},
        {label: '导出会话…', icon: 'export', act: 'export'},
        {label: '会话数据诊断…', icon: 'chart', act: 'diagnostics'},
        // 监控窗（辅助窗第一批）：只读镜像，不改会话归属；绑定缺失（旧 mock）时灰置
        {label: '在独立窗口打开（监控）', icon: 'new-window', act: 'monitor', disabled: !env.canMonitor},
    ];
    if (session.sideOf) items.push({label: '提升为独立会话', icon: 'new-window', act: 'promote'});
    if (pending > 0) items.push({label: '清空信箱（' + pending + ' 条）', icon: 'eraser', act: 'clearMailbox'});
    items.push({sep: true});
    items.push({label: '复制会话ID', icon: 'copy', act: 'copyId'});
    if (env.diskStorage) items.push({label: '复制会话路径', icon: 'folder', act: 'copyPath'});
    // 归档紧挨删除、放在它上面（对齐图 2 的底部布局：归档 → 永久删除）
    items.push({sep: true});
    items.push({label: archived ? '取消归档' : '归档会话', icon: archived ? 'unarchive' : 'archive', act: 'archive'});
    items.push({label: '删除会话', icon: 'trash', danger: true, act: 'remove'});
    return items;
}

// 工作区分组头「⋯」菜单组装（纯函数，配 ai-session-list.test.mjs）：act 是符号动作键，
// showWorkspaceMenu 负责映射成真实闭包。有 path 的分组给「资源管理器显示 / 复制路径 /
// 新窗口打开 / 在此新建会话」；未关联工作区的分组只给「打开文件夹 / 最近打开」。
// 关闭工作区只对当前工作区出现；最近打开以子菜单（act=openRecent + arg=path）给出。
export function buildWorkspaceMenuItems(group, env) {
    const path = group && group.path ? group.path : '';
    const isCurrent = !!(group && group.current && path);
    const recent = Array.isArray(env.recent) ? env.recent : [];
    const items = [];
    if (path) {
        items.push({label: '在文件资源管理器中显示', act: 'reveal'});
        items.push({label: '复制工作区路径', act: 'copyPath'});
        items.push({label: '在新窗口打开此工作区', act: 'openNewWindow', disabled: isCurrent});
        items.push({sep: true});
        items.push({label: '在此工作区新建会话', act: 'newSession'});
        items.push({sep: true});
    }
    items.push({label: '打开文件夹…', act: 'openFolder'});
    if (recent.length) {
        items.push({
            label: '最近打开的工作区',
            submenu: recent.map((entry) => ({
                label: entry.name || env.baseName(entry.path) || entry.path,
                act: 'openRecent',
                arg: entry.path,
            })),
        });
    }
    if (isCurrent) {
        items.push({sep: true});
        items.push({label: '关闭当前工作区', act: 'close'});
    }
    return items;
}

export function createAISessionList(ctx) {
    const el = ctx.el;
    const sessionListEl = ctx.sessionListEl;
    const sessionMoreBtn = ctx.sessionMoreBtn;
    const renderWindows = ctx.renderWindows;
    const streams = ctx.streams;
    const backend = ctx.backend;
    const aiWorkspaceKey = ctx.aiWorkspaceKey;
    const aiWorkspaceName = ctx.aiWorkspaceName;
    const sessionWorkspacePath = ctx.sessionWorkspacePath;
    const sessionUseDisk = ctx.sessionUseDisk;
    // 支线对话动作（阶段 F）：面板经惰性转发注入，缺省时菜单项空操作不报错
    const openSideChat = typeof ctx.openSideChat === 'function' ? ctx.openSideChat : () => {};
    const promoteSideChat = typeof ctx.promoteSideChat === 'function' ? ctx.promoteSideChat : () => {};
    // 会话信箱（阶段 H）：未消费条数与清空入口
    const clearMailbox = typeof ctx.clearMailbox === 'function' ? ctx.clearMailbox : () => 0;
    const pendingNoticeCount = typeof ctx.pendingNoticeCount === 'function' ? ctx.pendingNoticeCount : () => 0;
    const stopSessionTurn = typeof ctx.stopSessionTurn === 'function' ? ctx.stopSessionTurn : () => {};
    const listFlash = typeof ctx.flash === 'function' ? ctx.flash : () => {};
    const copyText = typeof ctx.copyText === 'function' ? ctx.copyText : async () => {};
    const currentSession = ctx.currentSession;
    // 首次读盘未完成（磁盘模式的启动瞬间）：sessions 还是占位，不能当真实列表画出来
    const sessionsPending = typeof ctx.sessionsPending === 'function' ? ctx.sessionsPending : () => false;
    // 条数单一来源：懒加载占位（_stub）读 meta 里缓存的条数，已载体的会话现算
    const messageCountOf = typeof ctx.messageCount === 'function'
        ? ctx.messageCount
        : ((session) => (session && session.messages ? session.messages.length : 0));
    const currentWorkspacePath = ctx.currentWorkspacePath;
    const isOpen = ctx.isOpen;
    const ensureOpen = ctx.ensureOpen;
    const persistSessions = ctx.persistSessions;
    const renderMessages = ctx.renderMessages;
    const renderModelChip = ctx.renderModelChip;
    const sessionById = ctx.sessionById;
    const sessionHasLiveBgJob = ctx.sessionHasLiveBgJob;
    const switchSession = ctx.switchSession;
    const updateHeadHud = ctx.updateHeadHud;
    const toggleSessionPin = ctx.toggleSessionPin;
    const renameSession = ctx.renameSession;
    const exportSession = ctx.exportSession;
    const showSessionDiagnostics = ctx.showSessionDiagnostics;
    const archiveSession = ctx.archiveSession;
    const deleteSession = ctx.deleteSession;
    const newSession = ctx.newSession;
    const newSessionInWorkspace = ctx.newSessionInWorkspace;
    const openAILogDir = ctx.openAILogDir;
    const showContextMenu = ctx.showContextMenu;
    // 工作区管理菜单的宿主能力（由 main.js 注入；缺省空操作，浮窗/测试不报错）
    const workspaceMenuHost = ctx.workspaceMenu || {};
    const getSessions = ctx.getSessions;
    const setStickBottom = ctx.setStickBottom;
    // 活动栏会话图标状态点：宿主注入的回调（缺省空操作），由本域统一计算并推送
    const onBadgeChange = typeof ctx.onBadgeChange === 'function' ? ctx.onBadgeChange : () => {};

    // —— 随域迁入的列表状态（原 ai-panel.js 闭包级）；会话搜索框已删（并入全局搜索的「AI 会话」分类）——
    let archivedExpanded = false;
    // 用户显式切换过的分组展开状态：key → boolean。无记录的分组走默认判定
    //（只展开当前工作区，其余收起，见 workspaceGroupExpanded），切换后记住选择。
    const workspaceGroupOverrides = new Map();
    // 每个工作区分组一次只渲染最近 AI_SESSION_GROUP_PAGE 条会话，点分组底部的「···」再追加一页。
    // key = 列表类型 + 工作区 key，进行中与已归档互不影响；只是渲染层的展开状态，不动会话数据。
    const AI_SESSION_GROUP_PAGE = 10;
    const workspaceGroupVisibleCounts = new Map();
    // 会话条目右侧状态图标的悬浮提示
    const SESSION_STATUS_TITLE = {
        running: '会话运行中',
        pending: '待确认：需要用户审批或回答',
        done: '会话已完成，尚未查看',
        error: '会话出错，尚未查看',
    };

    // 配置切换走「模型列表」卡片；旧的 <select id="ai-opt-profile"> 已从 HTML 移除
    function renderProfileSelect() {
        renderModelChip();
    }

    function sessionActivity(session) {
        // 轮次起点，不是最后一条消息：工具刷屏、审批改写、标题生成都不该让条目在列表里跳。
        return sessionActivityTs(session);
    }

    function jumpToMessage(session, index) {
        if (!session || index < 0 || index >= (session.messages || []).length) return;
        setStickBottom(false);
        renderWindows.set(session.id, {start: Math.max(0, index - 3), len: session.messages.length});
        if (currentSession() === session) renderMessages(true);
        setTimeout(() => {
            if (!el.messages) return;
            const node = el.messages.querySelector('.ai-msg[data-ai-idx="' + index + '"]');
            if (!node) return;
            node.scrollIntoView({block: 'center'});
            node.classList.add('ai-msg-jump');
            setTimeout(() => node.classList.remove('ai-msg-jump'), 1600);
        }, 80);
    }

    // ---------- 会话条目状态 ----------
    // 会话条目右侧：未悬浮时显示状态图标，悬浮时换成「⋯」会话操作。
    // pending（等审批 / 等回答 / 计划待批准）优先于 running，因为它是需要用户动手的那一个。
    function sessionNeedsAttention(session) {
        if (!session) return false;
        // 占位会话没有正文：这里返回 false 只是「看不了」，真正要判断得等正文补上来
        //（补水完成后 scheduleSessionListRefresh 会重画一次，徽标随之出现）
        if (session._stub) return false;
        for (const message of session.messages || []) {
            if (!message) continue;
            if (message.approval && message.approval.state === 'pending') return true;
            if (message.ask && message.ask.state === 'pending') return true;
            if (message.envAsk && message.envAsk.state === 'pending') return true;
        }
        // 计划模式：待批准且 AI 没在为该计划工作（见纯函数注释）
        if (planPendingNeedsAttention(session, streams.has(session.id))) return true;
        return false;
    }

    function sessionEntryStatus(session, archived) {
        if (!session || archived || session.archivedAt) return '';
        if (sessionNeedsAttention(session)) return 'pending';
        if (streams.has(session.id)) return 'running';
        // 后台命令可能比本轮活得更久：即使没有流，作业还在跑也要在列表上标出来
        if (sessionHasLiveBgJob(session.id)) return 'running';
        if (session.unread === 'done' || session.unread === 'error') {
            // 正在看这个会话（面板打开且就是当前会话）时没有「未查看」可言：磁盘重读、
            // 另一窗口写入都可能把未读标记带回来，显示出来就是用户盯着的条目上挂绿点，
            // 得再点一次才会消失。这里直接不显示。
            if (isOpen() && currentSession() === session) return '';
            return session.unread;
        }
        return '';
    }

    // 活动栏会话图标状态点：复用逐条状态判定（含「正在查看时抑制未读」的语义），
    // running 归一为空（活动栏不提示运行中），再交给纯函数按工作区与优先级聚合。
    function refreshBadge() {
        const kind = aggregateSessionBadge(getSessions(), {
            sessionStatus: (session) => {
                const status = sessionEntryStatus(session, false);
                return status === 'running' ? '' : status;
            },
            workspaceKeyOf: (session) => aiWorkspaceKey(sessionWorkspacePath(session)),
            currentWorkspaceKey: () => aiWorkspaceKey(currentWorkspacePath()),
        });
        onBadgeChange(kind);
    }

    // 后台结束的会话标一个「未查看」；落盘进 meta，重启后仍然保留。
    function setSessionUnread(session, kind) {
        if (!session || session.archivedAt) return;
        // 面板开着且正看着这个会话：用户当场就看到了结果，不该留未读标记。
        if (isOpen() && currentSession() === session) {
            if (session.unread) {
                session.unread = '';
                persistSessions();
            }
            return;
        }
        const next = kind === 'error' ? 'error' : 'done';
        if (session.unread === next) return;
        session.unread = next;
        persistSessions();
    }

    function clearSessionUnread(session) {
        if (!session || !session.unread) return;
        session.unread = '';
        persistSessions();
    }

    function renderSessionList() {
        // 头部身份（会话标题）与 chips 角标跟随会话列表刷新点（改名/切换/自动标题都会走到这里）
        // 读盘中不给——占位会话的「新会话」标题闪一下没有意义
        if (!sessionsPending()) updateHeadHud();
        // 活动栏状态点跟随每次列表刷新（读盘期间也重算一次，占位会话不产生点）
        refreshBadge();
        if (!sessionListEl) return;
        const scrollTop = sessionListEl.scrollTop;
        sessionListEl.innerHTML = '';
        const current = currentSession();
        if (sessionsPending()) {
            // 启动第一个几百毫秒：磁盘会话还在读，占位列表画出来只会闪一下再被替换
            const loading = document.createElement('div');
            loading.className = 'ai-session-empty';
            const text = document.createElement('div');
            text.textContent = '正在读取会话…';
            loading.appendChild(text);
            sessionListEl.appendChild(loading);
            return;
        }
        const ordered = orderSessionsWithSides(getSessions().slice().sort((a, b) => sessionActivity(b) - sessionActivity(a)));
        if (!ordered.length) {
            const empty = document.createElement('div');
            empty.className = 'ai-session-empty';
            const text = document.createElement('div');
            text.textContent = '还没有会话';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dlg-btn';
            button.textContent = '新建会话';
            button.addEventListener('click', () => {
                ensureOpen();
                newSession();
            });
            empty.append(text, button);
            sessionListEl.appendChild(empty);
            return;
        }

        // 支线徽标只在母会话仍存在时显示：母会话删除后回落为普通会话（元数据不追着清，
        // 「带回主对话」会给出明确提示）
        const liveIds = new Set(getSessions().map((item) => item.id));
        const sideBadgeOn = (session) => {
            const sideOf = aiTextOf(session && session.sideOf).trim();
            return !!sideOf && liveIds.has(sideOf);
        };
        const renderItem = (session, archived) => {
            const item = document.createElement('div');
            item.className = 'ai-session-item' + (current && current.id === session.id ? ' active' : '') + (archived ? ' archived' : '');
            // 支线：缩进 + 「支线」徽标，视觉上从属母会话（排序已保证紧跟其后）
            if (sideBadgeOn(session)) item.classList.add('ai-session-branch');
            item.dataset.aiSessionId = session.id;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            const main = document.createElement('div');
            main.className = 'ai-session-main';
            const titleRow = document.createElement('div');
            titleRow.className = 'ai-session-title-row';
            if (session.pinned && !archived) {
                const pin = document.createElement('span');
                pin.className = 'ai-session-pin';
                pin.innerHTML = iconSvg('pin', 11);
                titleRow.appendChild(pin);
            }
            const title = document.createElement('div');
            title.className = 'ai-session-title';
            title.textContent = session.title || '新会话';
            titleRow.appendChild(title);
            if (sideBadgeOn(session)) {
                const badge = document.createElement('span');
                badge.className = 'ai-session-badge';
                badge.textContent = '支线';
                titleRow.appendChild(badge);
            }
            const meta = document.createElement('div');
            meta.className = 'ai-session-meta';
            meta.textContent = (archived ? '已归档 · ' : '') + messageCountOf(session) + ' 条消息 · ' + aiFormatSessionTime(sessionActivity(session));
            main.append(titleRow, meta);
            // 右侧：未悬浮显示状态（运行中 / 待确认 / 已完成未查看），悬浮换成「⋯」会话操作。
            const side = document.createElement('div');
            side.className = 'ai-session-side';
            const statusKind = sessionEntryStatus(session, archived);
            if (statusKind) {
                const badge = document.createElement('span');
                badge.className = 'ai-session-status ' + statusKind;
                if (statusKind === 'running') {
                    const spinner = document.createElement('span');
                    spinner.className = 'ai-session-status-spin';
                    badge.appendChild(spinner);
                } else if (statusKind === 'pending') {
                    badge.innerHTML = iconSvg('info', 13);
                } else {
                    const dot = document.createElement('span');
                    dot.className = 'ai-session-status-dot';
                    badge.appendChild(dot);
                }
                badge.dataset.tip = SESSION_STATUS_TITLE[statusKind] || '';
                badge.setAttribute('role', 'img');
                badge.setAttribute('aria-label', badge.dataset.tip || '');
                side.appendChild(badge);
            }
            // 后台轮次的停止（§4.14.2）：只在运行中 / 待确认态出现，hover 才显形（防误触）。
            // streams 按会话隔离，停别人不需要先切过去——「静默跑着的轮次」必须有出口。
            if (statusKind === 'running' || statusKind === 'pending') {
                const stopBtn = document.createElement('button');
                stopBtn.type = 'button';
                stopBtn.className = 'ai-session-stop';
                stopBtn.dataset.tip = '停止这个会话的运行';
                stopBtn.setAttribute('aria-label', '停止会话运行');
                stopBtn.innerHTML = iconSvg('stop', 12);
                stopBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    stopSessionTurn(session.id);
                    listFlash('已停止会话「' + (session.title || '新会话') + '」');
                });
                item.appendChild(stopBtn);
            }
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'ai-session-more';
            more.dataset.tip = '会话操作';
            more.innerHTML = iconSvg('more', 13);
            more.addEventListener('click', (e) => {
                e.stopPropagation();
                const rect = more.getBoundingClientRect();
                showSessionMenu(session, rect.left, rect.bottom + 4);
            });
            side.appendChild(more);
            item.append(main, side);
            item.addEventListener('click', () => {
                ensureOpen();
                clearSessionUnread(session);
                if (!current || current.id !== session.id) switchSession(session.id);
            });
            item.addEventListener('keydown', (e) => {
                if (e.target !== item) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                ensureOpen();
                switchSession(session.id);
            });
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showSessionMenu(session, e.clientX, e.clientY);
            });
            sessionListEl.appendChild(item);
        };

        const buildWorkspaceGroups = (list) => {
            const groups = [];
            const byKey = new Map();
            const currentKey = aiWorkspaceKey(currentWorkspacePath());
            for (const session of list) {
                const path = sessionWorkspacePath(session);
                const key = aiWorkspaceKey(path) || '';
                let group = byKey.get(key);
                if (!group) {
                    group = {key, path, sessions: [], latest: 0, current: !!key && key === currentKey};
                    byKey.set(key, group);
                    groups.push(group);
                }
                group.sessions.push(session);
                group.latest = Math.max(group.latest, sessionActivity(session));
            }
            // 当前工作区排最前；其余按最近活动时间倒序；未关联工作区的放最后。
            groups.sort((a, b) => {
                if (a.current !== b.current) return a.current ? -1 : 1;
                if (!!a.key !== !!b.key) return a.key ? -1 : 1;
                return b.latest - a.latest;
            });
            return groups;
        };

        const renderWorkspaceGroups = (list, archived, collapsible) => {
            const groups = buildWorkspaceGroups(list);
            const showHeaders = groups.length > 1 || !!(groups[0] && groups[0].path);
            const firstKey = groups.length ? groups[0].key : '';
            const groupEnv = {
                override: workspaceGroupOverrides,
                currentKey: () => aiWorkspaceKey(currentWorkspacePath()),
                firstKey,
            };
            for (const group of groups) {
                if (showHeaders) {
                    const expanded = workspaceGroupExpanded(group.key, group, groupEnv);
                    const collapsed = collapsible && !expanded;
                    // 用 div 承载：头部内含两个真实 button，避免 button 嵌套 button 的非法结构。
                    const head = document.createElement('div');
                    head.className = 'ai-session-group-head' + (group.current ? ' current' : '') + (collapsed ? '' : ' expanded');
                    if (collapsible) {
                        head.tabIndex = 0;
                        head.setAttribute('role', 'button');
                        head.setAttribute('aria-expanded', String(!collapsed));
                    }
                    const chev = document.createElement('span');
                    chev.className = 'ai-session-group-chev';
                    chev.innerHTML = iconSvg('chevron-right', 12);
                    const icon = document.createElement('span');
                    icon.className = 'ai-session-group-icon';
                    icon.innerHTML = iconSvg(group.path ? 'folder' : 'circle', 12);
                    const name = document.createElement('span');
                    name.className = 'ai-session-group-name';
                    name.textContent = group.path ? aiWorkspaceName(group.path) : '未关联工作区';
                    // 分组头右侧不再显示会话数：悬浮时才出现「新建会话 / 会话操作」两个图标。
                    const actions = document.createElement('span');
                    actions.className = 'ai-session-group-actions';
                    const add = document.createElement('button');
                    add.type = 'button';
                    add.className = 'ai-session-group-action';
                    add.dataset.tip = '新建会话';
                    add.setAttribute('aria-label', '新建会话');
                    add.innerHTML = iconSvg('plus', 12);
                    add.addEventListener('click', (e) => {
                        e.stopPropagation();
                        workspaceGroupOverrides.set(group.key, true);
                        ensureOpen();
                        newSessionInWorkspace(group);
                        renderSessionList();
                    });
                    const menu = document.createElement('button');
                    menu.type = 'button';
                    menu.className = 'ai-session-group-action';
                    menu.dataset.tip = '工作区操作';
                    menu.setAttribute('aria-label', '工作区操作');
                    menu.innerHTML = iconSvg('more', 12);
                    menu.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const rect = menu.getBoundingClientRect();
                        showWorkspaceMenu(group, rect.left, rect.bottom + 4);
                    });
                    actions.append(add, menu);
                    head.append(chev, icon, name, actions);
                    if (collapsible) {
                        const toggle = () => {
                            workspaceGroupOverrides.set(group.key, !workspaceGroupExpanded(group.key, group, groupEnv));
                            renderSessionList();
                        };
                        head.addEventListener('click', toggle);
                        head.addEventListener('keydown', (e) => {
                            if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
                            e.preventDefault();
                            toggle();
                        });
                    } else {
                        chev.style.visibility = 'hidden';
                    }
                    sessionListEl.appendChild(head);
                    if (collapsed) continue;
                }
                const pageKey = (archived ? 'archived:' : 'active:') + group.key;
                const total = group.sessions.length;
                let visible = Math.min(workspaceGroupVisibleCounts.get(pageKey) || AI_SESSION_GROUP_PAGE, total);
                // 当前会话即使排在分页之外也保持可见，避免切换后高亮条目凭空消失。
                if (current) {
                    const activeIndex = group.sessions.findIndex((session) => session.id === current.id);
                    if (activeIndex >= visible) visible = Math.min(total, activeIndex + 1);
                }
                for (const session of group.sessions.slice(0, visible)) renderItem(session, archived);
                if (visible < total) {
                    const remaining = total - visible;
                    const more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'ai-session-group-more';
                    more.innerHTML = iconSvg('more', 14);
                    const moreTip = '还有 ' + remaining + ' 条会话，点击再显示 ' + Math.min(AI_SESSION_GROUP_PAGE, remaining) + ' 条';
                    more.setAttribute('aria-label', moreTip);
                    more.addEventListener('click', () => {
                        workspaceGroupVisibleCounts.set(pageKey, Math.min(total, visible + AI_SESSION_GROUP_PAGE));
                        renderSessionList();
                    });
                    sessionListEl.appendChild(more);
                }
            }
        };

        const activeList = ordered.filter((session) => !session.archivedAt);
        const archivedList = ordered.filter((session) => session.archivedAt);
        // 置顶会话固定在列表最上方（不受工作区分组与时间排序影响）
        const pinnedList = activeList.filter((session) => session.pinned);
        if (pinnedList.length) {
            const pinHead = document.createElement('div');
            pinHead.className = 'ai-session-pin-head';
            const pinIcon = document.createElement('span');
            pinIcon.innerHTML = iconSvg('pin', 11);
            const pinLabel = document.createElement('span');
            pinLabel.textContent = '置顶 ' + pinnedList.length;
            pinHead.append(pinIcon, pinLabel);
            sessionListEl.appendChild(pinHead);
            for (const session of pinnedList) renderItem(session, false);
        }
        const restActive = activeList.filter((session) => !session.pinned);
        if (!restActive.length) {
            if (!pinnedList.length) {
                const empty = document.createElement('div');
                empty.className = 'ai-session-archive-empty';
                empty.textContent = '没有进行中的会话';
                sessionListEl.appendChild(empty);
            }
        } else {
            renderWorkspaceGroups(restActive, false, true);
        }
        if (archivedList.length) {
            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'ai-session-arch-head' + (archivedExpanded ? ' expanded' : '');
            head.setAttribute('aria-expanded', String(archivedExpanded));
            const chev = document.createElement('span');
            chev.className = 'ai-session-arch-chev';
            chev.innerHTML = iconSvg('chevron-right', 12);
            const label = document.createElement('span');
            label.textContent = '已归档 ' + archivedList.length;
            head.append(chev, label);
            head.addEventListener('click', () => {
                archivedExpanded = !archivedExpanded;
                renderSessionList();
            });
            sessionListEl.appendChild(head);
            if (archivedExpanded) {
                renderWorkspaceGroups(archivedList, true, false);
            }
        }
        sessionListEl.scrollTop = scrollTop;
    }

    function showSessionMenu(session, x, y) {
        if (!showContextMenu) return;
        const actions = {
            new: () => { ensureOpen(); newSession(); },
            newSide: () => { ensureOpen(); openSideChat({session}); },
            togglePin: () => toggleSessionPin(session),
            rename: () => renameSession(session),
            export: () => exportSession(session),
            diagnostics: () => showSessionDiagnostics(session),
            promote: () => promoteSideChat(session),
            clearMailbox: () => { clearMailbox(session.id); },
            // 监控窗（辅助窗第一批）：只读镜像，不改会话归属
            monitor: () => {
                if (!backend.PopOutSession) return;
                backend.PopOutSession(session.id, 'session', sessionWorkspacePath(session) || '')
                    .catch((e) => listFlash('打开监控窗失败：' + ((e && e.message) || e), true));
            },
            archive: () => archiveSession(session, !session.archivedAt),
            copyId: () => { copyText(session.id, '会话ID'); },
            // 磁盘路径找 Go 侧解析（桶名 = 工作区短哈希，前端不复刻规则）；
            // 尚未落盘的会话把 session-gone 转成人话，不弹原始错误
            copyPath: async () => {
                let path = '';
                try {
                    path = await backend.AISessionPath(session.id) || '';
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    listFlash(msg.includes('session-gone') ? '会话尚未落盘' : '取会话路径失败：' + msg, true);
                    return;
                }
                if (path) await copyText(path, '会话路径');
            },
            remove: () => deleteSession(session),
        };
        // act 是符号动作键：菜单结构由纯函数组装（可单测），这里只映射成真实闭包
        const items = buildSessionMenuItems(session, {
            pendingNoticeCount,
            diskStorage: !!sessionUseDisk(),
            canMonitor: !!backend.PopOutSession,
        }).map((item) => (item.act && actions[item.act]) ? {...item, action: actions[item.act]} : item);
        showContextMenu(items, x, y);
    }

    function showSessionListMenu(x, y) {
        if (!showContextMenu) return;
        // 不传坐标时按面板头部的「⋯」定位；工作区分组头复用同一菜单，按被点的图标定位。
        let left = x;
        let top = y;
        if (typeof left !== 'number' || typeof top !== 'number') {
            if (!sessionMoreBtn) return;
            const rect = sessionMoreBtn.getBoundingClientRect();
            left = rect.left;
            top = rect.bottom + 4;
        }
        const session = currentSession();
        showContextMenu([
            {label: '新建会话', action: () => { ensureOpen(); newSession(); }},
            {sep: true},
            {label: session && session.pinned ? '取消置顶当前会话' : '置顶当前会话', disabled: !session || !!(session && session.archivedAt), action: () => toggleSessionPin(session)},
            {label: '重命名当前会话…', disabled: !session, action: () => renameSession(session)},
            {label: '导出当前会话…', disabled: !session, action: () => exportSession(session)},
            {label: '会话数据诊断…', disabled: !session, action: () => showSessionDiagnostics(session)},
            {label: session && session.archivedAt ? '取消归档当前会话' : '归档当前会话', disabled: !session, action: () => archiveSession(session, !(session && session.archivedAt))},
            {sep: true},
            {label: '删除当前会话', danger: true, disabled: !session, action: () => deleteSession(session)},
            {sep: true},
            {label: '打开对话日志目录', action: openAILogDir},
        ], left, top);
    }

    function showWorkspaceMenu(group, x, y) {
        if (!showContextMenu) return;
        const path = group && group.path ? group.path : '';
        const actions = {
            reveal: () => { if (path && workspaceMenuHost.reveal) workspaceMenuHost.reveal(path); },
            copyPath: async () => {
                if (path) await copyText(path, '工作区路径');
            },
            openNewWindow: () => { if (path && workspaceMenuHost.openNewWindow) workspaceMenuHost.openNewWindow(path); },
            newSession: () => {
                workspaceGroupOverrides.set(group.key, true);
                ensureOpen();
                newSessionInWorkspace(group);
                renderSessionList();
            },
            openFolder: () => { if (workspaceMenuHost.openFolder) workspaceMenuHost.openFolder(); },
            openRecent: (arg) => { if (arg && workspaceMenuHost.openFolderSmart) workspaceMenuHost.openFolderSmart(arg); },
            close: () => { if (workspaceMenuHost.closeFolder) workspaceMenuHost.closeFolder(); },
        };
        const baseName = typeof workspaceMenuHost.baseName === 'function'
            ? workspaceMenuHost.baseName
            : (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
        const recent = typeof workspaceMenuHost.recent === 'function' ? workspaceMenuHost.recent() : [];
        const items = buildWorkspaceMenuItems(group, {recent, baseName})
            .map((item) => {
                if (item.submenu) {
                    return {
                        ...item,
                        submenu: item.submenu.map((sub) => (actions[sub.act]
                            ? {...sub, action: () => actions[sub.act](sub.arg)}
                            : sub)),
                    };
                }
                return (item.act && actions[item.act]) ? {...item, action: actions[item.act]} : item;
            });
        showContextMenu(items, x, y);
    }
    return {
        renderProfileSelect,
        sessionActivity,
        setSessionUnread,
        renderSessionList,
        showSessionMenu,
        showSessionListMenu,
        showWorkspaceMenu,
        clearSessionUnread,
        refreshBadge,
    };
}
