// ai-tool-cards 纯函数测试：流式工具卡的增量摘要（liveToolSummary）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {liveToolSummary, liveToolParts} from './ai-tool-cards.js';

test('liveToolSummary：能从未闭合的参数 JSON 里捞出 path 与已接收体积', () => {
    // write_file 流式中途：content 字符串尚未闭合，path 已完整
    const partial = '{"path":"docs/笔记.md","content":"# 标题\\n正文第一段';
    const text = liveToolSummary(partial);
    assert.match(text, /^docs\/笔记\.md · 参数接收中 \d+(\.\d+)? (B|KB)$/);
    // 完整 JSON 也能取 path
    assert.match(liveToolSummary('{"path":"a/b.json","content":"{}"}'), /^a\/b\.json · /);
});

test('liveToolSummary：无 path 时只报体积；空参数报 0 B', () => {
    assert.equal(liveToolSummary('{"command":"git status"}'), '参数接收中 24 B');
    assert.equal(liveToolSummary(''), '参数接收中 0 B');
    assert.equal(liveToolSummary(null), '参数接收中 0 B');
    // 超过 1 KB 换算成 KB 显示
    const big = 'x'.repeat(2048);
    assert.match(liveToolSummary(big), /参数接收中 2\.0 KB$/);
});

test('liveToolSummary：path 含转义字符且未闭合时退回原文显示', () => {
    // \" 被截断在反斜杠处：JSON.parse 会失败，退回原文（不抛异常）
    const tricky = '{"path":"a\\\\b\\';
    const text = liveToolSummary(tricky);
    assert.match(text, /参数接收中 \d+ B$/);
});

test('liveToolParts：拆出文件名 / 目录 / 已接收体积与 content-so-far', () => {
    const partial = '{"path":"frontend/src/ai/ai-classifier-verdict.js","content":"// 注释\nexport function foo() {\n  return 1;';
    const parts = liveToolParts(partial);
    assert.equal(parts.name, 'ai-classifier-verdict.js');
    assert.equal(parts.dir, 'frontend/src/ai');
    assert.equal(parts.path, 'frontend/src/ai/ai-classifier-verdict.js');
    assert.match(parts.size, /^(\d+(\.\d+)? (B|KB))$/);
    // 未闭合的 content 字面量解码：\n 换行可用，截断处原文保留
    assert.equal(parts.content, '// 注释\nexport function foo() {\n  return 1;');
});

test('liveToolParts：Windows 反斜杠路径与无 path 场景', () => {
    const win = liveToolParts('{"path":"D:\\data\\样本.json","content":"{}"}');
    assert.equal(win.name, '样本.json');
    assert.equal(win.dir, 'D:\\data');
    const none = liveToolParts('{"command":"git status"}');
    assert.equal(none.path, '');
    assert.equal(none.name, '');
    assert.equal(none.content, null);
    assert.match(none.size, /^\d+ B$/);
});

test('liveToolParts：content 中途截断在转义序列上不抛异常', () => {
    // content 值以 \u 截断：decode 截掉悬空反斜杠后仍可能 parse 失败 → 退回手写替换
    const tricky = liveToolParts('{"path":"a.md","content":"x\\u00e9\\u0');
    assert.ok(typeof tricky.content === 'string');
});

test('liveToolParts：edit_file 的 old_string（闭合才算完整）与 new_string-so-far', () => {
    // old_string 已闭合、new_string 还在流式接收
    const streaming = liveToolParts('{"path":"a.js","old_string":"const a = 1;\nconst b = 2;","new_string":"const a = 1;\nconst b = 2;\nconst c = 3;');
    assert.equal(streaming.oldString, 'const a = 1;\nconst b = 2;');
    assert.equal(streaming.newString, 'const a = 1;\nconst b = 2;\nconst c = 3;');
    // 两个都闭合（new_string 未闭合正则照样能取完整值）
    const done = liveToolParts('{"path":"a.js","old_string":"x","new_string":"y"}');
    assert.equal(done.oldString, 'x');
    assert.equal(done.newString, 'y');
    // old_string 尚未闭合 → null（不产出 ± 统计的信号）
    const oldStreaming = liveToolParts('{"path":"a.js","old_string":"const a =');
    assert.equal(oldStreaming.oldString, null);
    assert.equal(oldStreaming.newString, null);
    // 无 edit 字段的工具不受影响
    assert.equal(liveToolParts('{"command":"git status"}').oldString, null);
});
