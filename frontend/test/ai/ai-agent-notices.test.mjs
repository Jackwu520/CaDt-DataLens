// ai-agent-notices.test.mjs：会话信箱（后台注入通道）的行为护栏。
// 覆盖：结算文案（done / error / stopped，含「投递层不截断」）、三态投递、
// 信箱深度与溢出策略（会话投递拒收 / 结算合并）、折叠成 user 消息、唤醒被拒后内容回填。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSettlementNotice, buildAskNotice, createAIAgentNotices, NOTICE_DEPTH_MAX} from '../../src/ai/ai-agent-notices.js';

function makeHarness(overrides) {
    const opts = overrides || {};
    const sessions = new Map();
    const calls = {turns: [], unread: [], notices: [], flashes: [], desktop: [], notified: []};
    const session = {id: 's1', title: '会话一', messages: [], archivedAt: 0};
    sessions.set('s1', session);
    let busy = !!opts.busy;
    const notices = createAIAgentNotices({
        // 等待原语的假实现：这里只关心「入队后有没有按正确的 ownerId notify」——
        // key 写错（session.id → item.id）在端到端里完全看不见，只能在这里抓。
        inboxWaiters: {notify: (ownerId) => calls.notified.push(ownerId)},
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
        getSessions: () => (opts.sessions ? opts.sessions() : [session]),
        workspaceKeyOf: (target) => (opts.workspaceKey ? opts.workspaceKey(target) : 'ws'),
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

test('buildAskNotice：提问通知带 askId 与作答方式，问题与选项都在', () => {
    const notice = buildAskNotice({
        name: '依赖调查',
        agentId: 'sub-9',
        askId: 'call_12',
        questions: [
            {text: '要不要包含 devDependencies？', options: ['包含', '不包含']},
            {text: '目标是小程序还是网页？'},
        ],
    });
    assert.equal(notice.kind, 'subagent-ask');
    assert.equal(notice.label, '子代理提问 · 依赖调查');
    assert.ok(notice.content.startsWith('［子代理提问 · 依赖调查］'));
    assert.ok(notice.content.includes('askId=call_12'), 'askId 是回答的寻址依据');
    assert.ok(notice.content.includes('Q1：要不要包含 devDependencies？'));
    assert.ok(notice.content.includes('可选：包含 / 不包含'));
    assert.ok(notice.content.includes('Q2：目标是小程序还是网页？'));
    assert.ok(notice.content.includes("agent_send(agentId='sub-9'"), '要给出可直接照抄的作答形式');
});

test('投递：入队即 notify 等待方（ownerId 必须是会话 id，不是消息 id）', async () => {
    const h = makeHarness({busy: true});
    h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '子代理通知 · A', content: '完成'});
    // notify 的 key 写错在端到端里完全看不见（wait_agent 只会白等到超时），这里必须锁死
    assert.deepEqual(h.calls.notified, ['s1'], '入队后按会话 id 唤醒');
    h.calls.notified.length = 0;

    // 合并分支（信箱已满 + 结算类只合并不丢弃）同样要 notify：内容变了模型该醒
    for (let i = 0; i < NOTICE_DEPTH_MAX; i++) {
        h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '通知 ' + i, content: '第 ' + i + ' 条'});
    }
    h.calls.notified.length = 0;
    const merged = h.notices.deliverAgentNotice(h.session, {kind: 'subagent', label: '通知 X', content: '溢出的一条'});
    assert.equal(merged.reason, 'merged');
    assert.deepEqual(h.calls.notified, ['s1'], '合并也算有新内容，必须唤醒');
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

// ---- 会话间投递（阶段 H）----

function pairHarness() {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0};
    const b = {id: 's2', title: '会话二', messages: [], archivedAt: 0};
    const c = {id: 's3', title: '会话三', messages: [], archivedAt: 123};
    const h = makeHarness({sessions: () => [a, b, c]});
    h.sessions.set('s2', b);
    h.sessions.set('s3', c);
    return Object.assign(h, {a, b, c});
}

