// memo-store 自动保存语义护栏：mutate → 防抖落盘、flush 立即落盘、CAS 冲突重载不覆盖、
// 切工作区先按旧根落盘再清缓存（不丢字）、flushAll 全量冲盘、保存失败保持 dirty 并提示。
// 视图与 AI 动作都经这套 store，任何一条被改坏都是丢用户数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoStore} from '../../src/bridge/memo-store.js';
import {addBlock, addItem, attachImage, removeById, removeImageById, updateById} from '../../src/bridge/memo-model.js';

const SAVE_DEBOUNCE_MS = 1100; // store 里 1000ms + 余量

// makeBackend：内存版 Go 引擎——mtime CAS 等值比较，文件按「作用域|工作区」键存放。
function makeBackend() {
    const files = new Map();
    let seq = 1;
    const calls = {save: [], load: []};
    const deleteCalls = [];
    const keyOf = (scope, ws) => scope + '|' + (ws || '');
    return {
        files, calls, keyOf, deleteCalls,
        async MemoLoad(scope, workspace) {
            calls.load.push({scope, workspace});
            const cur = files.get(keyOf(scope, workspace));
            const data = cur ? cur.data : '{"version":1,"updatedAt":0,"blocks":[]}';
            return JSON.stringify({data, mtimeMs: cur ? cur.mtimeMs : 0});
        },
        async MemoSave(scope, workspace, doc, baseMtimeMs) {
            calls.save.push({scope, workspace, baseMtimeMs});
            const key = keyOf(scope, workspace);
            const cur = files.get(key);
            if (baseMtimeMs > 0 && (!cur || cur.mtimeMs !== baseMtimeMs)) {
                return {ok: false, conflict: true, error: 'conflict: 快捷便签已在其他窗口修改'};
            }
            if (baseMtimeMs === 0 && cur && cur.mtimeMs > 0) {
                return {ok: false, conflict: true, error: 'conflict: 快捷便签已在其他窗口创建'};
            }
            const mtimeMs = seq++ * 1000;
            files.set(key, {data: doc, mtimeMs});
            return {ok: true, mtimeMs};
        },
        async MemoSaveImage() { return 'img/img-test.png'; },
        async DeleteEntry(path) { deleteCalls.push(path); },
    };
}

