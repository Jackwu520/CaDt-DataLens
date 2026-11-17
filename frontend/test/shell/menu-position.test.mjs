// menu-position.test.mjs —— 共享右键菜单定位纯函数：
// 上翻锚定（底边贴锚点顶边、留 6px 间隙）/ 常规 x,y / 视口夹取。

import test from 'node:test';
import assert from 'node:assert/strict';
import {computeMenuPosition} from '../../src/shell/contextmenu.js';

test('computeMenuPosition：上翻锚定贴锚点顶边，留 6px 间隙', () => {
    const pos = computeMenuPosition({
        x: 0, y: 0, width: 400, height: 300,
        viewportWidth: 1200, viewportHeight: 900, margin: 8,
        anchorAbove: {left: 100, top: 700, right: 180, bottom: 730},
    });
    assert.deepEqual(pos, {left: 100, top: 394});
});

test('computeMenuPosition：上方放不下时夹到顶边 margin', () => {
    const pos = computeMenuPosition({
        x: 0, y: 0, width: 400, height: 300,
        viewportWidth: 1200, viewportHeight: 900, margin: 8,
        anchorAbove: {left: 100, top: 200},
    });
    assert.deepEqual(pos, {left: 100, top: 8});
});

test('computeMenuPosition：无锚点时用 x/y，贴边与越界统一夹取', () => {
    const base = {width: 200, height: 100, viewportWidth: 800, viewportHeight: 600, margin: 8};
    assert.deepEqual(computeMenuPosition({...base, x: 100, y: 120}), {left: 100, top: 120});
    assert.deepEqual(computeMenuPosition({...base, x: 700, y: 580}), {left: 592, top: 492});
    assert.deepEqual(computeMenuPosition({...base, x: -20, y: 0}), {left: 8, top: 8});
});
