// ai-message-queue 纯模型测试：单队列 + delivery 车道（queue / steer）的增删改与快照。
// 方案见 docs/finished-plans/ai-turn-steering.md §6.1。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueueModel, createAIMessageQueue, formatSteerMessage} from '../../src/ai/ai-message-queue.js';

const item = (over = {}) => ({sessionId: 's1', text: 'hi', attachments: [], ...over});

test('enqueue：默认 queue 车道，显式 steer 生效，id 是唯一字符串', () => {
    const model = createQueueModel();
    const a = model.enqueue(item());
    const b = model.enqueue(item({delivery: 'steer'}));
    assert.equal(a.delivery, 'queue');
    assert.equal(b.delivery, 'steer');
    assert.equal(typeof a.id, 'string');
    assert.notEqual(a.id, b.id);
    assert.equal(a.ts > 0, true);
    assert.equal(a.roundId, '');

    const ids = new Set();
    const many = createQueueModel();
    for (let i = 0; i < 200; i++) ids.add(many.enqueue(item()).id);
    assert.equal(ids.size, 200);
});

test('enqueue：attachments 原样保存，text 归一为字符串', () => {
    const model = createQueueModel();
    const attachments = [{kind: 'image', data: 'x'}];
    const queued = model.enqueue({sessionId: 's1', text: null, attachments});
    assert.equal(queued.text, '');
    assert.deepEqual(queued.attachments, attachments);
});

test('drainSteer：只取该会话的 steer、按 FIFO、取后移除；queue 条目不受影响', () => {
    const model = createQueueModel();
    const q1 = model.enqueue(item({text: 'q1'}));
    const s1 = model.enqueue(item({text: 's1', delivery: 'steer'}));
    const other = model.enqueue(item({sessionId: 's2', text: 'other', delivery: 'steer'}));
    const s2 = model.enqueue(item({text: 's2', delivery: 'steer'}));
    const q2 = model.enqueue(item({text: 'q2'}));

    const taken = model.drainSteer('s1');
    assert.deepEqual(taken.map((it) => it.text), ['s1', 's2']);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['q1', 'q2']);
    assert.deepEqual(model.forSession('s2').map((it) => it.id), [other.id]);
    assert.equal(model.hasSteer('s1'), false);
    assert.equal(model.hasSteer('s2'), true);
    // 取走的对象身份不变（回滚 / 改投按 id 定位仍成立）
    assert.equal(taken[0], s1);
    assert.equal(taken[1], s2);
    assert.equal(q1.delivery, 'queue');
    assert.equal(q2.delivery, 'queue');
});

test('drainSteer：空队列 / 无 steer 会话返回空数组', () => {
    const model = createQueueModel();
    assert.deepEqual(model.drainSteer('nope'), []);
    model.enqueue(item());
    assert.deepEqual(model.drainSteer('s1'), []);
});

test('hasSteer / setDelivery：跨会话隔离、重复改投返回 false', () => {
    const model = createQueueModel();
    const a = model.enqueue(item());
    assert.equal(model.hasSteer('s1'), false);
    assert.equal(model.setDelivery(a, 'steer'), true);
    assert.equal(model.hasSteer('s1'), true);
    assert.equal(model.hasSteer('s2'), false);
    assert.equal(model.setDelivery(a, 'steer'), false);
    assert.equal(model.setDelivery({id: 'missing'}, 'steer'), false);
    assert.equal(model.setDelivery(a, 'queue'), true);
    assert.equal(model.hasSteer('s1'), false);
});

test('fallbackSteerToQueue：只降级目标会话的 steer，返回是否有改动', () => {
    const model = createQueueModel();
    model.enqueue(item({text: 's1', delivery: 'steer'}));
    const other = model.enqueue(item({sessionId: 's2', text: 's2', delivery: 'steer'}));
    assert.equal(model.fallbackSteerToQueue('s1'), true);
    assert.equal(model.forSession('s1')[0].delivery, 'queue');
    assert.equal(other.delivery, 'steer');
    assert.equal(model.fallbackSteerToQueue('s1'), false);
});