function makeStore(backend, hooks = {}) {
    return createMemoStore({
        backend,
        flash: hooks.flash || (() => {}),
        workspaceRoot: hooks.workspaceRoot || (() => '/ws/a'),
        onPendingChange: hooks.onPendingChange || (() => {}),
        // 贴图 GC 定位：mock 根 = <workspace|/appdata>/memo-root
        resolveRoot: hooks.resolveRoot || (async (scope, ws) => (ws || '/appdata') + '/memo-root'),
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('mutate → 防抖窗口内 pending=true，到期自动落盘', async () => {
    const backend = makeBackend();
    const pendingFlips = [];
    const store = makeStore(backend, {onPendingChange: () => pendingFlips.push(store.hasPending())});

    const res = await store.mutate('workspace', (doc) => addItem(doc, '', '第一条'));
    assert.ok(res.ok);
    assert.equal(store.hasPending(), true, 'mutate 后应立即视为 pending');
    assert.equal(backend.calls.save.length, 0, '防抖窗口内不应写盘');
    assert.ok(pendingFlips.includes(true), 'pending 翻转应通知（关窗脏标记）');

    await sleep(SAVE_DEBOUNCE_MS);
    assert.equal(backend.calls.save.length, 1, '防抖到期应自动保存');
    assert.equal(store.hasPending(), false);
    assert.ok(backend.files.get(backend.keyOf('workspace', '/ws/a')).data.includes('第一条'));
});

test('flush 立即落盘，不用等防抖', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    await store.mutate('workspace', (doc) => addItem(doc, '', '马上存'));
    const res = await store.flush('workspace');
    assert.ok(res.ok);
    assert.equal(backend.calls.save.length, 1);
    assert.equal(store.hasPending(), false);
});

test('CAS 冲突：重载磁盘版本并广播，不覆盖别人的修改', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    const seen = [];
    store.onChange((scope) => seen.push(scope));

    await store.mutate('workspace', (doc) => addItem(doc, '', '我的改动'));
    // 模拟另一个窗口先写了：直接改后端文件（store 的缓存 mtime 已过期）
    const key = backend.keyOf('workspace', '/ws/a');
    backend.files.set(key, {data: '{"version":1,"updatedAt":9,"blocks":[{"id":"blk-x","title":"别人的","items":[]}]}', mtimeMs: 999999});

    const res = await store.flush('workspace');
    assert.equal(res.conflict, true);
    assert.deepEqual(seen, ['workspace', 'workspace'], 'mutate 与冲突重载各广播一次');
    // 缓存已换成磁盘版本
    const doc = store.cached('workspace');
    assert.equal(doc.blocks[0].title, '别人的');
    assert.equal(store.hasPending(), false);
    // 后端文件仍是别人的内容（没有被覆盖）
    assert.ok(backend.files.get(key).data.includes('别人的'));
});

test('切工作区：未落盘修改按旧工作区根落盘，不丢字', async () => {
    const backend = makeBackend();
    let root = '/ws/a';
    const store = makeStore(backend, {workspaceRoot: () => root});

    await store.mutate('workspace', (doc) => addItem(doc, '', '切走前写的'));
    root = '/ws/b'; // 组合根已切到新工作区（workspaceFolder 已重新赋值）
    await store.forgetWorkspace();

    const saves = backend.calls.save.filter((c) => c.scope === 'workspace');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].workspace, '/ws/a', '必须写到旧的捕获根，不能写到新工作区');
    assert.ok(backend.files.get(backend.keyOf('workspace', '/ws/a')).data.includes('切走前写的'));
    assert.equal(store.cached('workspace'), null, '旧工作区缓存应清掉');
    assert.equal(store.hasPending(), false);
});

test('flushAll：冲掉所有作用域挂着的修改（关窗兜底）', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    await store.mutate('workspace', (doc) => addItem(doc, '', '工作区的'));
    await store.mutate('global', (doc) => addItem(doc, '', '全局的'));
    assert.equal(store.hasPending(), true);

    await store.flushAll();
    assert.equal(store.hasPending(), false);
    assert.ok(backend.files.get(backend.keyOf('workspace', '/ws/a')).data.includes('工作区的'));
    assert.ok(backend.files.get(backend.keyOf('global', '')).data.includes('全局的'));
});

test('保存失败：保持 dirty 并 flash 提示，下次 mutate/flush 还会重试', async () => {
    const backend = makeBackend();
    const flashes = [];
    const store = makeStore(backend, {flash: (msg, isErr) => flashes.push({msg, isErr})});
    backend.MemoSave = async () => ({ok: false, error: '磁盘不可写'});

    await store.mutate('workspace', (doc) => addItem(doc, '', 'x'));
    await sleep(SAVE_DEBOUNCE_MS);
    assert.equal(store.hasPending(), true, '失败后应保持 dirty');
    assert.ok(flashes.some((f) => f.isErr && f.msg.includes('磁盘不可写')), '防抖保存失败应 flash');

    backend.MemoSave = makeBackend().MemoSave; // 恢复可写
    const res = await store.flush('workspace');
    assert.ok(res.ok);
});

test('外部变更重载：有未保存修改时跳过（不丢正要写的内容）', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    await store.mutate('workspace', (doc) => addItem(doc, '', '正要写的'));
    assert.equal(store.hasPending(), true);

    const changed = await store.reloadExternal('workspace');
    assert.equal(changed, false, 'dirty 时不重读');
    assert.equal(store.hasPending(), true);
});

