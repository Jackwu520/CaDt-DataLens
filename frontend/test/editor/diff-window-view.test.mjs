// diff-window-view：文件对比独立窗的纯函数测试（摘要组装与格式感知解析守卫）。
// 对话框已退化为选择器：比较内核在窗口里跑，摘要文案这里锁住口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDiffSummary, parseForDiff} from '../../src/editor/diff-window-view.js';

test('formatDiffSummary：相同 / 文本差异 / 语义差异口径', () => {
    assert.equal(formatDiffSummary({added: 0, removed: 0}, 0, true), '文本内容相同');
    assert.equal(formatDiffSummary({added: 3, removed: 1}, 0, true), '文本差异：+3 行 / -1 行 · 语义差异 0 处');
    assert.equal(formatDiffSummary({added: 3, removed: 1}, 5, true), '文本差异：+3 行 / -1 行 · 语义差异 5 处');
    // 两侧都无法按格式解析：明说数据感知比较不可用
    assert.equal(formatDiffSummary({added: 2, removed: 2}, 0, false), '文本差异：+2 行 / -2 行 · 当前格式无可用的数据感知比较');
});

test('parseForDiff：无驱动 / 解析失败返回 null，不抛错', () => {
    // 未知扩展名 + 纯文本：没有格式驱动
    assert.equal(parseForDiff('a.unknownext', 'plain text'), null);
    // JSON：有驱动且解析成功
    const ok = parseForDiff('a.json', '{"a":1}');
    assert.ok(ok && ok.value && ok.value.a === 1);
    // JSON 但内容非法：解析失败 → null（回退纯文本比较），不抛错
    assert.equal(parseForDiff('a.json', '{坏了'), null);
});
