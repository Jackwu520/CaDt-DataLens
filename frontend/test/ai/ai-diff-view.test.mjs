// ai-diff-view.test.mjs —— 行级 diff 纯函数（V4 从 ai-panel.js 收编）：
// LCS 输出形状 / CRLF 归一 / 超限降级 / preview 裁剪与省略号。

import test from 'node:test';
import assert from 'node:assert/strict';
import {diffLinesOf, computeLineDiff, diffStats, buildDiffPreview} from '../../src/ai/ai-diff-view.js';

test('diffLinesOf：CRLF / CR 归一、去尾部空行、空输入', () => {
    assert.deepEqual(diffLinesOf('a\r\nb\r\n'), ['a', 'b']);
    assert.deepEqual(diffLinesOf('a\rb'), ['a', 'b']);
    assert.deepEqual(diffLinesOf(''), []);
    assert.deepEqual(diffLinesOf(null), []);
    assert.deepEqual(diffLinesOf('a\n\n'), ['a', '']);
});

test('computeLineDiff：相同行保留、增删行按 LCS 对齐', () => {
    const ops = computeLineDiff('a\nb\nc', 'a\nx\nc');
    assert.deepEqual(ops, [
        {t: ' ', text: 'a'},
        {t: '-', text: 'b'},
        {t: '+', text: 'x'},
        {t: ' ', text: 'c'},
    ]);
});

test('computeLineDiff：空 → 内容 / 内容 → 空', () => {
    const added = computeLineDiff('', 'x\ny');
    assert.deepEqual(added, [{t: '+', text: 'x'}, {t: '+', text: 'y'}]);
    const removed = computeLineDiff('x\ny', '');
    assert.deepEqual(removed, [{t: '-', text: 'x'}, {t: '-', text: 'y'}]);
});

test('computeLineDiff：超限走首尾对齐降级，公共前后缀保留', () => {
    // 超过 AI_DIFF_MAX_LINES(4000) 行：走降级分支，中间整段按 - 后 + 输出
    const oldText = Array.from({length: 2001}, (_, i) => 'old-' + i).join('\n');
    const newText = Array.from({length: 2001}, (_, i) => 'new-' + i).join('\n');
    const ops = computeLineDiff(oldText, newText);
    assert.equal(ops.length, 4002);
    // 首行不同 → 无公共前缀；全部 2001 行 old 为 -，2001 行 new 为 +
    assert.equal(ops.filter((op) => op.t === '-').length, 2001);
    assert.equal(ops.filter((op) => op.t === '+').length, 2001);
    // 相同前缀会被保留为上下文
    const same = 'same\n' + oldText;
    const sameNew = 'same\n' + newText;
    const ops2 = computeLineDiff(same, sameNew);
    assert.deepEqual(ops2[0], {t: ' ', text: 'same'});
});

test('diffStats：± 计数', () => {
    const ops = computeLineDiff('a\nb\nc', 'a\nc\nd');
    const stats = diffStats(ops);
    assert.equal(stats.removed, 1); // b
    assert.equal(stats.added, 1); // d
    assert.deepEqual(diffStats([]), {added: 0, removed: 0});
});

test('buildDiffPreview：改动行前后各留 2 行上下文，长间隔插入省略号', () => {
    const ops = [];
    for (let i = 0; i < 20; i++) ops.push({t: ' ', text: 'ctx' + i});
    ops.push({t: '+', text: 'new'});
    // 只有一条改动（末行）：保留改动行 ±2，前面只有 2 行上下文可留
    const preview = buildDiffPreview(ops);
    assert.equal(preview.truncated, false);
    assert.deepEqual(preview.lines.map((line) => line.text), ['ctx18', 'ctx19', 'new']);
    // 两处相距很远的改动：中间出现 '…'
    const ops2 = [
        {t: '+', text: 'first'},
        {t: ' ', text: 'a'},
        {t: ' ', text: 'b'},
        {t: ' ', text: 'c'},
        {t: ' ', text: 'd'},
        {t: ' ', text: 'e'},
        {t: '+', text: 'last'},
    ];
    const preview2 = buildDiffPreview(ops2);
    assert.ok(preview2.lines.some((line) => line.t === '…'));
});

test('buildDiffPreview：无改动时保留首行；空 ops 返回空', () => {
    const unchanged = computeLineDiff('a\nb', 'a\nb');
    const preview = buildDiffPreview(unchanged);
    assert.equal(preview.lines.length, 1);
    assert.deepEqual(preview.lines[0], {t: ' ', text: 'a'});
    assert.deepEqual(buildDiffPreview([]), {lines: [], truncated: false});
});
