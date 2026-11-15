// ai-todos 默认收起态护栏：任务清单默认折叠（设置 aiTodosDefaultExpanded 可改为默认展开），
// 切换设置后既有会话的收起态立即跟随。渲染部分依赖 DOM，这里只测状态层。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAITodos, todosDefaultCollapsed} from './ai-todos.js';

function makeMod(settings, todoStates) {
    return createAITodos({
        todoStates,
        // el 不提供 todos：renderTodos 直接返回，状态层测试不需要 DOM
        el: {},
        currentSession: () => null,
        positionOverlays: () => {},
        settings,
    });
}

test('默认收起：未设置时新建会话状态 collapsed 为 true', () => {
    assert.equal(todosDefaultCollapsed({}), true);
    assert.equal(todosDefaultCollapsed(undefined), true);
    const states = new Map();
    const mod = makeMod({}, states);
    assert.equal(mod.todoStateOf({id: 's1'}).collapsed, true);
});

test('设置为默认展开时新建状态 collapsed 为 false', () => {
    assert.equal(todosDefaultCollapsed({aiTodosDefaultExpanded: true}), false);
    const mod = makeMod({aiTodosDefaultExpanded: true}, new Map());
    assert.equal(mod.todoStateOf({id: 's1'}).collapsed, false);
});

test('切换默认展开后既有会话状态立即跟随并清掉自动收起计时', () => {
    const settings = {};
    const states = new Map();
    const mod = makeMod(settings, states);
    const state = mod.todoStateOf({id: 's1'});
    assert.equal(state.collapsed, true);
    // 模拟「全部完成 3 秒后自动收起」挂着的计时器
    state.timer = setTimeout(() => {}, 60_000);
    state.doneCollapsed = true;

    settings.aiTodosDefaultExpanded = true;
    mod.applyDefaultCollapse();
    assert.equal(state.collapsed, false);
    assert.equal(state.timer, 0);
    assert.equal(state.doneCollapsed, false);

    settings.aiTodosDefaultExpanded = false;
    mod.applyDefaultCollapse();
    assert.equal(state.collapsed, true);
});
