// ai-subagents.test.mjs：子代理运行时的纯函数护栏（收件箱消费顺序 / 来源前缀 / 冷唤醒准入）。
// 闭包内的运行时（runSubRound、事件状态机）依赖 DOM 与网络，端到端行为靠手工回归清单；
// 这里锁住「改一处就会悄悄变味」的三条判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {takeInboxBatch, inboxMessageText, canReviveRecord, isStaleRecord, subAgentScopeOf, agentMessageBlocks, agentRecordBlocks, agentTranscriptBlocks, agentBlockSig, agentToolArgBrief} from '../../src/ai/ai-subagents.js';

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

test('isStaleRecord：唤醒前的记录算陈旧，唤醒后落账的不算', () => {
    // wait_agent 用它挡住「冷唤醒后立刻拿到上一轮结论」的误报（2026-11-15 实测缺陷）
    const cases = [
        ['无唤醒标记（普通终态记录）', {finishedAt: 1000}, false],
        ['空记录', null, false],
        ['唤醒晚于落账：陈旧', {revivedAt: 2000, finishedAt: 1000}, true],
        ['唤醒早于落账：新一轮已落账', {revivedAt: 1000, finishedAt: 2000}, false],
        // 同一毫秒按「已落账」处理：误判成陈旧会一直等到超时，代价更高
        ['同一毫秒：不算陈旧', {revivedAt: 1000, finishedAt: 1000}, false],
        ['缺 finishedAt 但有 revivedAt：陈旧', {revivedAt: 1000}, true],
        ['脏字符串按数字容错', {revivedAt: '2000', finishedAt: '1000'}, true],
    ];
    for (const [name, record, expected] of cases) {
        assert.equal(isStaleRecord(record), expected, name);
    }
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

// 子代理详情视图改成内容区标签页后，正文按「块 + 签名」增量渲染：块 key 决定复用，
// 签名决定重写。这两条错了就是「点开全空」或「图表每 300ms 重建」，所以单列护栏。

test('agentMessageBlocks：消息收敛成块，空白正文与未知角色不产生块', () => {
    const blocks = agentMessageBlocks([
        {role: 'user', content: '查出所有 TODO'},
        {role: 'assistant', content: '   '},   // 流式中间态：没有正文就不渲染
        {role: 'assistant', content: '  开始找  '},
        {role: 'tool', name: 'search_text', content: 'a.js:1', status: 'done'},
        {role: 'tool', name: 'read_file', content: '越界', status: 'error'},
        null,
    ]);
    assert.deepEqual(blocks.map((b) => b.kind), ['user', 'assistant', 'tool', 'tool']);
    assert.deepEqual(blocks.map((b) => b.key), ['m0', 'm2', 'm3', 'm4']);
    assert.equal(blocks[1].text, '开始找');   // 两端空白裁掉，避免纯空白抖动触发重渲染
    assert.equal(blocks[3].error, true);
    assert.deepEqual(agentMessageBlocks(null), []);
});

test('agentTranscriptBlocks：转录只收 assistant / tool，下标即 key', () => {
    const blocks = agentTranscriptBlocks([
        {role: 'assistant', text: '过程 1', live: true},
        {role: 'tool', name: 'list_dir', text: 'a\nb'},
        null,
    ]);
    assert.deepEqual(blocks.map((b) => b.key), ['t0', 't1']);
    assert.equal(blocks[1].name, 'list_dir');
    assert.deepEqual(agentTranscriptBlocks(null), []);
});

// 收尾/唤醒必须共用同一套块（key 同为 m<i>）：换成「摘要 + 转录」会整段换模型，
// 节点全删重建 → 滚动位置被钳走、图表卡片销毁（2026-11-16 实测缺陷）。
test('agentRecordBlocks：终态沿用消息块，摘要只在「不是最后一条正文」时补一张卡', () => {
    const messages = [
        {role: 'user', content: '查看 sample.json'},
        {role: 'assistant', content: '结论：结构完好'},
    ];
    const same = agentRecordBlocks(messages, ' 结论：结构完好 ');
    // 摘要就是最后一条 assistant 正文：不重复挂块（多一块会让收尾瞬间高度再抖一次）
    assert.deepEqual(same.map((b) => b.kind), ['user', 'assistant']);
    assert.deepEqual(same.map((b) => b.key), ['m0', 'm1']);
    // 摘要来自 note / 摘录：补一张 summary 卡，块仍在同一套 key 空间里追加
    const extra = agentRecordBlocks(messages, '（用户停止）仅完成一半');
    assert.deepEqual(extra.map((b) => b.kind), ['user', 'assistant', 'summary']);
    assert.deepEqual(extra.map((b) => b.key), ['m0', 'm1', 'summary']);
    assert.equal(extra[2].text, '（用户停止）仅完成一半');
    // 空摘要不挂卡；没有会话消息时也只有摘要卡
    assert.deepEqual(agentRecordBlocks(messages, '   ').map((b) => b.kind), ['user', 'assistant']);
    assert.deepEqual(agentRecordBlocks([], '只有摘要').map((b) => b.key), ['summary']);
    assert.deepEqual(agentRecordBlocks(null, ''), []);
});

test('agentBlockSig：正文追加即变，生成中与落定不同签名（占位→真实卡片）', () => {
    const base = {key: 'm1', kind: 'assistant', text: '```mermaid\ngraph TD;A-->B'};
    const grown = {...base, text: base.text + '\n```'};
    assert.notEqual(agentBlockSig(base, true), agentBlockSig(grown, true));
    // 同一份文本：流式（只占位）与落定（挂载卡片）必须不同，否则图永远停在占位
    assert.notEqual(agentBlockSig(base, true), agentBlockSig(base, false));
    // 类型与失败标记参与签名：同一文本切成工具行不能被复用
    assert.notEqual(agentBlockSig(base, false), agentBlockSig({...base, kind: 'tool'}, false));
    assert.notEqual(agentBlockSig({...base, kind: 'tool'}, false), agentBlockSig({...base, kind: 'tool', error: true}, false));
    // 只看尾部：长正文不会把签名字符串撑大
    const long = {kind: 'assistant', text: 'x'.repeat(5000) + 'TAIL'};
    assert.ok(agentBlockSig(long, false).length < 160);
});

test('agentToolArgBrief：取点名到对象的字段，畸形 JSON 与空值返回空串', () => {
    // path 优先于更靠后的 name：工具行标题要能一眼看出「读了哪个文件」
    assert.equal(agentToolArgBrief('{"name":"x","path":"src/main.js"}'), 'src/main.js');
    assert.equal(agentToolArgBrief('{"query":"spawn_agent"}'), 'spawn_agent');
    // 多行参数压成一行（标题是单行文本）
    assert.equal(agentToolArgBrief('{"pattern":"a\\n  b"}'), 'a b');
    // 超长截断，避免把整段任务描述塞进标题
    assert.equal(agentToolArgBrief(JSON.stringify({task: 'x'.repeat(200)})).length, 61);
    assert.equal(agentToolArgBrief('not json'), '');
    assert.equal(agentToolArgBrief('{}'), '');
    assert.equal(agentToolArgBrief(''), '');
    assert.equal(agentToolArgBrief('{"path":"   "}'), '');
});
