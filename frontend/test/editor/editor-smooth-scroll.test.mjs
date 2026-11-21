// editor-smooth-scroll.test.mjs：滚轮平滑滚动的纯逻辑护栏。
// 风格解析 / 三种算法收敛 / 累积目标 / 边界钳制——跟手手感的核心不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCROLL_STYLES, DEFAULT_SCROLL_STYLE, resolveScrollStyle, styleOf,
    expStep, easeOutStep, clampScrollTarget, createEditorSmoothScroll,
} from '../../src/editor/editor-smooth-scroll.js';

// Node 无 rAF：挂一个不真正执行的桩，hook 逻辑只依赖 id 与 cancel 存在。
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

// 极简 mock Ace：只提供 hook 需要的 on/off / session / renderer。
function mockAce(opts = {}) {
    const listeners = {};
    let scrollTop = opts.scrollTop || 0;
    return {
        listeners,
        session: {
            getScrollTop: () => scrollTop,
            setScrollTop: (v) => { scrollTop = v; },
            getScreenLength: () => opts.screenLength || 100,
        },
        renderer: {lineHeight: 16, scroller: {clientHeight: 400}},
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
        get scrollTop() { return scrollTop; },
    };
}

test('风格表：四种风格、默认标准、label 无字母代号', () => {
    assert.equal(DEFAULT_SCROLL_STYLE, 'standard');
    assert.deepEqual(SCROLL_STYLES.map((s) => s.value), ['standard', 'swift', 'brisk', 'off']);
    for (const s of SCROLL_STYLES) {
        assert.ok(s.label && !/^[A-F]$/.test(s.label), `label 是正式名字而非字母：${s.label}`);
    }
});

test('resolveScrollStyle：默认 / 未知 / 旧布尔兼容', () => {
    assert.equal(resolveScrollStyle(undefined), 'standard', '未设置默认标准');
    assert.equal(resolveScrollStyle({}), 'standard');
    assert.equal(resolveScrollStyle({scrollStyle: 'swift'}), 'swift');
    assert.equal(resolveScrollStyle({scrollStyle: 'bogus'}), 'standard', '未知值回落默认');
    assert.equal(resolveScrollStyle({smoothScroll: false}), 'off', '旧布尔 false = 关闭');
    assert.equal(resolveScrollStyle({smoothScroll: true}), 'standard', '旧布尔 true = 默认');
});

test('styleOf：返回算法参数', () => {
    assert.equal(styleOf({scrollStyle: 'standard'}).mode, 'exp');
    assert.equal(styleOf({scrollStyle: 'standard'}).factor, 0.5);
    assert.equal(styleOf({scrollStyle: 'swift'}).factor, 0.7);
    assert.equal(styleOf({scrollStyle: 'brisk'}).mode, 'duration');
    assert.equal(styleOf({scrollStyle: 'brisk'}).duration, 80);
    assert.equal(styleOf({scrollStyle: 'off'}).mode, 'off');
});

test('expStep: 单调收敛、到位吸附', () => {
    let cur = 0;
    for (let i = 0; i < 30; i++) {
        const next = expStep(cur, 120, 1000 / 60, 0.5);
        assert.ok(next >= cur && next <= 120, `单调 @${i}: ${cur}->${next}`);
        cur = next;
    }
    assert.equal(cur, 120, '最终吸附到目标');
});

test('expStep: 迅捷(0.7) 比 标准(0.5) 快', () => {
    let std = 0, swift = 0;
    for (let i = 0; i < 3; i++) {
        std = expStep(std, 200, 1000 / 60, 0.5);
        swift = expStep(swift, 200, 1000 / 60, 0.7);
    }
    assert.ok(swift > std, `3 帧后迅捷 ${swift.toFixed(1)} > 标准 ${std.toFixed(1)}`);
});

test('expStep: 帧率无关（大 dt 逼近更多）', () => {
    const oneBig = expStep(0, 200, 100, 0.5);
    let stepped = 0;
    for (let i = 0; i < 6; i++) stepped = expStep(stepped, 200, 1000 / 60, 0.5);
    assert.ok(Math.abs(oneBig - stepped) < 20, `100ms ≈ 6 帧：${oneBig.toFixed(1)} vs ${stepped.toFixed(1)}`);
});

