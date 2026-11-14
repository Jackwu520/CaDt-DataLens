// ai-tool-cards 纯函数测试：流式工具卡的增量摘要（liveToolSummary）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {liveToolSummary} from './ai-tool-cards.js';

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
