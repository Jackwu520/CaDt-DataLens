// ai-todos.js：AI 面板 Todolist UI（折叠头 + 任务行 + 全部完成 3 秒自动收起）。
// 从 ai-panel.js 拆出（docs/unfinished-plans/structure-cleanup.md 阶段 3），函数体逐字搬移。
// todoStates（const Map，引用稳定）与 DOM 表/回调经 ctx 注入。

export function createAITodos(ctx) {
    const todoStates = ctx.todoStates;
    const el = ctx.el;
    const currentSession = ctx.currentSession;
    const positionOverlays = ctx.positionOverlays;

    function todoStateOf(session) {
        let state = todoStates.get(session.id);
        if (!state) {
            state = {collapsed: false, doneCollapsed: false, timer: 0};
            todoStates.set(session.id, state);
        }
        return state;
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
        head.append(ico, label, sum, chev);
        head.title = state.collapsed ? '展开任务清单' : '收起任务清单';
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
    return {todoStateOf, renderTodos};
}
