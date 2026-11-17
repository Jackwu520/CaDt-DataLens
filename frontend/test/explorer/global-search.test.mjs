// global-search.js 的搜索范围回归测试。
//
// 2026-11-14 分类拆分时 openGlobalSearch 误写成 `const root = globalSearch.root`
// （自赋值，字段初始为 ''），导致：面板顶部范围为空、runGlobalSearch 恒不调用
// SearchWorkspace、默认又没勾 AI 会话 → 全局搜索永远「0 个结果」。
// 这里用最小 DOM 桩锁住「打开时重新解析根目录」和实际发起后端搜索。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGlobalSearch} from '../../src/explorer/global-search.js';

function makeEl(tag = 'div') {
    const children = [];
    const handlers = new Map();
    const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        id: '',
        title: '',
        value: '',
        checked: false,
        disabled: false,
        innerHTML: '',
        dataset: {},
        children,
        classList: {
            add() {},
            remove() {},
            toggle() {},
            contains() { return false; },
        },
        setAttribute() {},
        scrollIntoView() {},
        focus() {},
        select() {},
        addEventListener(type, fn) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(fn);
        },
        fire(type, event = {}) {
            for (const fn of handlers.get(type) || []) fn(event);
        },
        append(...items) {
            for (const item of items) this.appendChild(item);
        },
        appendChild(item) {
            // 真实 DOM 插入 fragment 时会把子节点平铺进宿主，这里照做
            if (item && item.tagName === 'FRAGMENT' && Array.isArray(item.children)) {
                for (const child of item.children) children.push(child);
                return item;
            }
            children.push(item);
            return item;
        },
        insertBefore() {},
        // 让 ensureAISearchControls 早退：控件行注入不是本文件要测的部分
        closest() { return null; },
        parentElement: null,
        querySelectorAll(selector) {
            if (selector === '.gs-row') return children.filter((c) => c.className === 'gs-row');
            return [];
        },
    };
    let text = '';
    Object.defineProperty(el, 'textContent', {
        get() { return text; },
        set(v) {
            text = String(v);
            if (!v) children.length = 0;
        },
    });
    return el;
}

function installDom() {
    globalThis.document = {
        createElement: (tag) => makeEl(tag),
        createDocumentFragment: () => makeEl('fragment'),
        createTextNode: (value) => ({textContent: String(value)}),
        getElementById: () => null,
        head: makeEl('head'),
        activeElement: null,
    };
}

function setup({workspaceFolder = null, file = null, hits = [], fuzzyHits = [], controls = false} = {}) {
    installDom();
    const els = {
        gsInput: makeEl('input'),
        gsRoot: makeEl('span'),
        gsCount: makeEl('span'),
        gsList: makeEl('div'),
        gsMask: makeEl('div'),
    };
    // controls=true 时补出 #gs-panel 链，让 ensureAISearchControls 真正注入范围控件行
    const panel = makeEl('div');
    if (controls) {
        const row = makeEl('div');
        row.parentElement = panel;
        els.gsInput.parentElement = row;
        els.gsInput.closest = (sel) => (sel === '#gs-panel' ? panel : null);
        panel.insertBefore = (node) => { panel.controlsRow = node; };
    }
    const calls = {workspace: [], fuzzy: [], sessions: []};
    const backend = {
        async SearchWorkspace(...args) {
            calls.workspace.push(args);
            return {hits, truncated: false};
        },
        async SearchWorkspaceFuzzy(...args) {
            calls.fuzzy.push(args);
            return {hits: fuzzyHits, truncated: false};
        },
        async AISessionSearchScoped(...args) {
            calls.sessions.push(args);
            return {hits: [], truncated: false};
        },
    };
    const state = {workspaceFolder, file};
    const deps = {
        get els() { return els; },
        get backend() { return backend; },
        get workspaceFolder() { return state.workspaceFolder; },
        get file() { return state.file; },
        get flash() { return () => {}; },
        get focusFindEditor() { return () => {}; },
        get openPaths() { return async () => {}; },
        get findDocByPath() { return () => null; },
        get activateDoc() { return async () => {}; },
        get openAISessionHit() { return async () => {}; },
        get currentMode() { return 'code'; },
        get switchMode() { return () => {}; },
        get waitUntil() { return async () => true; },
    };
    return {els, panel, calls, state, deps};
}

