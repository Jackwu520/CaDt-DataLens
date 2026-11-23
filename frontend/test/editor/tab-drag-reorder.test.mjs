// tab-drag-reorder.test.mjs —— 标签拖动排序的接线守卫。
//
// 背景（用户实测「拖动能拖但换不了」）：让位动画 .drop-gap { margin-left:88px } 在 dragover
// 时把目标标签从鼠标底下推开，drop 落在让位出来的 .etabs 空白区而非标签上；旧实现只在
// 标签自身监听 drop，落点不是标签就没人 preventDefault / 提交排序 → 松手毫无反应。
// 修复：dragover 记录「插到谁前/后」的意图，drop 在标签或标签条兜底处消费同一份意图。
//
// 这些是纯 DOM 事件接线，单测无 WebView2 实拖，走源码守卫；真实拖动已在 dev mock 里
// 用合成 DragEvent 验证（让位动画后落点变 .etabs 仍能正确换序）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/editor/editor-groups.js', import.meta.url)), 'utf8');

function between(startMark, endMark) {
    const a = src.indexOf(startMark);
    assert.ok(a >= 0, '找不到起点：' + startMark);
    const b = src.indexOf(endMark, a + startMark.length);
    assert.ok(b >= 0, '找不到终点：' + endMark);
    return src.slice(a, b);
}

test('dragover 记录独立意图 pendingTabDrop，不依赖 drop 落点元素', () => {
    const block = between('tab.addEventListener(\'dragover\'', 'tab.addEventListener(\'drop\'');
    assert.ok(block.includes('pendingTabDrop = {'),
        'dragover 必须把「插到哪个标签前/后」记入 pendingTabDrop，让位动画后落点变化时仍能排序');
    assert.ok(block.includes('targetId: doc.id') && block.includes('before'),
        '意图要含目标标签 id 与 before 方向');
    assert.ok(block.includes('e.preventDefault()') && block.includes('e.dataTransfer.dropEffect = \'move\''),
        'dragover 仍需 preventDefault 并把 dropEffect 设为 move');
});

test('drop 提交意图，标签与标签条兜底都调用 commitTabDrop', () => {
    const commit = between('function commitTabDrop(gid)', '// ---- app_control 分组动作');
    assert.ok(commit.includes('moveTabInGroup(gid, srcId, pending.targetId, pending.before)'),
        'commitTabDrop 必须用记录的意图调用 moveTabInGroup');
    assert.ok(commit.includes('pendingTabDrop = null') && commit.includes('dragTabId = null'),
        '提交后要清空意图与拖动状态，避免下一次拖放复用旧值');
    // 标签自身 drop + 标签条兜底 drop 两处都要提交
    const tabDrop = between('tab.addEventListener(\'drop\'', 'return tab;');
    assert.ok(tabDrop.includes('commitTabDrop(g.id)'), '标签自身 drop 要提交意图');
    const stripBlock = between('strip.className = \'etabs\'', 'const single =');
    assert.ok(stripBlock.includes("strip.addEventListener('drop'") && stripBlock.includes('commitTabDrop(gid)'),
        '标签条要有 drop 兜底，接住让位动画后落在空白区的 drop');
    assert.ok(stripBlock.includes("strip.addEventListener('dragover'") && stripBlock.includes('e.preventDefault()'),
        '标签条 dragover 兜底要 preventDefault，否则落在空白区的 drop 根本不触发');
});

test('标签条兜底只在内部标签拖动时生效，不干扰外部文件拖放', () => {
    const stripBlock = between('strip.className = \'etabs\'', 'const single =');
    // 两处兜底监听都要先判 dragTabId / dragTabGroupId
    const guards = stripBlock.match(/if \(dragTabId === null \|\| dragTabGroupId !== gid\) return;/g) || [];
    assert.ok(guards.length >= 2,
        '标签条 dragover/drop 兜底都必须先判「本组标签在拖」，否则会误拦外部文件拖放');
});
