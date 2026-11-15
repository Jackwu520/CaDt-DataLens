// ai-agent-notices.test.mjs：会话信箱（后台注入通道）的行为护栏。
// 覆盖：结算文案（done / error / stopped，含「投递层不截断」）、三态投递、
// 信箱深度与溢出策略（会话投递拒收 / 结算合并）、折叠成 user 消息、唤醒被拒后内容回填。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSettlementNotice, createAIAgentNotices, NOTICE_DEPTH_MAX} from './ai-agent-notices.js';

function makeHarness(overrides) {
    const opts = overrides || {};
    const sessions = new Map();
    const calls = {turns: [], unread: [], notices: [], flashes: [], desktop: []};
    const session = {id: 's1', title: '会话一', messages: [], archivedAt: 0};
    sessions.set('s1', session);
    let busy = !!opts.busy;
    const notices = createAIAgentNotices({
        sessionById: (id) => sessions.get(id) || null,
        streamOf: () => (busy ? {sessionId: 's1'} : null),
        compactOf: () => null,
        startSessionTurn: (s, text, options) => {
            calls.turns.push({sessionId: s.id, text, options});
            return opts.turnResult ? opts.turnResult : Promise.resolve({ok: true});
        },
        currentSession: () => session,
        isOpen: () => false,
        renderMessages: () => {},
        renderSessionList: () => {},
        setSessionUnread: (s, kind) => calls.unread.push({id: s.id, kind}),
        notifyDesktop: (o) => calls.desktop.push(o),
        flash: (text, isError) => calls.flashes.push({text, isError}),
        persistSessions: () => {},
        getPendingEdit: () => opts.pendingEdit || null,
    });
    return {
        notices, session, sessions, calls,
        setBusy(value) { busy = value; },
    };
}

test('buildSettlementNotice：完成通知带固定前缀与完整结论（不截断）', () => {
    const long = '结论正文'.repeat(3000);
    const notice = buildSettlementNotice({name: '依赖调查', agentId: 'sub-1', state: 'done', summary: long});
    assert.equal(notice.kind, 'subagent');
    assert.equal(notice.label, '子代理通知 · 依赖调查');
    assert.ok(notice.content.startsWith('［子代理通知 · 依赖调查］'));
    assert.ok(notice.content.includes('id=sub-1'));
    // 投递层不截断：原 AI_SUB_SUMMARY_MAX（8000）已移除，长报告必须整段到达
    assert.ok(notice.content.includes(long), '长结论必须完整保留');
    assert.ok(notice.content.includes('agent_send'), '完成通知要给出后续动作提示');
});

test('buildSettlementNotice：失败与停止的文案各自成句', () => {
    const failed = buildSettlementNotice({name: '审查', agentId: 'sub-2', state: 'error', note: '断网'});
    assert.ok(failed.content.includes('已失败'));
    assert.ok(failed.content.includes('断网'));
    assert.ok(failed.content.startsWith('［子代理通知 · 审查］'));

    const stopped = buildSettlementNotice({name: '扫描', state: 'stopped', summary: '已读 3 个文件', unconsumed: 2});
    assert.ok(stopped.content.includes('已停止'));
    assert.ok(stopped.content.includes('已读 3 个文件'));
    assert.ok(stopped.content.includes('2 条未消费消息'));
});

test('投递：空闲会话立刻唤醒，忙则排队', async () => {
    const h = makeHarness();
    const r = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · A', content: '［子代理通知 · A］完成'});
    assert.equal(r.ok, true);
    assert.equal(r.woke, true);
    await Promise.resolve();
    assert.equal(h.calls.turns.length, 1);
    assert.ok(h.calls.turns[0].text.includes('［子代理通知 · A］'));
    // 后台注入恒不读 pendingEdit、不截断历史
    assert.equal(h.calls.turns[0].options.allowPendingEdit, false);
    assert.equal(h.calls.turns[0].options.truncateAt, null);

    const h2 = makeHarness({busy: true});
    const r2 = h2.notices.deliverAgentNotice(h2.session, {kind: 'subagent', label: 'x', content: '正文'});
    assert.equal(r2.ok, true);
    assert.equal(r2.reason, 'queued');
    assert.equal(h2.calls.turns.length, 0);
    assert.equal(h2.notices.pendingCount('s1'), 1);
});

