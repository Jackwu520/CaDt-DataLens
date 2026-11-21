// md-preview-scroll.test.mjs —— Markdown 预览滚动持久化的接线守卫。
//
// 背景（2026-11-22 用户实测）：切标签切回来，md 预览的浏览进度没了、跳回顶部；
// 分屏视图还有滚动条 / 不对齐。根因是预览滚动只存在 DOM（doc.previewScroll.scrollTop），
// 而切标签 / 自动保存触发的 renderEditorLayout 会把 pane 整段摘除插回，DOM scrollTop 归零。
//
// 修复契约：
//   · 预览滚动的持久真源是 doc.previewScrollTop（存在 doc 上，不依赖 DOM）；
//   · renderMarkdownPreview 恢复时读 doc.previewScrollTop，不读当前 DOM；
//   · createMarkdownPreview 挂 scroll 监听，纯预览滚动写入 doc.previewScrollTop；
//   · snapshotActiveDoc（切走）/ renderEditorLayout（重建前）capture；
//   · activateDoc（切回，布局就绪后）/ renderEditorLayout（重建后）restore；
//   · 分屏时以 Ace 滚动为真源对齐（mdSyncScrollFromAce），并同步写回持久值。
//
// 这类回归静默——dev 单标签、无自动保存时复现不出，必须有源码守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const splitSrc = readFileSync(join(srcRoot, 'editor/editor-split-preview.js'), 'utf8');
const groupsSrc = readFileSync(join(srcRoot, 'editor/editor-groups.js'), 'utf8');

function sliceTopFunction(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const rest = text.slice(start + signature.length);
    const next = /\nfunction [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

test('renderMarkdownPreview 用 doc.previewScrollTop 恢复，不读当前 DOM scrollTop', () => {
    const body = sliceTopFunction(splitSrc, 'function renderMarkdownPreview(doc, opts = {})');
    assert.ok(body.includes('Number.isFinite(doc.previewScrollTop)'),
        '恢复值必须来自 doc.previewScrollTop（持久真源）');
    assert.ok(/doc\.previewScroll\.scrollTop = scrollTop/.test(body),
        '渲染后必须把持久值写回 DOM');
    // 旧实现是 const scrollTop = doc.previewScroll ? doc.previewScroll.scrollTop : 0（读 DOM）——不能再出现
    assert.ok(!/const scrollTop = doc\.previewScroll \? doc\.previewScroll\.scrollTop/.test(body),
        '不能从当前 DOM scrollTop 读取恢复值（重建后已归零）');
});

test('capturePreviewScroll 把 DOM scrollTop 存进 doc.previewScrollTop', () => {
    const body = sliceTopFunction(splitSrc, 'function capturePreviewScroll(doc)');
    assert.ok(/doc\.previewScrollTop = Math\.round\(doc\.previewScroll\.scrollTop/.test(body),
        'capture 必须把 DOM scrollTop 写入 doc.previewScrollTop');
});

test('restorePreviewScroll：纯预览用持久值，分屏走 Ace 对齐', () => {
    const body = sliceTopFunction(splitSrc, 'function restorePreviewScroll(doc)');
    assert.ok(body.includes('doc.splitActive && doc.splitKind === \'markdown\''),
        '必须区分分屏 / 纯预览');
    assert.ok(body.includes('mdSyncScrollFromAce(doc)'),
        '分屏必须以 Ace 滚动为真源对齐');
    assert.ok(/doc\.previewScroll\.scrollTop = doc\.previewScrollTop/.test(body),
        '纯预览必须用持久值恢复');
});

test('createMarkdownPreview 挂 scroll 监听，纯预览滚动写入持久值', () => {
    const body = sliceTopFunction(splitSrc, 'function createMarkdownPreview(doc)');
    assert.ok(body.includes("addEventListener('scroll'"),
        '必须在创建预览时挂 scroll 监听（纯预览模式也要持久化）');
    assert.ok(/doc\.previewScrollTop = Math\.round\(scroll\.scrollTop/.test(body),
        'scroll 监听必须把滚动位置写入 doc.previewScrollTop');
    assert.ok(body.includes('doc.splitActive && doc.splitKind === \'markdown\''),
        '分屏时跳过（由 hookPreviewScrollSync 接管，避免双写）');
});

test('mdSyncScrollFromAce 同步时回写持久值', () => {
    const body = sliceTopFunction(splitSrc, 'function mdSyncScrollFromAce(doc)');
    assert.ok(/doc\.previewScrollTop = doc\._previewEcho/.test(body),
        '分屏同步预览滚动时必须回写 doc.previewScrollTop，保持持久值与实际一致');
});

test('snapshotActiveDoc 切走时 capture 预览滚动', () => {
    const body = sliceTopFunction(groupsSrc, 'function snapshotActiveDoc()');
    assert.ok(body.includes('capturePreviewScroll(deps.file)'),
        '切标签前必须 capture 当前 doc 的预览滚动');
});

test('activateDoc 切回时（布局就绪后）restore 预览滚动', () => {
    const body = sliceTopFunction(groupsSrc, 'async function activateDoc(doc)');
    assert.ok(body.includes('restorePreviewScroll(doc)'),
        '切回标签后必须 restore 预览滚动');
    // restore 必须在 setTimeout（ace.resize 之后）——布局未就绪时 scrollHeight 读不到
    const restoreAt = body.indexOf('restorePreviewScroll(doc)');
    const setTimeoutAt = body.indexOf('setTimeout(() => {');
    assert.ok(restoreAt > setTimeoutAt && restoreAt >= 0 && setTimeoutAt >= 0,
        'restore 必须位于 setTimeout 内（ace.resize 之后，DOM 布局就绪）');
});

test('renderEditorLayout 重建前后 capture / restore 预览滚动', () => {
    const body = sliceTopFunction(groupsSrc, 'function renderEditorLayout()');
    const captureAt = body.indexOf('capturePreviewScroll(deps.file)');
    const clearAt = body.indexOf("deps.els.editor.textContent = ''");
    const restoreAt = body.indexOf('restorePreviewScroll(deps.file)');
    assert.ok(captureAt >= 0 && clearAt >= 0 && captureAt < clearAt,
        'capture 必须先于整段清空，否则读到归零值');
    assert.ok(restoreAt > clearAt,
        'restore 必须在整段重建之后');
    // 只对活动 doc capture（非活动 doc 隐藏、DOM scrollTop 已归零，读了会覆盖持久值）
    assert.ok(!/for \(const d of deps\.docs\) capturePreviewScroll/.test(body),
        '不能对所有 doc capture——隐藏 doc 的归零值会覆盖持久值');
});
