// ai-subagents.test.mjs：子代理运行时的纯函数护栏（收件箱消费顺序 / 来源前缀 / 冷唤醒准入）。
// 闭包内的运行时（runSubRound、事件状态机）依赖 DOM 与网络，端到端行为靠手工回归清单；
// 这里锁住「改一处就会悄悄变味」的三条判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {takeInboxBatch, inboxMessageText, canReviveRecord, subAgentScopeOf} from './ai-subagents.js';

test('takeInboxBatch：插队（step）先于排队（turn），各自保持入队顺序', () => {
    const inbox = {
        step: [{text: '紧急 A'}, {text: '紧急 B'}],
        turn: [{text: '排队 1'}, {text: '排队 2'}],
        ask: null,
    };
    const batch = takeInboxBatch(inbox);
    assert.deepEqual(batch.map((item) => item.text), ['紧急 A', '紧急 B', '排队 1', '排队 2']);
    // 消费即清空：同一批不会被下一轮重复注入
    assert.equal(inbox.step.length, 0);
    assert.equal(inbox.turn.length, 0);
    assert.equal(takeInboxBatch(inbox).length, 0);
});

test('takeInboxBatch：空收件箱与缺字段都安全', () => {
    assert.deepEqual(takeInboxBatch(null), []);
    assert.deepEqual(takeInboxBatch({}), []);
    assert.deepEqual(takeInboxBatch({step: [{text: 'x'}]}).length, 1);
});

test('inboxMessageText：主代理消息与用户插话前缀可辨', () => {
    assert.equal(inboxMessageText({text: '换一个方向', from: 'agent'}), '［主代理消息］ 换一个方向');
    assert.equal(inboxMessageText({text: '看下这个文件', from: 'user'}), '［用户插话］ 看下这个文件');
    // 缺 from 时按主代理消息处理（agent_send 是默认发送方）
    assert.equal(inboxMessageText({text: '补充'}), '［主代理消息］ 补充');
});

test('canReviveRecord：done 可续，失败/停止/已回收都拒绝', () => {
    assert.deepEqual(canReviveRecord(null), {ok: false, reason: 'missing'});
    assert.deepEqual(canReviveRecord({state: 'error', session: {}}), {ok: false, reason: 'terminated'});
    assert.deepEqual(canReviveRecord({state: 'stopped', session: {}}), {ok: false, reason: 'terminated'});
    assert.deepEqual(canReviveRecord({state: 'done', continuable: false, session: null}), {ok: false, reason: 'recycled'});
    assert.deepEqual(canReviveRecord({state: 'done', continuable: true, session: null}), {ok: false, reason: 'recycled'});
    assert.deepEqual(canReviveRecord({state: 'done', continuable: true, session: {id: 'sub-1'}}), {ok: true, reason: ''});
});

test('subAgentScopeOf：权限档继承父会话，只读由工具白名单保证', () => {
    // 完全权限下子代理也必须能读工作区外文件——否则 spawn 出去做跨目录调研会被路径校验拦死
    assert.equal(subAgentScopeOf('full'), 'full');
    assert.equal(subAgentScopeOf('auto'), 'auto');
    assert.equal(subAgentScopeOf('edit'), 'edit');
    assert.equal(subAgentScopeOf('read'), 'read');
    // 历史会话 / 缺字段 / 脏数据：退回只读，不意外放大读取范围
    assert.equal(subAgentScopeOf(undefined), 'read');
    assert.equal(subAgentScopeOf(''), 'read');
    assert.equal(subAgentScopeOf('admin'), 'read');
});