test('投递：归档会话拒绝、空正文拒绝、编辑态延后不唤醒', () => {
    const h = makeHarness();
    const archived = {...h.session, archivedAt: 123};
    assert.equal(h.notices.deliverAgentNotice(archived, {kind: 'subagent', content: 'x'}).reason, 'archived');
    assert.equal(h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '   '}).reason, 'empty');

    const editing = makeHarness({pendingEdit: {index: 2, sessionId: 's1'}});
    const r = editing.notices.deliverAgentNotice(editing.session, {kind: 'subagent', content: '正文'});
    assert.equal(r.reason, 'deferred');
    assert.equal(editing.calls.turns.length, 0, '用户正在编辑重发时不唤醒');
    assert.equal(editing.notices.pendingCount('s1'), 1);
});

test('信箱深度：会话投递满即拒收，结算类只合并不丢弃', () => {
    const h = makeHarness({busy: true});
    for (let i = 0; i < NOTICE_DEPTH_MAX; i++) {
        const r = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '第 ' + i + ' 条'});
        assert.equal(r.ok, true);
    }
    assert.equal(h.notices.pendingCount('s1'), NOTICE_DEPTH_MAX);

    // 会话间投递：满了给回执，发送方可丢
    const rejected = h.notices.deliverAgentNotice(h.session, {kind: 'session', content: '来自别的会话'});
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'full');

    // 结算通知：只合并不丢弃（丢了无法再生）
    const merged = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '另一个子代理完成'});
    assert.equal(merged.ok, true);
    assert.equal(merged.reason, 'merged');
    assert.equal(h.notices.pendingCount('s1'), NOTICE_DEPTH_MAX, '合并后深度不增长');
});

test('折叠：工具轮边界把通知折成一条 user 消息并清空队列', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · A', content: '甲'});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · B', content: '乙'});
    assert.equal(h.notices.pendingCount('s1'), 2);
    const folded = h.notices.foldNotices('s1');
    assert.equal(folded, 2);
    assert.equal(h.notices.pendingCount('s1'), 0);
    assert.equal(h.session.messages.length, 1);
    const msg = h.session.messages[0];
    assert.equal(msg.role, 'user');
    assert.equal(msg.notice, true);
    assert.ok(msg.content.includes('甲') && msg.content.includes('乙'));
    // 多条合并时 app 元数据退化为「后台通知 · N 条」，卡片仍能归类
    assert.equal(msg.app.kind, 'subagent');
    assert.ok(msg.app.label.includes('2 条'));
});

test('折叠：单次消费上限内多条合并，超出部分留在信箱', () => {
    const h = makeHarness({busy: true});
    for (let i = 0; i < 8; i++) h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'n' + i});
    const folded = h.notices.foldNotices('s1');
    assert.equal(folded, 5, '单边界最多 5 条');
    assert.equal(h.notices.pendingCount('s1'), 3);
});

test('唤醒被拒：内容退回信箱最前并打未读，不静默丢弃', async () => {
    const h = makeHarness({turnResult: Promise.resolve({ok: false, reason: 'over_budget'})});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '要送达的通知'});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.notices.pendingCount('s1'), 1, '被拒后内容必须回填');
    assert.equal(h.calls.unread.length, 1);
    assert.equal(h.calls.unread[0].kind, 'done');
    assert.ok(h.calls.desktop.length >= 1);
    assert.ok(h.calls.flashes.some((f) => f.isError));
});

test('flushNotices：忙时只排队不唤醒，空闲时唤醒', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'x'});
    assert.equal(h.notices.flushNotices('s1').reason, 'busy');
    assert.equal(h.calls.turns.length, 0);
    h.setBusy(false);
    assert.equal(h.notices.flushNotices('s1').woke, true);
});

test('foldBeforeTurn：不单独唤醒，直接折进即将发出的那一轮', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: '随轮注入'});
    assert.equal(h.notices.foldBeforeTurn(h.session), 1);
    assert.equal(h.calls.turns.length, 0, '用户这一轮已经开始，不再起新轮');
    assert.equal(h.session.messages.length, 1);
    assert.ok(h.session.messages[0].content.includes('随轮注入'));
});

test('clearMailbox / dropSession：清空与删除都不留残影', () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'x'});
    assert.equal(h.notices.clearMailbox('s1'), 1);
    assert.equal(h.notices.pendingCount('s1'), 0);
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', content: 'y'});
    h.notices.dropSession('s1');
    assert.equal(h.notices.pendingCount('s1'), 0);
});
