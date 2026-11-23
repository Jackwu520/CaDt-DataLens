// popover-position.test.mjs：锚点浮层定位的纯逻辑测试（node:test，手写桩，viewport 注入避免依赖 window）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {placePopover} from '../../src/core/popover-position.js';

function fakeEl(w, h) {
    return {style: {}, offsetWidth: w, offsetHeight: h};
}
function fakeAnchor(left, top, width, height) {
    return {
        getBoundingClientRect: () => ({
            left, top, width, height, right: left + width, bottom: top + height,
        }),
    };
}

const VIEW = {width: 800, height: 600};

test('默认：左对齐、底部放得下就放下方，并写回样式', () => {
    const el = fakeEl(200, 100);
    const pos = placePopover(el, fakeAnchor(100, 50, 40, 20), {viewport: VIEW});
    assert.deepEqual(pos, {left: 100, top: 74}); // 50+20+4
    assert.equal(el.style.left, '100px');
    assert.equal(el.style.top, '74px');
});

test('底部放不下且上方有空间：翻到上方', () => {
    const el = fakeEl(200, 100);
    const pos = placePopover(el, fakeAnchor(100, 500, 40, 20), {viewport: VIEW});
    assert.equal(pos.top, 396); // 500 - 100 - 4
});

test('水平右对齐越界被钳制到左边距', () => {
    const el = fakeEl(200, 100);
    const pos = placePopover(el, fakeAnchor(100, 50, 40, 20), {align: 'right', viewport: VIEW});
    assert.equal(pos.left, 8); // 140 - 200 = -60 → 钳到 margin 8
});

test('水平居中对齐', () => {
    const el = fakeEl(100, 40);
    const pos = placePopover(el, fakeAnchor(100, 50, 40, 20), {align: 'center', viewport: VIEW});
    assert.equal(pos.left, 70); // 100 + 40/2 - 50
});

test('placement:top 强制放上方；margin/gap 可配置', () => {
    const el = fakeEl(100, 40);
    const pos = placePopover(el, fakeAnchor(100, 300, 40, 20), {placement: 'top', margin: 20, gap: 10, viewport: VIEW});
    assert.equal(pos.top, 250); // 300 - 40 - 10
    assert.equal(pos.left, 100); // 在 20..(800-100-20) 之间
});

test('入参不全返回 null，不做任何写入', () => {
    const el = fakeEl(100, 40);
    assert.equal(placePopover(null, fakeAnchor(0, 0, 10, 10)), null);
    assert.equal(placePopover(el, null), null);
});
