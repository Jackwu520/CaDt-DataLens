// ai-context-slim.test.mjs：实时瘦身纯判定的护栏。
// 锁住两类「改了就悄悄裁错」的行为：轮次口径（注入类消息不推保留窗口）与
// 大工具结果修剪（白名单 / 阈值 / 头尾预算 / 标记文案）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isRealUserTurn,
    recentTurnStart,
    pruneToolResult,
    slimBreakdownParts,
    SLIM_KEEP_TURNS,
    SLIM_PRUNE_THRESHOLD,
    SLIM_HEAD_CHARS,
    SLIM_PRUNABLE_TOOLS,
} from '../../src/ai/ai-context-slim.js';

const msg = (role, extra) => Object.assign({role, content: role}, extra || {});
const user = (extra) => msg('user', extra);

// ---------- 轮次口径 ----------

test('isRealUserTurn：只有用户亲手键入的消息算一轮', () => {
    assert.equal(isRealUserTurn(user()), true);
    assert.equal(isRealUserTurn(user({turnStartedAt: 1})), true);
    assert.equal(isRealUserTurn(msg('assistant')), false);
    assert.equal(isRealUserTurn(msg('tool')), false);
    assert.equal(isRealUserTurn(null), false);
});

test('isRealUserTurn：四类注入一律不计轮', () => {
    assert.equal(isRealUserTurn(user({systemNote: true})), false, '轮次提醒 / 待办检查');
    assert.equal(isRealUserTurn(user({steer: true})), false, '插话是本轮补充指示');
    assert.equal(isRealUserTurn(user({notice: true})), false, '信箱折叠（子代理结算 / 计时器到点忙时）');
    assert.equal(isRealUserTurn(user({app: {kind: 'app'}})), false, '应用发起 / 后台唤醒轮');
    assert.equal(isRealUserTurn(user({app: {kind: 'read-image'}, images: [{data: 'x'}]})), false,
        '工具中途自动附加的图片');
});

test('recentTurnStart：保留最近 2 轮，第 3 条真实用户轮之后起裁', () => {
    const messages = [user(), msg('assistant'), user(), msg('assistant'),
        user(), msg('assistant'), user(), msg('assistant')];
    // 真实轮在下标 0/2/4/6：倒数第 3 条是下标 2 → recentStart = 3
    assert.equal(recentTurnStart(messages), 3);
    assert.equal(SLIM_KEEP_TURNS, 2);
});

test('recentTurnStart：不足 3 轮返回 0（全保留）', () => {
    assert.equal(recentTurnStart([user(), msg('assistant'), user()]), 0);
    assert.equal(recentTurnStart([]), 0);
    assert.equal(recentTurnStart([msg('assistant'), msg('tool')]), 0);
});

test('recentTurnStart：注入消息不推窗——连续自主过程整段保留', () => {
    // 1 条真实用户轮 + 一长串自主过程（自动附图 / 信箱折叠 / 唤醒轮 / 插话 / 系统注记）：
    // 旧口径会把 recentStart 推到过程尾部、裁掉仍在用的上下文；新口径必须全保留。
    const messages = [
        user(), msg('assistant'), msg('tool'),
        user({app: {kind: 'read-image'}, images: [{data: 'x'}]}),
        msg('assistant'), msg('tool'),
        user({notice: true}),
        msg('assistant'),
        user({app: {kind: 'timer-wake'}}),
        msg('assistant'),
        user({steer: true}),
        user({systemNote: true}),
        msg('assistant'),
    ];
    assert.equal(recentTurnStart(messages), 0);
});

test('recentTurnStart：注入密集时真实轮仍正确计数', () => {
    const messages = [
        user(), msg('assistant'),
        user({notice: true}), user({app: {kind: 'app'}}),
        user(), msg('assistant'),
        user({steer: true}),
        user(), msg('assistant'),
        user({systemNote: true}),
    ];
    // 真实轮在下标 0 / 4 / 7：倒数第 3 条是下标 0 → recentStart = 1
    assert.equal(recentTurnStart(messages), 1);
});

test('recentTurnStart：limit 之后的消息不参与判定', () => {
    const messages = [user(), msg('assistant'), user(), msg('assistant'), user(), msg('assistant')];
    assert.equal(recentTurnStart(messages, 4), 0, '只看前 4 条时只有 2 轮');
    assert.equal(recentTurnStart(messages, 5), 1, '前 5 条含 3 轮，倒数第 3 轮在下标 0');
    assert.equal(recentTurnStart(messages, null), 1);
});

// ---------- 大工具结果修剪 ----------

const bigText = (chars) => 'A'.repeat(chars);

test('pruneToolResult：白名单外与未超阈值不修剪', () => {
    assert.equal(pruneToolResult('list_dir', bigText(20000)), null);
    assert.equal(pruneToolResult('terminal_read', bigText(20000)), null);
    assert.equal(pruneToolResult('read_file', bigText(SLIM_PRUNE_THRESHOLD)), null, '恰好等于阈值不裁');
    assert.equal(pruneToolResult('read_file', ''), null);
    assert.equal(pruneToolResult('read_file', null), null);
    assert.deepEqual(SLIM_PRUNABLE_TOOLS,
        ['read_file', 'web_fetch', 'run_command', 'background_command', 'search_text']);
});

test('pruneToolResult：头 4096 + 尾 1024，中段打标记', () => {
    const text = 'H'.repeat(5000) + 'M'.repeat(5000) + 'T'.repeat(5000);
    const pruned = pruneToolResult('read_file', text);
    assert.ok(pruned.startsWith('H'.repeat(SLIM_HEAD_CHARS)));
    assert.ok(pruned.endsWith('T'.repeat(1024)));
    assert.ok(!pruned.includes('M'), '中段必须被裁掉');
    assert.ok(pruned.includes('原文 15000 字符'));
    assert.ok(pruned.includes('不要凭记忆引用被修剪的中段内容'), '标记必须禁止凭记忆引用中段');
    assert.ok(pruned.includes('重新调用该工具获取'));
    assert.ok(pruned.length < text.length);
});

test('pruneToolResult：命令类尾部预算放宽到 2048', () => {
    const text = bigText(9000) + 'Z'.repeat(3000);
    for (const name of ['run_command', 'background_command']) {
        const pruned = pruneToolResult(name, text);
        assert.ok(pruned.endsWith('Z'.repeat(2048)), name + ' 尾部应保留 2048');
    }
    const fetch = pruneToolResult('web_fetch', text);
    assert.ok(fetch.endsWith('Z'.repeat(1024)), '非命令类仍是 1024');
});

test('pruneToolResult：五个白名单工具超阈值都修剪', () => {
    for (const name of SLIM_PRUNABLE_TOOLS) {
        assert.ok(pruneToolResult(name, bigText(SLIM_PRUNE_THRESHOLD + 1)) != null, name);
    }
});

// ---------- 已省量分类明细 ----------

test('slimBreakdownParts：固定顺序、过滤零项、坏值归零', () => {
    const parts = slimBreakdownParts({reasoning: 62000, transient: 30000, notes: 0, toolPrune: 9000});
    assert.deepEqual(parts.map((p) => p.key), ['reasoning', 'transient', 'toolPrune']);
    assert.deepEqual(parts.map((p) => p.label), ['旧轮思考', '重复注入', '工具结果中段']);
    assert.deepEqual(slimBreakdownParts({}), []);
    assert.deepEqual(slimBreakdownParts(null), []);
    assert.deepEqual(slimBreakdownParts({reasoning: -5, transient: 'x'}), []);
});