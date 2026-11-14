// ai-timer 纯函数测试：计时器的会话隔离（显示过滤 + 会话内上限计数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTimersForSession, countSessionTimers} from './ai-timer.js';

function makeTimers(entries) {
    const timers = new Map();
    for (const info of entries) timers.set(info.id, info);
    return timers;
}

test('filterTimersForSession：只显示归属当前会话的计时器', () => {
    const timers = makeTimers([
        {id: 't1', label: 'A 的倒计时'},
        {id: 't2', label: 'B 的正计时'},
        {id: 't3', label: 'A 的正计时'},
    ]);
    const sessionIdOf = (id) => ({t1: 'sess-a', t2: 'sess-b', t3: 'sess-a'}[id] || '');
    const visible = filterTimersForSession(timers, sessionIdOf, 'sess-a');
    assert.deepEqual(visible.map((t) => t.id).sort(), ['t1', 't3']);
    const visibleB = filterTimersForSession(timers, sessionIdOf, 'sess-b');
    assert.deepEqual(visibleB.map((t) => t.id), ['t2']);
});

test('filterTimersForSession：归属不明（跨窗同步）的计时器保持可见', () => {
    const timers = makeTimers([
        {id: 't1', label: '本会话的'},
        {id: 't2', label: '别的窗口启动的，本实例无归属记录'},
    ]);
    const sessionIdOf = (id) => (id === 't1' ? 'sess-a' : '');
    const visible = filterTimersForSession(timers, sessionIdOf, 'sess-a');
    assert.deepEqual(visible.map((t) => t.id).sort(), ['t1', 't2']);
});

test('countSessionTimers：会话内上限只数归属自己的运行中计时器', () => {
    const timers = makeTimers([
        {id: 't1'}, {id: 't2'}, {id: 't3'}, {id: 't4'}, {id: 't5'}, // 本会话 5 个
        {id: 'x1'}, // 别的会话
        {id: 'x2'}, // 归属不明（跨窗）
    ]);
    const sessionIdOf = (id) => ({t1: 'a', t2: 'a', t3: 'a', t4: 'a', t5: 'a', x1: 'b'}[id] || '');
    assert.equal(countSessionTimers(timers, sessionIdOf, 'a'), 5);
    assert.equal(countSessionTimers(timers, sessionIdOf, 'b'), 1);
    // 空注册表 / 非法输入兜底
    assert.equal(countSessionTimers(makeTimers([]), sessionIdOf, 'a'), 0);
    assert.equal(countSessionTimers(null, sessionIdOf, 'a'), 0);
    assert.equal(filterTimersForSession(null, sessionIdOf, 'a').length, 0);
});