test('clearSteer：丢弃目标会话的 steer，保留 queue 与其他会话', () => {
    const model = createQueueModel();
    model.enqueue(item({text: 'q'}));
    model.enqueue(item({text: 's', delivery: 'steer'}));
    model.enqueue(item({sessionId: 's2', text: 'other', delivery: 'steer'}));
    const dropped = model.clearSteer('s1');
    assert.deepEqual(dropped.map((it) => it.text), ['s']);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['q']);
    assert.equal(model.forSession('s2').length, 1);
    assert.deepEqual(model.clearSteer('s1'), []);
});

test('restoreItems：按时间顺序放回同会话队列项之间并改投 queue（drain 后预算回滚）', () => {
    const model = createQueueModel();
    const existing = model.enqueue(item({text: 'existing'}));
    const a = model.enqueue(item({text: 'a', delivery: 'steer'}));
    const b = model.enqueue(item({text: 'b', delivery: 'steer'}));
    const drained = model.drainSteer('s1');
    model.restoreItems(drained, 'queue');
    // FIFO：先排队的 existing 仍在 a/b 之前（回滚不能插队）
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['existing', 'a', 'b']);
    assert.equal(model.hasSteer('s1'), false);
    assert.equal(model.forSession('s1')[0], existing);
});

test('restoreItems：同会话没有更晚项时落到队尾，跨会话不影响本会话顺序', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a', delivery: 'steer'}));
    model.enqueue(item({sessionId: 's2', text: 'other'}));
    model.restoreItems(model.drainSteer('s1'), 'queue');
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['a']);
    assert.equal(model.forSession('s2').length, 1);
    assert.equal(a.delivery, 'queue');
});

test('reorderSession：只重排目标会话的槽位，其它会话位置不动', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a'}));
    const other = model.enqueue(item({sessionId: 's2', text: 'other'}));
    const b = model.enqueue(item({text: 'b'}));
    const c = model.enqueue(item({text: 'c'}));
    assert.equal(model.reorderSession('s1', [c.id, a.id, b.id]), true);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['c', 'a', 'b']);
    // 跨会话槽位保持不动（flush 按会话取队首，跨会话相对位置不影响消费）
    assert.deepEqual(model.all().map((it) => it.text), ['c', 'other', 'a', 'b']);
});

test('reorderSession：未知 id 忽略、漏掉的条目按原顺序补在末尾', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a'}));
    const b = model.enqueue(item({text: 'b'}));
    assert.equal(model.reorderSession('s1', ['missing', b.id]), true);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['b', 'a']);
    assert.equal(model.reorderSession('s1', []), true);
    assert.deepEqual(model.forSession('s1').map((it) => it.text), ['b', 'a']);
    assert.equal(a.text, 'a');
});

test('snapshot：只含目标会话、完整深拷贝（嵌套附件对象也不共享）', () => {
    const model = createQueueModel();
    model.enqueue(item({
        text: 'mine',
        attachments: [{kind: 'image', data: 'x'}, {kind: 'selection', start: {line: 1, column: 2}}],
    }));
    model.enqueue(item({sessionId: 's2', text: 'theirs'}));
    const snap = model.snapshot('s1');
    assert.equal(snap.sessionId, 's1');
    assert.deepEqual(snap.items.map((it) => it.text), ['mine']);
    snap.items[0].text = 'changed';
    snap.items[0].attachments[0].data = 'changed';
    snap.items[0].attachments[1].start.line = 99;
    const live = model.forSession('s1')[0];
    assert.equal(live.text, 'mine');
    assert.equal(live.attachments[0].data, 'x');
    assert.equal(live.attachments[1].start.line, 1);
});

test('clearForSession / clearAll：连同 steer 一起清掉', () => {
    const model = createQueueModel();
    model.enqueue(item({delivery: 'steer'}));
    model.enqueue(item({text: 'q'}));
    model.enqueue(item({sessionId: 's2', delivery: 'steer'}));
    model.clearForSession('s1');
    assert.equal(model.forSession('s1').length, 0);
    assert.equal(model.forSession('s2').length, 1);
    model.clearAll();
    assert.equal(model.hasItems(), false);
});

