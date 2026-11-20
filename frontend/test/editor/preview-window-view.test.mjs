// preview-window-view：实时预览外置窗纯函数测试（形态判定与清洗口径传递）。
// 规则：原始 HTML 不执行是硬要求——FORBID 配置（script/iframe/事件属性）必须
// 随清洗调用一起传给 DOMPurify；配置留在模块（PREVIEW_SANITIZE_CONFIG），实例可注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {pickPreviewKind, sanitizePreviewHtml, PREVIEW_SANITIZE_CONFIG} from '../../src/editor/preview-window-view.js';

test('pickPreviewKind：支持形态判定', () => {
    assert.equal(pickPreviewKind('notes.md'), 'markdown');
    assert.equal(pickPreviewKind('README.MD'), 'markdown'); // 大小写不敏感
    assert.equal(pickPreviewKind('page.html'), 'html');
    assert.equal(pickPreviewKind('D:\\x\\icon.svg'), 'svg');
    assert.equal(pickPreviewKind('pic.png'), 'image');
    assert.equal(pickPreviewKind('data.json'), null);
    assert.equal(pickPreviewKind('a.txt'), null);
    assert.equal(pickPreviewKind(''), null);
});

test('sanitizePreviewHtml：透传源码并携带 FORBID 配置，注入实例可测', () => {
    let seen = null;
    const fake = (html, config) => { seen = {html, config}; return '<p>clean</p>'; };
    const out = sanitizePreviewHtml('<p onclick="x()"><script>alert(1)</script></p>', fake);
    assert.equal(out, '<p>clean</p>');
    assert.equal(seen.html, '<p onclick="x()"><script>alert(1)</script></p>');
    assert.ok(seen.config.FORBID_TAGS.includes('script'), 'FORBID_TAGS 必须含 script');
    assert.ok(seen.config.FORBID_TAGS.includes('iframe'), 'FORBID_TAGS 必须含 iframe');
    assert.ok(seen.config.FORBID_ATTR.includes('onerror'), 'FORBID_ATTR 必须含 onerror');
    // 与冻结口径一致：外部拿到的 PREVIEW_SANITIZE_CONFIG 就是运行时口径
    assert.deepEqual(seen.config, PREVIEW_SANITIZE_CONFIG);
    // 无注入且无实例（Node 环境）：原样返回，不抛错
    assert.equal(sanitizePreviewHtml('<b>x</b>', null), '<b>x</b>');
});
