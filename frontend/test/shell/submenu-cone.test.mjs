// submenu-cone.test.mjs —— 子菜单预测锥纯函数：
// 锥 = 「子菜单近边两端角 + 父项行对侧底角」的三角走廊 ∪ 父项行 ∪ 子菜单面板。
// 指针在锥内 → 延迟收起（斜向走向子菜单扫过兄弟行不杀子菜单）；锥外 → 立即收起。

import test from 'node:test';
import assert from 'node:assert/strict';
import {inSubmenuCone, pointInRect, SUBMENU_CONE_CLOSE_DELAY_MS} from '../../src/shell/contextmenu.js';

// 典型布局：菜单面板 x∈[100,300]，锚点行 y∈[40,60]；子菜单右开紧贴 x∈[302,500]
const ANCHOR = {left: 100, top: 40, right: 300, bottom: 60, width: 200, height: 20};
const SUB = {left: 302, top: 36, right: 500, bottom: 200, width: 198, height: 164};

test('pointInRect：内外与退化矩形', () => {
    const rect = {left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10};
    assert.equal(pointInRect(5, 5, rect), true);
    assert.equal(pointInRect(11, 5, rect), false);
    assert.equal(pointInRect(5, 5, {left: 0, top: 0, right: 10, bottom: 10, width: 0, height: 10}), false);
    assert.equal(pointInRect(5, 5, null), false);
});

test('预测锥：锚点行与子菜单面板内恒为安全', () => {
    assert.equal(inSubmenuCone(250, 50, ANCHOR, SUB), true); // 锚点行上
    assert.equal(inSubmenuCone(350, 100, ANCHOR, SUB), true); // 子菜单面板内
});

test('预测锥：斜向走向子菜单扫过兄弟行是安全区', () => {
    // 锚点行 (250,50) 斜向移向子菜单的必经点
    assert.equal(inSubmenuCone(240, 68, ANCHOR, SUB), true);
    assert.equal(inSubmenuCone(230, 85, ANCHOR, SUB), true);
    assert.equal(inSubmenuCone(250, 150, ANCHOR, SUB), true); // 走廊深处（子菜单下缘以内）
});

test('预测锥：直奔左侧兄弟项立即判出锥外', () => {
    assert.equal(inSubmenuCone(120, 105, ANCHOR, SUB), false); // 左下深处
    assert.equal(inSubmenuCone(105, 64, ANCHOR, SUB), false); // 锚点行左端正下方
    assert.equal(inSubmenuCone(150, 30, ANCHOR, SUB), false); // 锚点行上方
    assert.equal(inSubmenuCone(250, 220, ANCHOR, SUB), false); // 菜单底部（越过子菜单下缘）
});

test('预测锥：子菜单左开（视口翻转）时镜像成立', () => {
    const anchorR = {left: 302, top: 40, right: 500, bottom: 60, width: 198, height: 20};
    const subL = {left: 100, top: 36, right: 298, bottom: 200, width: 198, height: 164};
    assert.equal(inSubmenuCone(310, 68, anchorR, subL), true); // 斜向走向左开子菜单
    assert.equal(inSubmenuCone(450, 105, anchorR, subL), false); // 直奔右侧兄弟项
    assert.equal(inSubmenuCone(350, 100, anchorR, subL), true); // 子菜单面板内
});

test('预测锥：退化子菜单矩形退化为纯矩形判定', () => {
    const degenerate = {left: 302, top: 36, right: 302, bottom: 200, width: 0, height: 164};
    assert.equal(inSubmenuCone(350, 100, ANCHOR, degenerate), false);
    assert.equal(inSubmenuCone(250, 50, ANCHOR, degenerate), true); // 仍落在锚点行上
});

test('延迟收起时长为正数', () => {
    assert.equal(typeof SUBMENU_CONE_CLOSE_DELAY_MS, 'number');
    assert.ok(SUBMENU_CONE_CLOSE_DELAY_MS > 0);
});