test('indexOf / remove / insert：所有权 API 行为不变', () => {
    const model = createQueueModel();
    const a = model.enqueue(item({text: 'a'}));
    const b = model.enqueue(item({text: 'b'}));
    assert.equal(model.indexOf(a), 0);
    assert.equal(model.remove(a), true);
    assert.equal(model.remove(a), false);
    model.insert(0, a);
    assert.deepEqual(model.all().map((it) => it.text), ['a', 'b']);
    assert.equal(model.indexOf(b), 1);
});

test('DOM 壳：clearQueueForSession 同时清 steer 与抢占待发标记', () => {
    // el.queue 为空时 renderMessageQueue 直接 return，不需要真 DOM
    const shell = createAIMessageQueue({el: {}});
    shell.enqueueItem({sessionId: 's1', text: 'steer', delivery: 'steer'});
    shell.enqueueItem({sessionId: 's1', text: 'queued'});
    shell.enqueueItem({sessionId: 's2', text: 'other', delivery: 'steer'});
    shell.addInterject('s1');
    assert.equal(shell.itemsForSession('s1').length, 2);
    assert.equal(shell.hasSteer('s1'), true);
    assert.equal(shell.hasInterject('s1'), true);
    shell.clearQueueForSession('s1');
    assert.equal(shell.itemsForSession('s1').length, 0);
    assert.equal(shell.hasSteer('s1'), false);
    assert.equal(shell.hasInterject('s1'), false);
    assert.equal(shell.itemsForSession('s2').length, 1);
});

test('队列行抢占：改投 queue、移到队首、停轮并登记待冲刷', () => {
    let stopped = 0;
    const live = {sessionId: 's1', stopped: false, finished: false, roundId: 'r'};
    const shell = createAIMessageQueue({
        el: {},
        streams: new Map([['s1', live]]),
        compactOf: () => false,
        getStream: () => live,
        flash: () => {},
        stopGeneration: () => { stopped += 1; },
    });
    const a = shell.enqueueItem({sessionId: 's1', text: 'steer', delivery: 'steer'});
    shell.enqueueItem({sessionId: 's1', text: 'queued'});
    shell.preemptQueuedItem(a);
    assert.equal(a.delivery, 'queue');
    assert.equal(shell.itemsForSession('s1')[0], a);
    assert.equal(shell.hasInterject('s1'), true);
    assert.equal(stopped, 1);
});

test('队列行抢占：停止收尾窗口不再重复停轮，等收尾冲刷', () => {
    let stopped = 0;
    const live = {sessionId: 's1', stopped: true, finished: false, roundId: 'r'};
    const shell = createAIMessageQueue({
        el: {},
        streams: new Map([['s1', live]]),
        compactOf: () => false,
        getStream: () => live,
        flash: () => {},
        stopGeneration: () => { stopped += 1; },
    });
    const a = shell.enqueueItem({sessionId: 's1', text: 'steer', delivery: 'steer'});
    shell.preemptQueuedItem(a);
    assert.equal(a.delivery, 'queue');
    assert.equal(shell.hasInterject('s1'), true);
    assert.equal(stopped, 0);
});

test('DOM 壳：steer 车道与手势 API 全部导出为函数', () => {
    const shell = createAIMessageQueue({el: {}});
    for (const api of ['preemptComposerMessage', 'preemptQueuedItem', 'interjectComposerMessage', 'enqueueComposerMessage',
        'hasSteer', 'drainSteer', 'restoreItems', 'setDelivery', 'reorderSession', 'fallbackSteerToQueue', 'clearSteer', 'snapshot']) {
        assert.equal(typeof shell[api], 'function', '缺少导出：' + api);
    }
});

test('formatSteerMessage：ZCode 文案合同（改文案要同步接线护栏）', () => {
    const text = formatSteerMessage('补充一句');
    assert.match(text, /while you were working/);
    assert.match(text, /mid-turn/);
    assert.match(text, /补充一句/);
    assert.equal(formatSteerMessage(null).includes('null'), false);
});
