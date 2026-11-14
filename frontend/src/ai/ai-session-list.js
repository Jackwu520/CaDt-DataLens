// ai-session-list.js：会话列表域（侧栏列表/工作区分组/未读标记 + 会话搜索 + 列表与会话右键菜单）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移；
// sessions 为重赋值 let 且模块内只读（经 getSessions()），stickBottom 经 setStickBottom 写。
// 列表分组状态与搜索状态为域私有，随域迁入本模块。
import {iconSvg} from '../core/icons.js';
import {aiTextOf, aiFormatSessionTime} from './ai-constants.js';

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
    const currentSession = ctx.currentSession;
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
    const getSessions = ctx.getSessions;
    const setStickBottom = ctx.setStickBottom;

    // —— 随域迁入的列表状态（原 ai-panel.js 闭包级）；会话搜索框已删（并入全局搜索的「AI 会话」分类）——
    let archivedExpanded = false;
    const collapsedWorkspaceGroups = new Set();
    // 每个工作区分组一次只渲染最近 AI_SESSION_GROUP_PAGE 条会话，点分组底部的「···」再追加一页。
    // key = 列表类型 + 工作区 key，进行中与已归档互不影响；只是渲染层的展开状态，不动会话数据。
    const AI_SESSION_GROUP_PAGE = 10;
    const workspaceGroupVisibleCounts = new Map();
    // 会话条目右侧状态图标的悬浮提示
    const SESSION_STATUS_TITLE = {
        running: '会话运行中',
        pending: '待确认：需要你审批或回答',
        done: '会话已完成，尚未查看',
        error: '会话出错，尚未查看',
    };

    // 配置切换走「模型列表」卡片；旧的 <select id="ai-opt-profile"> 已从 HTML 移除
    function renderProfileSelect() {
        renderModelChip();
    }

    function sessionActivity(session) {
        const last = session.messages[session.messages.length - 1];
        return Number(last && last.ts) || Number(session.updatedAt) || Number(session.createdAt) || 0;
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
        for (const message of session.messages || []) {
            if (!message) continue;
            if (message.approval && message.approval.state === 'pending') return true;
            if (message.ask && message.ask.state === 'pending') return true;
            if (message.envAsk && message.envAsk.state === 'pending') return true;
        }
        // 计划模式：最后一条是待批准的计划（用户还没批准 / 放弃）
        if (session.planMode && session.messages.length) {
            const last = session.messages[session.messages.length - 1];
            if (last && last.role === 'assistant' && last.planMode && last.status === 'done' && String(last.content || '').trim()) {
                return true;
            }
        }
        return false;
    }

    function sessionEntryStatus(session, archived) {
        if (!session || archived || session.archivedAt) return '';
        if (sessionNeedsAttention(session)) return 'pending';
        if (streams.has(session.id)) return 'running';
        // 后台命令可能比本轮活得更久：即使没有流，作业还在跑也要在列表上标出来
        if (sessionHasLiveBgJob(session.id)) return 'running';
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
        updateHeadHud();
        if (!sessionListEl) return;
        const scrollTop = sessionListEl.scrollTop;
        sessionListEl.innerHTML = '';
        const current = currentSession();
        const ordered = getSessions().slice().sort((a, b) => sessionActivity(b) - sessionActivity(a));
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

        const renderItem = (session, archived) => {
            const item = document.createElement('div');
            item.className = 'ai-session-item' + (current && current.id === session.id ? ' active' : '') + (archived ? ' archived' : '');
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
                pin.title = '已置顶';
                titleRow.appendChild(pin);
            }
            const title = document.createElement('div');
            title.className = 'ai-session-title';
            title.textContent = session.title || '新会话';
            title.title = session.title || '新会话';
            titleRow.appendChild(title);
            const meta = document.createElement('div');
            meta.className = 'ai-session-meta';
            meta.textContent = (archived ? '已归档 · ' : '') + session.messages.length + ' 条消息 · ' + aiFormatSessionTime(sessionActivity(session));
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
                badge.title = SESSION_STATUS_TITLE[statusKind] || '';
                badge.setAttribute('role', 'img');
                badge.setAttribute('aria-label', badge.title);
                side.appendChild(badge);
            }
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'ai-session-more';
            more.title = '会话操作';
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
            for (const group of groups) {
                if (showHeaders) {
                    const collapsed = collapsible && collapsedWorkspaceGroups.has(group.key);
                    // 用 div 承载：头部内含两个真实 button，避免 button 嵌套 button 的非法结构。
                    const head = document.createElement('div');
                    head.className = 'ai-session-group-head' + (group.current ? ' current' : '') + (collapsed ? '' : ' expanded');
                    head.title = group.path || '未关联工作区';
                    if (collapsible) {
                        head.tabIndex = 0;
                        head.setAttribute('role', 'button');
                        head.setAttribute('aria-expanded', String(!collapsed));
                    }
                    const chev = document.createElement('span');
                    chev.className = 'ai-session-group-chev';
                    chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
                    add.title = '新建会话';
                    add.setAttribute('aria-label', '新建会话');
                    add.innerHTML = iconSvg('plus', 12);
                    add.addEventListener('click', (e) => {
                        e.stopPropagation();
                        collapsedWorkspaceGroups.delete(group.key);
                        ensureOpen();
                        newSessionInWorkspace(group);
                        renderSessionList();
                    });
                    const menu = document.createElement('button');
                    menu.type = 'button';
                    menu.className = 'ai-session-group-action';
                    menu.title = '会话操作';
                    menu.setAttribute('aria-label', '会话操作');
                    menu.innerHTML = iconSvg('more', 12);
                    menu.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const rect = menu.getBoundingClientRect();
                        showSessionListMenu(rect.left, rect.bottom + 4);
                    });
                    actions.append(add, menu);
                    head.append(chev, icon, name, actions);
                    if (collapsible) {
                        const toggle = () => {
                            if (collapsedWorkspaceGroups.has(group.key)) collapsedWorkspaceGroups.delete(group.key);
                            else collapsedWorkspaceGroups.add(group.key);
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
                    more.title = '还有 ' + remaining + ' 条会话，点击再显示 ' + Math.min(AI_SESSION_GROUP_PAGE, remaining) + ' 条';
                    more.setAttribute('aria-label', more.title);
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
            chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
        showContextMenu([
            {label: '新建会话', action: () => { ensureOpen(); newSession(); }},
            {sep: true},
            {label: session.pinned ? '取消置顶' : '置顶会话', disabled: !!session.archivedAt, action: () => toggleSessionPin(session)},
            {label: '重命名会话…', action: () => renameSession(session)},
            {label: '导出会话…', action: () => exportSession(session)},
            {label: '会话数据诊断…', action: () => showSessionDiagnostics(session)},
            {label: session.archivedAt ? '取消归档' : '归档会话', action: () => archiveSession(session, !session.archivedAt)},
            {sep: true},
            {label: '删除会话', danger: true, action: () => deleteSession(session)},
        ], x, y);
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
    return {
        renderProfileSelect,
        sessionActivity,
        setSessionUnread,
        renderSessionList,
        showSessionMenu,
        showSessionListMenu,
        clearSessionUnread,
    };
}
