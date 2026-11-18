// explorer-reveal.test.mjs —— 文件树「只垂直 reveal、横向滚动条不动」的护栏。
// 对齐 IDEA：打开文件把当前行滚进垂直视野即可，不该挪动横向滚动条。
// 纯函数 verticalScrollFor 决定垂直目标；revealRowVertically 用它且不碰 scrollLeft。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verticalScrollFor} from '../../src/explorer/explorer.js';

test('verticalScrollFor：行在可视区上方 → 贴顶', () => {
    // 行 0–20，可视区从 100 开始
    assert.equal(verticalScrollFor(0, 20, 100, 300), 0);
});

test('verticalScrollFor：行在可视区下方 → 贴底', () => {
    // 行 400–426，可视区 100–400（viewH=300），行底超出 26
    assert.equal(verticalScrollFor(400, 426, 100, 300), 126);
});

test('verticalScrollFor：行完全可见 → 保持当前 scrollTop', () => {
    assert.equal(verticalScrollFor(150, 176, 100, 300), 100);
    // 行正好贴住上下边界也算可见
    assert.equal(verticalScrollFor(100, 400, 100, 300), 100);
});

test('verticalScrollFor：viewH<=0 兜底返回当前 scrollTop（不产生非法滚动）', () => {
    assert.equal(verticalScrollFor(0, 20, 50, 0), 50);
    assert.equal(verticalScrollFor(0, 20, 50, -10), 50);
});

test('revealRowVertically 接线：文件树不再用 scrollIntoView 挪横向', () => {
    // 读源码确认三处 reveal 都走 revealRowVertically，且文件树区域无 scrollIntoView
    const src = readFileSync(new URL('../../src/explorer/explorer.js', import.meta.url), 'utf8');
    const treeReveals = src.match(/revealRowVertically\(body, row\)/g) || [];
    assert.ok(treeReveals.length >= 3, 'scrollToActive/selectPath/selectPaths 三处应走 revealRowVertically');
    // 除注释外不应再有 scrollIntoView 调用
    const calls = (src.match(/\.scrollIntoView\(/g) || []).length;
    assert.equal(calls, 0, '文件树不应再调用 scrollIntoView（它会连横向一起滚动）');
});
