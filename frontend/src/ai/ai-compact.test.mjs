// ai-compact.test.mjs：压缩内核（主会话与子代理共用）的纯函数护栏。
// 锁住三处「改了就悄悄出错」的判定：cutoff 必须回退到 user 轮边界、summary 形状要能被
// buildApiMessages 认出来、阈值 clamp 口径与主会话一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeCompactCutoff,
    buildCompactSummary,
    applyCompactToSession,
    compactTranscriptOf,
    buildCompactMessages,
    compactThresholdOf,
    COMPACT_KEEP_TAIL,
} from './ai-compact.js';

const msg = (role, extra) => Object.assign({role, content: role}, extra || {});

test('computeCompactCutoff：保留尾部并回退到最近的 user 轮边界', () => {
    // [u a u a u a u a]：keep=3 → cutoff=5（assistant）→ 回退到 4（user）
    const messages = [msg('user'), msg('assistant'), msg('user'), msg('assistant'),
        msg('user'), msg('assistant'), msg('user'), msg('assistant')];
    assert.equal(computeCompactCutoff(messages, 3), 4);
    // keep=6 → cutoff=2 已是 user，不再回退
    assert.equal(computeCompactCutoff(messages, 6), 2);
    // 保留条数超过总数：cutoff=0（不裁剪）
    assert.equal(computeCompactCutoff(messages, 20), 0);
});

test('computeCompactCutoff：工具轮中间不会被切开', () => {
    // 落点恰好是 tool：必须回退到本轮的 user 起点
    const messages = [msg('user'), msg('assistant'), msg('tool'), msg('user'), msg('assistant'), msg('tool'), msg('assistant')];
    assert.equal(computeCompactCutoff(messages, 2), 3, 'cutoff 落在本轮 assistant，回退到 user');
    assert.equal(computeCompactCutoff(messages, 3), 3);
});

test('computeCompactCutoff：全是 assistant 时退到 0（宁可全压也不切碎）', () => {
    const messages = [msg('assistant'), msg('assistant'), msg('assistant')];
    assert.equal(computeCompactCutoff(messages, 1), 0);
    assert.equal(computeCompactCutoff(null), 0);
    assert.equal(COMPACT_KEEP_TAIL, 6);
});

test('buildCompactSummary：summary 形状固定（upTo / trigger / before）', () => {
    const summary = buildCompactSummary('  摘要正文  ', 4, {kind: 'auto'}, 20);
    assert.equal(summary.text, '摘要正文', '首尾空白裁掉');
    assert.equal(summary.upTo, 4);
    assert.deepEqual(summary.trigger, {kind: 'auto'});
    assert.deepEqual(summary.before, {messages: 20, archived: 4});
    assert.equal(typeof summary.createdAt, 'number');
});

test('applyCompactToSession：裁剪消息、写回 summary、返回归档段', () => {
    const session = {messages: [msg('user'), msg('assistant'), msg('user'), msg('assistant')], summary: null};
    const summary = buildCompactSummary('s', 3, null, 4);
    const result = applyCompactToSession(session, summary, 3);
    assert.equal(result.archived.length, 3);
    assert.equal(result.kept, 1);
    assert.equal(session.messages.length, 1);
    assert.equal(session.summary, summary);
    // 越界 cutoff 不能把消息吃光或报错
    const other = {messages: [msg('user')], summary: null};
    assert.equal(applyCompactToSession(other, summary, 99).kept, 0);
    assert.deepEqual(applyCompactToSession(null, summary, 1), {archived: [], kept: 0});
});

test('compactTranscriptOf：带上此前摘要与工具结果，超长从尾部保留', () => {
    const session = {
        summary: {text: '上一轮的摘要'},
        messages: [
            {role: 'user', content: '查依赖'},
            {role: 'tool', name: 'read_file', content: '文件内容'},
            {role: 'assistant', content: ''},
            {role: 'user', content: '继续', images: [{data: 'x'}]},
        ],
    };
    const text = compactTranscriptOf(session);
    assert.ok(text.includes('此前摘要：'));
    assert.ok(text.includes('上一轮的摘要'));
    assert.ok(text.includes('[工具 read_file 结果]'));
    assert.ok(text.includes('文件内容'));
    assert.ok(text.includes('（附图 1 张）'));
    // 空 assistant 不进转录（只留正文与工具）
    assert.ok(!/AI：\n\n/.test(text));
});

test('buildCompactMessages：system 为摘要器约束，user 带焦点指令', () => {
    const session = {messages: [{role: 'user', content: 'x'}]};
    const messages = buildCompactMessages(session, '摘要约束', '保住补丁库方案');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '摘要约束');
    assert.ok(messages[1].content.startsWith('请压缩以下对话记录：'));
    assert.ok(messages[1].content.includes('用户压缩指令（摘要须优先落实）：保住补丁库方案'));
    // 无指令时不出现空标题
    assert.ok(!buildCompactMessages(session, 's', '')[1].content.includes('用户压缩指令'));
});

test('compactThresholdOf：默认 0.8，夹在 0.5–0.95', () => {
    assert.equal(compactThresholdOf({}), 0.8);
    assert.equal(compactThresholdOf({autoCompactThreshold: 0.2}), 0.5);
    assert.equal(compactThresholdOf({autoCompactThreshold: 0.99}), 0.95);
    assert.equal(compactThresholdOf({autoCompactThreshold: 0.7}), 0.7);
    assert.equal(compactThresholdOf(null), 0.8);
});