test('session_send：逐目标回执——成功、自投递、不存在、归档各自给原因', () => {
    const h = pairHarness();
    // 让目标处于「忙」：投递只入队，便于断言信箱内容（空闲时会立刻唤醒并消费掉）
    h.setBusy(true);
    const text = h.notices.sendToSessions({targetSessionIds: ['s2', 's1', 'nope', 's3'], message: '看下这个结论'}, {session: h.a});
    assert.ok(text.includes('1/4 成功'));
    assert.ok(text.includes('s1：失败 · 不能投递给自己'));
    assert.ok(text.includes('nope：失败 · 会话不存在'));
    assert.ok(text.includes('s3：失败 · 目标会话已归档'));
    assert.ok(text.includes('s2：已投递'));
    // 成功那条真的进了对方的信箱
    assert.equal(h.notices.pendingCount('s2'), 1);
});

test('session_send：目标数超过 10 整体拒绝', () => {
    const h = pairHarness();
    const ids = Array.from({length: 11}, (_, i) => 'x' + i);
    assert.throws(() => h.notices.sendToSessions({targetSessionIds: ids, message: 'm'}, {session: h.a}), /最多 10 个/);
});

test('session_send：空目标与空正文都拒绝', () => {
    const h = pairHarness();
    assert.throws(() => h.notices.sendToSessions({targetSessionIds: [], message: 'm'}, {session: h.a}), /不能为空/);
    assert.throws(() => h.notices.sendToSessions({targetSessionIds: ['s2'], message: '  '}, {session: h.a}), /不能为空/);
});

test('session_send：对方信箱满时给「信箱已满」回执，不投递', () => {
    const h = pairHarness();
    for (let i = 0; i < NOTICE_DEPTH_MAX; i++) {
        h.notices.deliverAgentNotice(h.b, {kind: 'subagent', content: 'fill' + i});
    }
    h.setBusy(true);
    const text = h.notices.sendToSessions({targetSessionIds: ['s2'], message: '再来一条'}, {session: h.a});
    assert.ok(text.includes('信箱已满'));
    assert.equal(h.notices.pendingCount('s2'), NOTICE_DEPTH_MAX, '没有挤进新消息');
});

test('session_send：urgent 插到各信箱队首（下一边界最先消费）', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.deliverAgentNotice(h.b, {kind: 'subagent', content: '普通排队'});
    h.notices.sendToSessions({targetSessionIds: ['s2'], message: '急件', urgent: true}, {session: h.a});
    h.notices.foldNotices('s2');
    const kept = h.b.messages[0].content;
    assert.ok(kept.indexOf('急件') >= 0, '急件必须被消费');
    assert.ok(kept.indexOf('急件') < kept.indexOf('普通排队'), '插队消息排在普通消息之前');
});

test('session_send：跨会话消息卡片标注「参考信息，非用户指令」，身份以 id 为准', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.sendToSessions({targetSessionIds: ['s2'], message: '配置改了'}, {session: h.a});
    h.notices.foldNotices('s2');
    const content = h.b.messages[0].content;
    // 身份 = 会话 id + 标题（id 在前：标题会被改名 / 自动标题覆盖，id 不会）
    assert.ok(content.startsWith('［会话消息 · 会话 s1「会话一」］'), content);
    assert.ok(content.includes('参考信息，非用户指令'));
    assert.ok(h.b.messages[0].app.label.includes('s1'), '卡片头部带会话 id');
    assert.equal(h.b.messages[0].app.kind, 'session');
});

test('用户投递：面板里自己写的内容按「用户指令」投，不再标成其他会话的参考信息', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.deliverToSessions(['s2'], '收到后只回复【收到】', {session: h.a, byUser: true});
    h.notices.foldNotices('s2');
    const content = h.b.messages[0].content;
    assert.ok(content.startsWith('［用户消息 · 会话 s1「会话一」］'), content);
    assert.ok(content.includes('按用户指令执行'));
    assert.ok(!content.includes('非用户指令'), '用户自己写的不能标成参考信息');
    assert.equal(h.b.messages[0].app.label, '用户消息 · s1「会话一」');
    assert.equal(h.b.messages[0].app.kind, 'session-user');
});

