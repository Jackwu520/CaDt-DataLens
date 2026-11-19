// failure-notifier.test.mjs —— 统一失败通知器：投递形态、节流、开关、toast 开关。

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFailureNotifier} from '../../src/shell/failure-notifier.js';

function harness(opts) {
    const sent = [];
    let t = 1000;
    const notifier = createFailureNotifier({
        addMessage: (msg, o) => sent.push({msg, o}),
        now: () => t,
        windowMs: 30000,
        ...opts,
    });
    return {notifier, sent, tick: (ms) => { t += ms; }};
}

test('投递到消息中心并默认弹 toast，kind 默认 error', () => {
    const {notifier, sent} = harness();
    assert.equal(notifier.notifyFailure('会话保存失败', '磁盘不可写', {sessionId: 's1'}), true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].msg, {kind: 'error', title: '会话保存失败', body: '磁盘不可写', sessionId: 's1'});
    assert.deepEqual(sent[0].o, {toast: true});
});

test('同 key 窗口内只投一次', () => {
    const {notifier, sent, tick} = harness();
    assert.equal(notifier.notifyFailure('落盘失败', 'a', {key: 'disk'}), true);
    assert.equal(notifier.notifyFailure('落盘失败', 'b', {key: 'disk'}), false);
    tick(10000);
    assert.equal(notifier.notifyFailure('落盘失败', 'c', {key: 'disk'}), false);
    tick(20000);
    assert.equal(notifier.notifyFailure('落盘失败', 'd', {key: 'disk'}), true);
    assert.equal(sent.length, 2);
});

test('缺省 key 用 title，不同 title 互不干扰', () => {
    const {notifier, sent} = harness();
    assert.equal(notifier.notifyFailure('A 失败', ''), true);
    assert.equal(notifier.notifyFailure('B 失败', ''), true);
    assert.equal(notifier.notifyFailure('A 失败', ''), false);
    assert.equal(sent.length, 2);
});

test('enabled() 返回 false 时完全不投递', () => {
    const {notifier, sent} = harness({enabled: () => false});
    assert.equal(notifier.notifyFailure('x', 'y'), false);
    assert.equal(sent.length, 0);
});

test('opts.toast=false 只进列表不弹，kind 可覆盖', () => {
    const {notifier, sent} = harness();
    assert.equal(notifier.notifyFailure('定时完成', '详情', {kind: 'success', toast: false}), true);
    assert.equal(sent[0].msg.kind, 'success');
    assert.deepEqual(sent[0].o, {toast: false});
});
