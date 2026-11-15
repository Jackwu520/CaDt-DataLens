// core/tooltip.test.mjs：全局 tooltip 显示时机的护栏（只测纯函数，不引 DOM）。
// 产品规则（2026-11-16 用户反馈「鼠标一放上去就弹很打扰」）：
// 1) 普通 data-tip 必须「停留」才出现——鼠标扫过一排按钮时一个都不该弹；
// 2) 设置页 ⓘ 说明点（.info-tip）必须立即出现——用户是明确来求解释的，等一秒像没反应；
// 3) 气泡还在屏上时切到相邻锚点立即换内容，不在两个相邻图标之间空等；
// 4) 气泡刚消失后的热窗口里再贴到别的锚点只等 RESHOW（Windows TTDT_RESHOW 语义）。
// 基准：Windows UX 指南 initial 0.5s / reshow 0.1s；macOS NSInitialToolTipDelay 1s。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTipDelay, SHOW_DELAY_MS, RESHOW_DELAY_MS } from './tooltip.js';

test('普通 tooltip 走「停留」窗口，且窗口不能被悄悄调回悬停即弹', () => {
    assert.equal(resolveTipDelay(), SHOW_DELAY_MS);
    assert.ok(SHOW_DELAY_MS >= 500, '停留窗口 ' + SHOW_DELAY_MS + 'ms 太短，等于悬停即弹');
});

test('热窗口内的再次显示比首次快，但不能是 0（沿排浏览与乱扫要区分开）', () => {
    assert.equal(resolveTipDelay({ warm: true }), RESHOW_DELAY_MS);
    assert.ok(RESHOW_DELAY_MS > 0, '热窗口秒出＝扫过就有，和这次要治的毛病一样');
    assert.ok(RESHOW_DELAY_MS < SHOW_DELAY_MS, '热窗口必须明显短于首次停留窗口');
});

test('优先级：气泡还在屏上 > 热窗口 > 首次停留', () => {
    assert.equal(resolveTipDelay({ warm: true, showing: true }), 0);
    assert.equal(resolveTipDelay({ warm: false, showing: false }), SHOW_DELAY_MS);
});

test('设置页 ⓘ 说明点立即出现', () => {
    assert.equal(resolveTipDelay({ instant: true }), 0);
    assert.equal(resolveTipDelay({ instant: true, warm: true }), 0);
});

test('data-tip-delay 显式覆盖优先于其它所有规则', () => {
    assert.equal(resolveTipDelay({ delayAttr: '0', instant: false }), 0);
    assert.equal(resolveTipDelay({ delayAttr: '120', showing: true }), 120);
    assert.equal(resolveTipDelay({ delayAttr: '1500', instant: true, warm: true }), 1500);
});

test('data-tip-delay 垃圾值（空/非数字/负数）忽略，回落默认窗口', () => {
    for (const bad of ['', '   ', 'abc', '-1', 'NaN', null, undefined]) {
        assert.equal(resolveTipDelay({ delayAttr: bad }), SHOW_DELAY_MS, '应忽略 ' + JSON.stringify(bad));
    }
});
