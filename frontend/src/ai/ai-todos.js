// ai-todos.js：AI 面板 Todolist UI（折叠头 + 任务行 + 全部完成 3 秒自动收起）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// todoStates（const Map，引用稳定）与 DOM 表/回调经 ctx 注入。

// 新建会话状态时的默认收起态：默认收起（只看一行进度摘要），
// 设置页「任务清单默认展开」打开后为展开。纯函数便于单测。
export function todosDefaultCollapsed(settings) {
    return !(settings && settings.aiTodosDefaultExpanded === true);
}

export function createAITodos(ctx) {
    const todoStates = ctx.todoStates;
    const el = ctx.el;
    const currentSession = ctx.currentSession;
    const positionOverlays = ctx.positionOverlays;
    // settings 对象引用（不进解构）：切设置开关后新会话状态立即按新默认生成
    const settings = ctx.settings || {};

    // 收起态「进行中任务」小字开关：存 localStorage（默认开），不进设置页。
    const TODO_CURRENT_BADGE_KEY = 'datalens-ai-todos-current-badge';

    function currentBadgeEnabled() {
        try {
            return localStorage.getItem(TODO_CURRENT_BADGE_KEY) !== '0';
        } catch (e) {
            return true;
        }
    }

    function setCurrentBadgeEnabled(on) {
        try {
            localStorage.setItem(TODO_CURRENT_BADGE_KEY, on ? '1' : '0');
        } catch (e) {}
    }

    function todoStateOf(session) {
        let state = todoStates.get(session.id);
        if (!state) {
            state = {collapsed: todosDefaultCollapsed(settings), doneCollapsed: false, timer: 0};
            todoStates.set(session.id, state);
        }
        return state;
    }

    // 设置页切换「任务清单默认展开」后立即生效：既有会话的收起态一起按新默认重置，
    // 否则要等下次新建会话才看到变化（用户会以为开关没反应）。
    function applyDefaultCollapse() {
        const collapsed = todosDefaultCollapsed(settings);
        for (const state of todoStates.values()) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = 0;
            }
            state.collapsed = collapsed;
            state.doneCollapsed = false;
        }
        renderTodos();
    }

    function renderTodos() {
        if (!el.todos) return;
        const session = currentSession();
        const list = session && Array.isArray(session.todos) ? session.todos : [];
        if (!session || !list.length) {
            el.todos.classList.add('hidden');
            el.todos.innerHTML = '';
            positionOverlays();
            return;
        }
        el.todos.classList.remove('hidden');
        const state = todoStateOf(session);
        const done = list.filter((todo) => todo.status === 'completed').length;
        const doing = list.filter((todo) => todo.status === 'in_progress').length;
        const todo = list.length - done - doing;
        const allDone = done === list.length;
        if (!allDone) state.doneCollapsed = false;
        el.todos.innerHTML = '';
        el.todos.classList.toggle('collapsed', state.collapsed);
        el.todos.classList.toggle('alldone', allDone);
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ai-todos-head';
        const ico = document.createElement('span');
        ico.className = 'ai-todos-ico';
        ico.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="4.6" r="1.25" fill="currentColor"/><rect x="6" y="3.8" width="8" height="1.6" rx="0.8" fill="currentColor"/><circle cx="3" cy="11.4" r="1.25" fill="currentColor"/><rect x="6" y="10.6" width="8" height="1.6" rx="0.8" fill="currentColor"/></svg>';
        const label = document.createElement('span');
        label.className = 'ai-todos-label';
        label.textContent = '任务';
        const sum = document.createElement('span');
        sum.className = 'ai-todos-sum';
        sum.textContent = allDone
            ? '已全部完成 · ' + done + ' 项'
            : [
                done ? done + ' 已完成' : '',
                doing ? doing + ' 进行中' : '',
                todo ? todo + ' 待处理' : '',
            ].filter(Boolean).join(' · ') || (list.length + ' 项');
        const chev = document.createElement('span');
        chev.className = 'ai-todos-chev';
        chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        head.append(ico, label, sum);
        // 收起态：在展开 icon 左侧用小字显示进行中的任务标题（过长由 CSS 截断）。
        // 头部本身是 button，开关只能用 span role=button 承载，避免 button 嵌套。
        const badgeOn = currentBadgeEnabled();
        const currentTodo = list.find((todo) => todo.status === 'in_progress');
        if (state.collapsed && currentTodo && badgeOn) {
            const cur = document.createElement('span');
            cur.className = 'ai-todos-current';
            cur.textContent = currentTodo.content;
            cur.dataset.tip = '进行中：' + currentTodo.content;
            head.appendChild(cur);
        }
        const curToggle = document.createElement('span');
        curToggle.className = 'ai-todos-cur-toggle' + (badgeOn ? '' : ' off');
        curToggle.setAttribute('role', 'button');
        curToggle.setAttribute('aria-label', '收起时显示进行中的任务');
        curToggle.dataset.tip = '收起时显示进行中的任务（' + (badgeOn ? '已开启，点击关闭' : '已关闭，点击开启') + '）';
        curToggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.1 8c1.5-2.6 3.5-3.9 5.9-3.9s4.4 1.3 5.9 3.9c-1.5 2.6-3.5 3.9-5.9 3.9S3.6 10.6 2.1 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
        curToggle.addEventListener('click', (e) => {
            // 不触发头部的折叠/展开
            e.stopPropagation();
            setCurrentBadgeEnabled(!currentBadgeEnabled());
            renderTodos();
        });
        head.appendChild(curToggle);
        head.appendChild(chev);
        head.dataset.tip = state.collapsed ? '展开任务清单' : '收起任务清单';
        head.addEventListener('click', () => {
            state.collapsed = !state.collapsed;
            if (state.collapsed && state.timer) {
                clearTimeout(state.timer);
                state.timer = 0;
            }
            renderTodos();
        });
        el.todos.appendChild(head);
        if (!state.collapsed) {
            const body = document.createElement('div');
            body.className = 'ai-todos-body';
            for (const item of list) {
                const row = document.createElement('div');
                row.className = 'ai-todo-item ' + item.status;
                const dot = document.createElement('span');
                dot.className = 'ai-todo-dot';
                const text = document.createElement('span');
                text.className = 'ai-todo-text';
                text.textContent = item.content;
                row.append(dot, text);
                body.appendChild(row);
            }
            el.todos.appendChild(body);
        }
        if (allDone && !state.collapsed && !state.timer && !state.doneCollapsed) {
            state.timer = setTimeout(() => {
                state.timer = 0;
                if (currentSession() && currentSession().id === session.id) {
                    state.collapsed = true;
                    state.doneCollapsed = true;
                    renderTodos();
                }
            }, 3000);
        }
        // 渲染完成后刷新悬浮层位置：回到底部按钮等以 todos 当前高度为基准。
        positionOverlays();
    }
    return {todoStateOf, renderTodos, applyDefaultCollapse};
}