function findById(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
        const hit = findById(child, id);
        if (hit) return hit;
    }
    return null;
}

async function waitFor(condition, timeout = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待搜索结果超时');
}

test('打开面板时搜索范围显示当前工作区目录', () => {
    const {els, deps} = setup({workspaceFolder: 'D:\\ws\\demo'});
    const {openGlobalSearch} = createGlobalSearch(deps);
    openGlobalSearch();
    assert.equal(els.gsRoot.textContent, 'D:\\ws\\demo');
});

test('输入查询后按工作区根目录调用 SearchWorkspace 并渲染命中', async () => {
    const hit = {
        path: 'D:\\ws\\demo\\a.txt',
        name: 'a.txt',
        dir: 'demo',
        line: 3,
        column: 5,
        length: 6,
        preview: 'before needle after',
        matchStart: 7,
        matchEnd: 13,
    };
    const {els, calls, deps} = setup({workspaceFolder: 'D:\\ws\\demo', hits: [hit]});
    const {openGlobalSearch} = createGlobalSearch(deps);
    openGlobalSearch();
    els.gsInput.value = 'needle';
    els.gsInput.fire('input');
    await waitFor(() => els.gsCount.textContent === '1 个文件结果');
    assert.equal(calls.workspace.length, 1);
    assert.deepEqual(calls.workspace[0], ['D:\\ws\\demo', 'needle', false, 400]);
    assert.equal(els.gsList.querySelectorAll('.gs-row').length, 1);
});

test('未打开工作区时回退到单文件父目录；切换工作区后重新打开会刷新范围', () => {
    const {els, state, deps} = setup({file: {path: 'D:\\ws\\demo\\a.txt'}});
    const gs = createGlobalSearch(deps);
    gs.openGlobalSearch();
    assert.equal(els.gsRoot.textContent, 'D:/ws/demo');
    // 关闭面板 → 打开另一个工作区 → 再打开面板，范围不能是上一次的旧值
    els.gsMask.fire('mousedown', {target: els.gsMask});
    state.workspaceFolder = 'D:\\other\\project';
    gs.openGlobalSearch();
    assert.equal(els.gsRoot.textContent, 'D:\\other\\project');
});

test('aiOnly 打开时只搜会话，不发起工作区文件搜索', async () => {
    const {els, calls, deps} = setup({workspaceFolder: 'D:\\ws\\demo'});
    const {openGlobalSearch} = createGlobalSearch(deps);
    openGlobalSearch({aiOnly: true});
    els.gsInput.value = 'needle';
    els.gsInput.fire('input');
    await waitFor(() => calls.sessions.length === 1);
    assert.equal(calls.workspace.length, 0);
    assert.equal(calls.sessions[0][0], 'needle');
    assert.equal(els.gsCount.textContent, '0 个结果');
});

test('勾选「模糊」后改走 SearchWorkspaceFuzzy；取消工作区文件时模糊框禁用', async () => {
    const {els, panel, calls, deps} = setup({workspaceFolder: 'D:\\ws\\demo', controls: true});
    const {openGlobalSearch} = createGlobalSearch(deps);
    openGlobalSearch();
    const row = panel.controlsRow;
    assert.ok(row, '搜索范围控件行应已注入');
    const filesBox = findById(row, 'gs-files-enabled');
    const fuzzyBox = findById(row, 'gs-fuzzy-enabled');
    assert.ok(filesBox && fuzzyBox, '应有工作区文件与模糊两个勾选框');
    // 默认关闭、工作区文件勾选时可用
    assert.equal(fuzzyBox.checked, false);
    assert.equal(fuzzyBox.disabled, false);
    fuzzyBox.checked = true;
    fuzzyBox.fire('change');
    els.gsInput.value = 'gsrch';
    els.gsInput.fire('input');
    await waitFor(() => calls.fuzzy.length === 1);
    assert.equal(calls.workspace.length, 0, '模糊模式下不应走字面搜索');
    assert.deepEqual(calls.fuzzy[0], ['D:\\ws\\demo', 'gsrch', false, 400]);
    // 取消「工作区文件」：模糊框禁用，也不再发起工作区搜索
    filesBox.checked = false;
    filesBox.fire('change');
    assert.equal(fuzzyBox.disabled, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls.fuzzy.length, 1);
    assert.equal(calls.workspace.length, 0);
});
