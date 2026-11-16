// 文件树差量刷新的回归护栏。
//
// 2026-11-15：AI 每次 write_file / edit_file 成功后都会走
// editor-groups.js 的 handleAIWorkspaceFileChanged，而它当时无条件调
// explorer.refresh()（= 点击【刷新】按钮的同一函数）：tree=null 整树重建 →
// 「加载中…」→ 逐级 loadNode 多次 renderTree → revealActive 抢滚动位置。
// 连续编辑就是整棵文件树一直在闪。现改为 explorer.notifyFileChange()，
// 复用文件监听的 externalDirs + 120ms 防抖 + mergeChildren 差量管线。
//
// 这条链路能成立的唯一基石是：mergeChildren 对「仅 mtime / size 变化」
// 返回 false —— 编辑已有文件不触发任何 renderTree。下面把它锁死。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mergeChildren, createExplorer} from '../../src/explorer/explorer.js';

const here = dirname(fileURLToPath(import.meta.url));

function entry(name, {mtime = 1000, size = 100, isDir = false} = {}) {
    return {name, path: '/ws/' + name, isDir, mtime, size};
}

function makeDir(children = []) {
    return {
        name: 'ws', path: '/ws', isDir: true, root: true,
        expanded: true, loaded: true, loading: false, error: '',
        truncated: false, dirMtime: 1000,
        children: children.map((e) => ({
            name: e.name, path: e.path, isDir: e.isDir,
            root: false, expanded: false, loaded: !e.isDir,
            loading: false, error: '', truncated: false,
            mtime: e.mtime, size: e.size, dirMtime: 0,
            children: [], loadPromise: null, refreshing: false,
        })),
    };
}

test('mergeChildren：首次合并视为结构变化，并按「目录优先 + 名称」排序', () => {
    const dir = makeDir();
    const entries = [entry('b.txt'), entry('a.txt'), entry('sub', {isDir: true})];
    assert.equal(mergeChildren(dir, entries, false, 2000), true);
    assert.deepEqual(dir.children.map((c) => c.name), ['sub', 'a.txt', 'b.txt']);
    assert.equal(dir.dirMtime, 2000);
});

test('mergeChildren：仅内容修改（mtime / size 变化）不算变更，且复用原节点对象', () => {
    const dir = makeDir([entry('a.txt'), entry('b.txt')]);
    const before = [...dir.children];
    const entries = [
        entry('a.txt', {mtime: 9999, size: 9999}),
        entry('b.txt', {mtime: 8888, size: 8888}),
    ];
    // 核心护栏：AI 连续编辑已有文件 → 返回 false → 不 renderTree → 零闪烁
    assert.equal(mergeChildren(dir, entries, false, 3000), false);
    assert.equal(dir.children[0], before[0], '节点对象必须复用，否则展开态/loaded 会丢');
    assert.equal(dir.children[1], before[1]);
    assert.equal(dir.children[0].mtime, 9999, '指纹仍要更新，供后续 mtime 快速判断');
    assert.equal(dir.children[0].size, 9999);
});

test('mergeChildren：完全相同的快照不产生变更', () => {
    const dir = makeDir([entry('a.txt')]);
    assert.equal(mergeChildren(dir, [entry('a.txt')], false, 1000), false);
});

test('mergeChildren：新增 / 删除 / 改名 / 顺序变化才算结构变化', () => {
    const base = [entry('a.txt'), entry('b.txt')];
    const added = makeDir(base);
    assert.equal(mergeChildren(added, [...base, entry('c.txt')], false, 1000), true, '新增文件');

    const removed = makeDir(base);
    assert.equal(mergeChildren(removed, [entry('a.txt')], false, 1000), true, '删除文件');

    const renamed = makeDir(base);
    assert.equal(mergeChildren(renamed, [{...entry('a.txt'), name: 'A.txt'}, entry('b.txt')], false, 1000), true, '改名');

    const flipped = makeDir(base);
    assert.equal(mergeChildren(flipped, [{...entry('a.txt'), isDir: true}, entry('b.txt')], false, 1000), true, '文件变目录');
});

test('mergeChildren：truncated / error / 空目录收起也算结构变化', () => {
    const truncated = makeDir([entry('a.txt')]);
    assert.equal(mergeChildren(truncated, [entry('a.txt')], true, 1000), true);

    const errored = makeDir([entry('a.txt')]);
    errored.error = '读取失败';
    assert.equal(mergeChildren(errored, [entry('a.txt')], false, 1000), true);
    assert.equal(errored.error, '', '成功合并要清掉旧错误');

    const emptied = makeDir([entry('a.txt')]);
    emptied.expanded = true;
    assert.equal(mergeChildren(emptied, [], false, 1000), true, '清空后展开态失效需重绘');
    assert.equal(emptied.expanded, false);
});

// 接线护栏：AI 写盘回调必须走轻量差量通知，绝不能回退到 refresh()；
// explorer 必须暴露 notifyFileChange 并接到防抖刷新管线上。
function fnBody(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const end = src.indexOf('\n}', start);
    assert.ok(end > start, '函数体截取失败：' + signature);
    return src.slice(start, end);
}

