// escape.test.mjs：core/escape.js 的纯逻辑测试。
// 五个实体全转（含单引号，属性上下文安全）；null/undefined 兜底为空串。
import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeHtml} from '../../src/core/escape.js';

test('escapeHtml：& < > " \' 全部转义', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml：组合串逐字符转义，null/undefined 兜底空串', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(''), '');
});
