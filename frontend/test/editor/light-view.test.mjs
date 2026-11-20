// light-view：轻量查看窗纯函数测试（语言映射与元信息行）。
// 规则：常见数据/代码格式有确定语言；未知扩展名回落纯文本不高亮。
import test from 'node:test';
import assert from 'node:assert/strict';
import {pickLightLanguage, formatLightMeta} from '../../src/editor/light-view.js';

test('pickLightLanguage：常见格式映射', () => {
    assert.equal(pickLightLanguage('D:/x/a.json'), 'json');
    assert.equal(pickLightLanguage('C:\\y\\b.py'), 'python');
    assert.equal(pickLightLanguage('c.md'), 'markdown');
    assert.equal(pickLightLanguage('no.ext.yaml'), 'yaml');
    assert.equal(pickLightLanguage('svG'), 'xml'); // 大小写不敏感
    // 未知名回落纯文本（不高亮）
    assert.equal(pickLightLanguage('a.unknownext'), '');
    assert.equal(pickLightLanguage(''), '');
    // 日志/csv 明确不高亮（大文件为主，高亮纯开销）
    assert.equal(pickLightLanguage('run.log'), 'plain');
});

test('formatLightMeta：编码 / 换行 / 尺寸拼接', () => {
    assert.equal(formatLightMeta({enc: 'utf-8', eol: 'crlf', size: 2048}), 'UTF-8 · CRLF · 2.0 KB');
    assert.equal(formatLightMeta({enc: 'gbk', size: 512}), 'GBK · 512 B');
    assert.equal(formatLightMeta({size: 3145728}), '3.0 MB');
    assert.equal(formatLightMeta(null), '');
    assert.equal(formatLightMeta({}), '');
});