test('接线护栏：AI 写盘 / 补丁应用都走 notifyFileChange，不再整树 refresh', () => {
    const editorGroups = readFileSync(join(here, '..', '..', 'src', 'editor', 'editor-groups.js'), 'utf8');
    const explorer = readFileSync(join(here, '..', '..', 'src', 'explorer', 'explorer.js'), 'utf8');
    const main = readFileSync(join(here, '..', '..', 'src', 'main.js'), 'utf8');

    // 全量刷新调用（refresh(...)）不能出现在这些函数里；
    // scheduleExternalRefresh 的大写 R 不会命中，防抖本身是允许的。
    const noFullRefresh = (src, label) => assert.ok(!/(?:^|[^A-Za-z])refresh\s*\(/.test(src),
        label + ' 仍在做整树全量刷新（会闪）');

    const aiFn = fnBody(editorGroups, 'async function handleAIWorkspaceFileChanged(path) {');
    assert.ok(aiFn.includes('notifyFileChange(path)'), 'AI 写盘回调未接 notifyFileChange');
    noFullRefresh(aiFn, 'AI 写盘回调');

    const patchFn = fnBody(editorGroups, 'async function reloadAfterPatch(files) {');
    assert.ok(patchFn.includes('notifyFileChange(patchAbsPath(rel))'), '补丁应用未接 notifyFileChange');
    noFullRefresh(patchFn, '补丁应用');

    assert.ok(main.includes('onFileChanged: (path) => handleAIWorkspaceFileChanged(path)'),
        'main.js 的 onFileChanged 接线断了');

    const notifyFn = fnBody(explorer, 'function notifyFileChange(path) {');
    assert.ok(notifyFn.includes('externalDirs.add(parentPath(full))'), 'notifyFileChange 未把父目录标脏');
    assert.ok(notifyFn.includes('scheduleExternalRefresh()'), 'notifyFileChange 未接 120ms 防抖');
    assert.ok(!/(?:^|[^A-Za-z])refresh\s*\(/.test(notifyFn),
        'notifyFileChange 不能调全量 refresh（scheduleExternalRefresh 是防抖，不算）');

    const returned = explorer.slice(explorer.indexOf('    return {'), explorer.lastIndexOf('};'));
    assert.ok(returned.includes('notifyFileChange,'), 'createExplorer 未暴露 notifyFileChange');
});

// ---- 最小 DOM 桩：真正跑一遍 createExplorer 的差量刷新链路 ----
function makeEl(tag = 'div') {
    const children = [];
    const node = {
        tagName: String(tag).toUpperCase(),
        className: '', dataset: {}, innerHTML: '', title: '',
        disabled: false, tabIndex: -1, draggable: false,
        scrollTop: 0, clearCount: 0, children,
        classList: {add() {}, remove() {}, toggle() {}, contains() { return false; }},
        append(...items) { for (const item of items) this.appendChild(item); },
        appendChild(item) {
            if (item && item.tagName === 'FRAGMENT' && Array.isArray(item.children)) {
                children.push(...item.children);
                return item;
            }
            children.push(item);
            return item;
        },
        insertBefore() {}, addEventListener() {}, setAttribute() {},
        focus() {}, scrollIntoView() {}, remove() {},
        contains() { return false; }, closest() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
    };
    let text = '';
    Object.defineProperty(node, 'textContent', {
        get() { return text; },
        set(v) {
            text = String(v);
            // renderTree 的 body.textContent = '' 是整树重建的标志
            if (!v) { children.length = 0; node.clearCount++; }
        },
    });
    return node;
}

function installDom() {
    globalThis.document = {
        createElement: (tag) => makeEl(tag),
        createDocumentFragment: () => makeEl('fragment'),
        addEventListener() {},
    };
    globalThis.window = {addEventListener() {}};
    // scrollToActive 的 rAF 不执行，避免与本测试无关的异步干扰
    globalThis.requestAnimationFrame = () => 1;
}

test('notifyFileChange：连续编辑已有文件零重建，新建文件才重绘一次', async () => {
    installDom();
    const body = makeEl();
    const file = (name, mtime, size) => ({name, path: '/ws/' + name, isDir: false, mtime, size});
    let entries = [file('a.txt', 1, 10)];
    const readDir = async () => ({entries, truncated: false, mtime: 100});
    const api = createExplorer({body, readDir, dirMtime: async () => 100});
    api.setRoot('/ws');
    api.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const baseline = body.clearCount;
    assert.ok(baseline > 0, '初始化应至少渲染一次文件树（桩未跑通）');

    // 模拟连续两次 AI 编辑同一个已有文件：只有 mtime / size 变化
    entries = [file('a.txt', 2, 20)];
    api.notifyFileChange('/ws/a.txt');
    entries = [file('a.txt', 3, 30)];
    api.notifyFileChange('/ws/a.txt');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(body.clearCount, baseline,
        '编辑已有文件不得重建整棵树——这正是「跟点刷新一样一直闪」的根源');

    // 新建文件属于真实结构变化：允许且只需要重绘一次
    entries = [file('a.txt', 3, 30), file('b.txt', 1, 5)];
    api.notifyFileChange('/ws/b.txt');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(body.clearCount, baseline + 1, '新建文件应恰好重绘一次');
});
