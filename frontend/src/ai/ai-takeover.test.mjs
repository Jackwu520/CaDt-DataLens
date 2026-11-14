// ai-takeover 纯函数测试：审批卡判定区的行描述（classifyVerdictRows）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyVerdictRows} from './ai-takeover.js';

test('classifyVerdictRows：端侧 + AI 复核双层输出两行', () => {
    const rows = classifyVerdictRows({engine: '线性', score: 1.0, threshold: 0.15, aiReason: '联网请求并写入文件，非只读'});
    assert.equal(rows.length, 2);
    assert.equal(rows[0].chip, '端侧·线性');
    assert.equal(rows[0].score, 1);
    assert.equal(rows[0].threshold, 0.15);
    assert.equal(rows[0].hot, true);
    assert.equal(rows[1].chip, 'AI 复核');
    assert.equal(rows[1].reason, '联网请求并写入文件，非只读');
});

test('classifyVerdictRows：低分贴阈值不着红；仅端侧 / 仅 AI 复核各一行', () => {
    const low = classifyVerdictRows({engine: '线性', score: 0.16, threshold: 0.15});
    assert.equal(low.length, 1);
    assert.equal(low[0].hot, false);
    const sem = classifyVerdictRows({engine: 'MiniLM 语义', score: 0.96, threshold: 0.15});
    assert.equal(sem[0].chip, '端侧·MiniLM 语义');
    assert.equal(sem[0].hot, true);
    const aiOnly = classifyVerdictRows({aiReason: '读取文件并写入剪贴板，超出只读范围'});
    assert.equal(aiOnly.length, 1);
    assert.equal(aiOnly[0].chip, 'AI 复核');
    assert.equal(aiOnly[0].reason, '读取文件并写入剪贴板，超出只读范围');
});

test('classifyVerdictRows：空 / 异常输入安全兜底', () => {
    assert.deepEqual(classifyVerdictRows(null), []);
    assert.deepEqual(classifyVerdictRows({}), []);
    assert.deepEqual(classifyVerdictRows({engine: '', aiReason: ''}), []);
    // 分数越界收敛到 [0,1]
    const clamped = classifyVerdictRows({engine: '线性', score: 5, threshold: -1})[0];
    assert.equal(clamped.score, 1);
    assert.equal(clamped.threshold, 0);
});
