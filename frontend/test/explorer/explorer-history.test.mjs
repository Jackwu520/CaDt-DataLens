// explorer-history.test.mjs：文件树撤销栈的纯逻辑测试。
// 撤销栈是会话内的可逆动作记录，失败时不改栈、回放时不自记录是核心不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExplorerHistory} from '../../src/explorer/explorer-history.js';

function echoHistory() {
    const log = [];
    const h = createExplorerHistory();
    h.push({
        label: 'op1',
        undo: async () => { log.push('undo1'); return true; },
        redo: async () => { log.push('redo1'); return true; },
    });
    return {h, log};
}

test('push 后能撤销，撤销后能重做', async () => {
    const {h, log} = echoHistory();
    assert.equal(h.canUndo(), true);
    assert.equal(h.canRedo(), false);
    assert.equal(h.peekUndo(), 'op1');
    assert.equal(await h.undo(), true);
    assert.equal(h.canUndo(), false);
    assert.equal(h.canRedo(), true);
    assert.equal(h.peekRedo(), 'op1');
    assert.equal(await h.redo(), true);
    assert.equal(h.canRedo(), false);
    assert.equal(h.canUndo(), true);
    assert.deepEqual(log, ['undo1', 'redo1']);
});

test('undo 返回 false 时不弹栈，也不进 redo 栈', async () => {
    const h = createExplorerHistory();
    h.push({
        label: 'fails',
        undo: async () => false,
        redo: async () => { throw new Error('不该被调用'); },
    });
    assert.equal(await h.undo(), false);
    assert.equal(h.canUndo(), true, '失败的撤销应当留在栈里');
    assert.equal(h.canRedo(), false);
});

test('redo 返回 false 时不回退 redo 栈', async () => {
    const h = createExplorerHistory();
    h.push({label: 'x', undo: async () => true, redo: async () => false});
    await h.undo();
    assert.equal(await h.redo(), false);
    assert.equal(h.canRedo(), true);
});

test('新的 push 清空 redo 栈（经典撤销语义）', async () => {
    const h = createExplorerHistory();
    h.push({label: 'a', undo: async () => true, redo: async () => true});
    await h.undo();
    assert.equal(h.canRedo(), true);
    h.push({label: 'b', undo: async () => true, redo: async () => true});
    assert.equal(h.canRedo(), false, '撤销后若做了新操作，旧重做链应作废');
});

test('回放期间 push 不记栈（防止动作内部刷新自我循环）', async () => {
    const h = createExplorerHistory();
    h.push({
        label: 'outer',
        undo: async () => {
            h.push({label: 'inner', undo: async () => true, redo: async () => true});
            return true;
        },
        redo: async () => true,
    });
    await h.undo();
    assert.equal(h.canUndo(), false, '回放时产生的内部操作不应留在撤销栈');
    assert.equal(h.peekRedo(), 'outer');
});

test('push 拒绝非法记录，超出上限丢弃最旧记录', () => {
    const h = createExplorerHistory(2);
    h.push(null);
    h.push({label: 'no-undo', redo: () => {}});
    assert.equal(h.canUndo(), false);
    for (const label of ['a', 'b', 'c']) {
        h.push({label, undo: async () => true, redo: async () => true});
    }
    assert.equal(h.peekUndo(), 'c');
    assert.ok(h.canUndo());
});