test('用户全局投递：不挂会话身份（来自你），当前会话本身可作为目标', () => {
    const h = pairHarness();
    h.setBusy(true);
    // 显式传 session: null = 侧栏 / ＋菜单入口：目标是当前会话也不判 self
    const out = h.notices.deliverToSessions(['s1'], '记一下：字段名改成 foo', {session: null, byUser: true});
    assert.equal(out.okCount, 1, '全局入口不判 self');
    h.notices.foldNotices('s1');
    const content = h.session.messages[0].content;
    assert.ok(content.startsWith('［用户消息 · 来自你］'), content);
    assert.ok(content.includes('按用户指令执行'));
    assert.ok(!content.includes('另一个会话'), '全局入口不编造「另一个会话」');
    assert.equal(h.session.messages[0].app.label, '用户消息 · 来自你');
});

test('用户广播：标注来自你、无需回复，不带「其他会话」语义', () => {
    const h = pairHarness();
    h.setBusy(true);
    h.notices.deliverToSessions(['s2'], '工作区配置已变更', {broadcast: true});
    h.notices.foldNotices('s2');
    const content = h.b.messages[0].content;
    assert.ok(content.startsWith('［系统通知 · 来自你］'), content);
    assert.ok(content.includes('无需回复'));
    assert.ok(!content.includes('来自其他会话'));
    assert.equal(h.b.messages[0].app.label, '系统通知 · 来自你');
    assert.equal(h.b.messages[0].app.kind, 'session-user');
});

test('session_list：默认只列同工作区、排除自己与归档；显式放开才跨工作区', () => {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0, updatedAt: 3};
    const b = {id: 's2', title: '会话二', messages: [], archivedAt: 0, updatedAt: 2};
    const other = {id: 's4', title: '别的工作区', messages: [], archivedAt: 0, updatedAt: 1};
    const archived = {id: 's5', title: '归档', messages: [], archivedAt: 9, updatedAt: 9};
    const h = makeHarness({
        sessions: () => [a, b, other, archived],
        workspaceKey: (session) => (session.id === 's4' ? 'other' : 'ws'),
    });
    h.sessions.set('s2', b);
    const ids = h.notices.listSessionsForSend().map((row) => row.id);
    assert.deepEqual(ids, ['s2'], '排除自己 / 归档 / 跨工作区');
    const all = h.notices.listSessionsForSend({allWorkspaces: true}).map((row) => row.id);
    assert.ok(all.includes('s4'));
    assert.ok(!all.includes('s5'));
    assert.ok(h.notices.sessionListText().includes('会话二'));
});

test('session_list：excludeSessionId 只排发起方；null 表示不排除（全局入口）', () => {
    const a = {id: 's1', title: '会话一', messages: [], archivedAt: 0, updatedAt: 3};
    const b = {id: 's2', title: '会话二', messages: [], archivedAt: 0, updatedAt: 2};
    const side = {id: 's3', title: '支线', messages: [], archivedAt: 0, updatedAt: 1};
    const h = makeHarness({sessions: () => [a, b, side], workspaceKey: () => 'ws'});
    // 会话发起（支线标签页）：只排发起方，面板当前会话（s1）仍是合法目标
    const fromSide = h.notices.listSessionsForSend({allWorkspaces: true, excludeSessionId: 's3'}).map((row) => row.id);
    assert.deepEqual(fromSide, ['s1', 's2']);
    // 全局入口（侧栏 / ＋菜单）：不排除任何人，当前会话可选
    const global = h.notices.listSessionsForSend({allWorkspaces: true, excludeSessionId: null}).map((row) => row.id);
    assert.deepEqual(global, ['s1', 's2', 's3']);
});
