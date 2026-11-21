// md-preview-anchor.test.mjs —— Markdown 预览文内锚点跳转的接线守卫。
//
// 背景（2026-11-22 用户实测）：内置教程.md 目录点击没反应；Ctrl+点击弹出 Edge
// 的 ERR_CONNECTION_REFUSED（wails.localhost 拒绝连接）。根因有两层：
//   1) markdown-it 不给标题生成 id，#锚点找不到目标元素；
//   2) 预览对 #href 直接 return，交给 WebView2 默认导航，Ctrl+点击被当外链新窗口打开。
// 修复：标题生成 GitHub 风格 id（core/markdown.js）；预览一律 preventDefault，
// #锚点在预览滚动容器内自行定位。这类回归靠源码守卫钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const mdSrc = readFileSync(join(srcRoot, 'core/markdown.js'), 'utf8');
const splitSrc = readFileSync(join(srcRoot, 'editor/editor-split-preview.js'), 'utf8');
const exportSrc = readFileSync(join(srcRoot, 'editor/editor-export-menus.js'), 'utf8');

function slice(text, signature, nextSignature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到：' + signature);
    const rest = text.slice(start + signature.length);
    const next = nextSignature ? rest.indexOf(nextSignature) : -1;
    return next >= 0 ? rest.slice(0, next) : rest;
}

test('共享 markdown 渲染器注册 heading_open 生成 id', () => {
    assert.ok(mdSrc.includes("markdownRenderer.renderer.rules.heading_open"),
        '必须注册 heading_open 规则');
    const body = slice(mdSrc, 'markdownRenderer.renderer.rules.heading_open =');
    assert.ok(body.includes("attrSet('id'"), '标题必须设置 id 属性');
    assert.ok(body.includes('slugifyHeading('), 'id 必须来自 slugifyHeading');
    assert.ok(body.includes('seen.get(slug)'), '重复标题要去重追加序号');
});

test('三处 sanitize 都放行 id 属性', () => {
    // core/markdown.js 的 renderMarkdownHtml
    const htmlBody = slice(mdSrc, 'function renderMarkdownHtml(text, env)');
    assert.ok(/ADD_ATTR:\s*\[[^\]]*'id'/.test(htmlBody), 'renderMarkdownHtml 必须放行 id');
    // editor-export-menus.js 的两处 sanitize
    assert.ok(/ADD_ATTR:\s*\[[^\]]*'id'/.test(exportSrc), '导出菜单的 sanitize 必须放行 id');
    assert.equal((exportSrc.match(/ADD_ATTR:\s*\[[^\]]*'id'/g) || []).length, 2,
        'editor-export-menus.js 两处 sanitize 都要放行 id');
});

test('预览点击一律 preventDefault，#锚点在容器内滚动', () => {
    const clickBody = slice(splitSrc, "wrap.addEventListener('click', (e) => {", "function renderMarkdownPreview");
    // 必须在 href 分支之前就 preventDefault，覆盖 # 锚点（Ctrl+点击也不会外跳）
    const preventAt = clickBody.indexOf('e.preventDefault()');
    const hashAt = clickBody.indexOf("href.startsWith('#')");
    assert.ok(preventAt >= 0, '必须 preventDefault');
    assert.ok(hashAt >= 0, '必须处理 # 锚点');
    assert.ok(preventAt < hashAt, 'preventDefault 必须在 # 分支之前，锚点也不能走默认导航');
    // 锚点在预览滚动容器内自行定位
    assert.ok(clickBody.includes('doc.previewBody.querySelector('), '必须在预览容器内查找锚点目标');
    assert.ok(clickBody.includes('doc.previewScroll.scrollTop = top'), '必须滚动预览容器到目标');
    assert.ok(clickBody.includes('doc.previewScrollTop = Math.round(top)'), '必须同步持久化滚动位置');
});