test('删贴图引用 → 保存成功 → img 文件走 DeleteEntry（回收站）', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    const add = await store.mutate('workspace', (doc) => addItem(doc, '', '带图'));
    await store.mutate('workspace', (doc) => attachImage(doc, add.id, 'img/x1.png'));
    await store.flush('workspace'); // 带图状态先落盘（磁盘上才有这个文件，GC 才有可删对象）
    await store.mutate('workspace', (doc) => removeImageById(doc, add.id, 'img/x1.png'));
    assert.equal(backend.deleteCalls.length, 0, '删除引用后要等保存成功才删文件');

    await store.flush('workspace');
    assert.deepEqual(backend.deleteCalls, ['/ws/a/memo-root/img/x1.png'],
        '保存成功后按缓存捕获的工作区根删文件');
});

test('删块连带条目贴图 → 保存后全部进回收站', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    const blk = await store.mutate('workspace', (doc) => {
        const r = addBlock(doc, '带图块');
        let d = r.doc;
        d = addItem(d, r.id, '一').doc;
        return {ok: true, doc: d, removedImages: [], id: r.id};
    });
    const firstId = () => {
        const doc = store.cached('workspace');
        const block = doc.blocks.find((b) => b.id === blk.id);
        return block.items[0].id;
    };
    await store.mutate('workspace', (doc) => attachImage(doc, firstId(), 'img/b1.png'));
    await store.mutate('workspace', (doc) => attachImage(doc, firstId(), 'img/b2.png'));
    await store.flush('workspace');
    assert.equal(backend.deleteCalls.length, 0, '首次保存无删除');

    await store.mutate('workspace', (doc) => removeById(doc, blk.id));
    await store.flush('workspace');
    const deleted = backend.deleteCalls.map((p) => p.split('/').pop()).sort();
    assert.deepEqual(deleted, ['b1.png', 'b2.png'], '删块连带两张贴图一起回收');
});

test('CAS 冲突重载把引用带回来 → 保存成功后不删文件', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    const add = await store.mutate('workspace', (doc) => addItem(doc, '', '带图3'));
    await store.mutate('workspace', (doc) => attachImage(doc, add.id, 'img/x2.png'));
    await store.flush('workspace');

    // 别的窗口写入的版本仍含该图引用（mtime 过期 → 我方保存必冲突）
    const key = backend.keyOf('workspace', '/ws/a');
    backend.files.set(key, {
        data: JSON.stringify({version: 1, updatedAt: 9, blocks: [{id: 'blk-o', title: '别人的', collapsed: false,
            items: [{id: add.id, text: '带图3', kind: 'text', status: 'pending', createdAt: 1, updatedAt: 1, images: ['img/x2.png']}]}]}),
        mtimeMs: 999999,
    });

    await store.mutate('workspace', (doc) => removeImageById(doc, add.id, 'img/x2.png'));
    const res = await store.flush('workspace');
    assert.equal(res.conflict, true, '过期 mtime 应冲突重载');
    assert.equal(backend.deleteCalls.length, 0, '冲突未保存成功，不删');

    // 重载回来的文档引用还在：再随便改一笔并保存成功 → 该图绝不能删
    await store.mutate('workspace', (doc) => updateById(doc, add.id, {text: '改一下'}));
    await store.flush('workspace');
    assert.equal(backend.deleteCalls.filter((p) => p.includes('x2.png')).length, 0,
        '引用还在文档里，文件必须保留');
});

test('正文占位符删除 → 保存成功 → 文件同样回收（GC 口径含正文）', async () => {
    const backend = makeBackend();
    const store = makeStore(backend);
    const add = await store.mutate('workspace', (doc) => addItem(doc, '', '看 ![图](img/x3.png) 图'));
    await store.flush('workspace');
    await store.mutate('workspace', (doc) => updateById(doc, add.id, {text: '图删了'}));
    await store.flush('workspace');
    assert.deepEqual(
        backend.deleteCalls.filter((p) => p.includes('x3.png')),
        ['/ws/a/memo-root/img/x3.png'], '正文里删掉占位符即回收文件');
});
