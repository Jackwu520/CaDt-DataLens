// markdown 渲染层纯函数测试：mermaid 占位源码的 base64 编解码往返。
// 背景：DOMPurify 3.4.x 会整体丢弃属性值含换行的属性，mermaid 源码必含换行，
// 占位必须存 base64（无换行）才能在 sanitize 后存活——见 markdown.js 编解码注释。
// 用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {decodeMermaidSource, encodeMermaidSource} from './markdown.js';

test('mermaid 源码 base64 往返无损（含中文与特殊符号）', () => {
    const cases = [
        'graph TD\nA-->B',
        'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[成功]',
        'sequenceDiagram\n participant 甜澄\n 甜澄->>AI: 你好',
        '',
    ];
    for (const src of cases) {
        assert.equal(decodeMermaidSource(encodeMermaidSource(src)), src);
    }
});

test('编码结果不含换行（DOMPurify 剥换行属性问题的回归护栏）', () => {
    for (const src of ['a\nb\nc', '\n', 'graph TD\nT1[标签\n带换行]']) {
        const encoded = encodeMermaidSource(src);
        assert.ok(!/[\r\n]/.test(encoded), '编码值不应含换行: ' + JSON.stringify(encoded));
    }
});