test('expStep: 支持向上逼近（target < current）', () => {
    const v = expStep(200, 100, 16, 0.5);
    assert.ok(v < 200 && v >= 100, `向下移动：${v}`);
});

test('easeOutStep: 端点与到时长即终值', () => {
    assert.equal(easeOutStep(0, 120, 0, 80), 0);
    assert.equal(easeOutStep(0, 120, 80, 80), 120);
    assert.equal(easeOutStep(0, 120, 999, 80), 120);
    assert.ok(easeOutStep(0, 120, 40, 80) > 60, 'easeOut 前半程过半');
});

test('clampScrollTarget: 上下界钳制', () => {
    assert.equal(clampScrollTarget(100, 40, 500), 140);
    assert.equal(clampScrollTarget(480, 100, 500), 500);
    assert.equal(clampScrollTarget(20, -100, 500), 0);
    assert.equal(clampScrollTarget(0, -10, 0), 0);
    assert.equal(clampScrollTarget(NaN, 40, 300), 40);
});

test('hookAce: 注册 mousewheel 监听、幂等、unhook 摘除', () => {
    const sc = createEditorSmoothScroll({getSettings: () => ({scrollStyle: 'standard'}), getDocs: () => []});
    const ace = mockAce();
    sc.hookAce(ace);
    assert.equal(ace.listeners.mousewheel.length, 1);
    sc.hookAce(ace);
    assert.equal(ace.listeners.mousewheel.length, 1, '重复 hook 幂等');
    assert.ok(Array.isArray(ace.listeners.changeSession));
    assert.ok(Array.isArray(ace.listeners.destroy));
    sc.unhookAce(ace);
    assert.equal(ace.listeners.mousewheel.length, 0);
});

test('wheel 监听：关闭 / ctrl / 纯横向 / 到边界都不拦截', () => {
    let settings = {scrollStyle: 'off'};
    const sc = createEditorSmoothScroll({getSettings: () => settings, getDocs: () => []});
    const ace = mockAce({scrollTop: 100});
    sc.hookAce(ace);
    const handler = ace.listeners.mousewheel[0];
    const mkEvent = (over = {}) => ({
        wheelY: 60, wheelX: 0, speed: 4,
        getAccelKey: () => false,
        preventDefault() { this.prevented = true; },
        ...over,
    });
    let e = mkEvent(); handler(e); assert.ok(!e.prevented, '关闭不拦截');
    settings = {scrollStyle: 'standard'};
    e = mkEvent({getAccelKey: () => true}); handler(e); assert.ok(!e.prevented, 'ctrl+wheel 不拦截');
    e = mkEvent({wheelY: 0, wheelX: 60}); handler(e); assert.ok(!e.prevented, '纯横向不拦截');
    sc.unhookAce(ace);
    const topAce = mockAce({scrollTop: 0});
    sc.hookAce(topAce);
    const e2 = {wheelY: -60, wheelX: 0, speed: 4, getAccelKey: () => false, preventDefault() { this.prevented = true; }};
    topAce.listeners.mousewheel[0](e2);
    assert.ok(!e2.prevented, '到顶边界不拦截');
    sc.unhookAce(topAce);
});

test('wheel 监听：三种风格都拦截并累积目标', () => {
    for (const style of ['standard', 'swift', 'brisk']) {
        const sc = createEditorSmoothScroll({getSettings: () => ({scrollStyle: style}), getDocs: () => []});
        const ace = mockAce({scrollTop: 100, screenLength: 100});
        sc.hookAce(ace);
        const handler = ace.listeners.mousewheel[0];
        const mkE = () => ({wheelY: 60, wheelX: 0, speed: 4, getAccelKey: () => false, preventDefault() { this.prevented = true; }});
        const e1 = mkE(); handler(e1);
        assert.ok(e1.prevented, `${style} 拦截原生`);
        assert.equal(ace._smoothTarget, 340, `${style} 第一格目标`);
        const e2 = mkE(); handler(e2);
        assert.equal(ace._smoothTarget, 580, `${style} 第二格在目标上累积`);
        sc.clearAnim(ace);
        sc.unhookAce(ace);
    }
});
