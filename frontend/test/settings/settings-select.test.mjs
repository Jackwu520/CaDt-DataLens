// settings-select 纯函数测试：浮层定位（向下 / 向上翻转、触底限高、视口边界）+ 截断 tooltip 文本组装。
import test from 'node:test';
import assert from 'node:assert/strict';
import {SS_POP_LIMITS, computePopWidth, computePopGeometry, optionLabelParts, tipTextFromSpans} from '../../src/settings/settings-select.js';

test('optionLabelParts：data-subtitle 决定两行，普通选项仍是单行', () => {
    assert.deepEqual(optionLabelParts({text: '专业严谨', dataset: {subtitle: '清晰、准确、值得信赖'}}),
        {title: '专业严谨', subtitle: '清晰、准确、值得信赖'});
    assert.deepEqual(optionLabelParts({text: '普通选项', dataset: {}}),
        {title: '普通选项', subtitle: ''});
    assert.deepEqual(optionLabelParts({text: '无 dataset'}), {title: '无 dataset', subtitle: ''});
    assert.deepEqual(optionLabelParts(null), {title: '', subtitle: ''});
});

test('tipTextFromSpans：只保留被截断的片段并 \\n 分行，全未截断返回空串', () => {
    // 单行选项：只有 label 一个片段
    assert.equal(tipTextFromSpans([{text: 'sensenova-6.8-flash-li…', truncated: true}]),
        'sensenova-6.8-flash-li…');
    // 富选项：主截断副未截断 → 只出主；都截断 → 主\n副
    assert.equal(tipTextFromSpans([
        {text: 'deepseek-flash · Deepse…', truncated: true},
        {text: '深度求索官方直连', truncated: false},
    ]), 'deepseek-flash · Deepse…');
    assert.equal(tipTextFromSpans([
        {text: 'deepseek-v4-pro · Deep…', truncated: true},
        {text: '适合复杂推理与长文写作', truncated: true},
    ]), 'deepseek-v4-pro · Deep…\n适合复杂推理与长文写作');
    // 没有任何截断 → 空串（调用方应移除 data-tip，不弹气泡）
    assert.equal(tipTextFromSpans([{text: 'glm-5.3 · SenseNova', truncated: false}]), '');
    assert.equal(tipTextFromSpans([]), '');
    assert.equal(tipTextFromSpans(null), '');
    // 空 text 的截断片段不参与组装
    assert.equal(tipTextFromSpans([{text: '', truncated: true}]), '');
});

const {gap, edge, maxHeight} = SS_POP_LIMITS;
// 触发器在视口中部：{left: 100, top: 300, right: 300, bottom: 330, width: 200}
const rect = (left, top, width = 200, height = 30) => ({left, top, width, height, right: left + width, bottom: top + height});
const viewport = {width: 1280, height: 800};

test('空间充足时向下展开，高度用自然高度且不超过上限', () => {
    const r = rect(100, 300);
    const g = computePopGeometry(r, viewport, 140);
    assert.equal(g.up, false);
    assert.equal(g.height, 140);
    assert.equal(g.top, r.bottom + gap);
    assert.equal(g.left, r.left);
    assert.equal(g.width, r.width);
});

test('选项过多时高度封顶 320px，不再把面板撑高', () => {
    const g = computePopGeometry(rect(100, 200), viewport, 900);
    assert.equal(g.height, maxHeight);
    assert.equal(g.up, false);
    assert.equal(g.top, 200 + 30 + gap);
    assert.ok(g.top + g.height <= viewport.height - edge);
});

test('下方不足且上方更宽裕时向上展开', () => {
    const r = rect(100, 700);
    const g = computePopGeometry(r, viewport, 300);
    assert.equal(g.up, true);
    assert.equal(g.height, 300);
    assert.equal(g.top, r.top - gap - 300);
    assert.ok(g.top >= edge);
});

test('向上展开也触顶时按上方可用空间再收窄，不越出视口', () => {
    const short = {width: 1280, height: 300};
    const r = rect(100, 180);
    const g = computePopGeometry(r, short, 900);
    assert.equal(g.up, true);
    assert.equal(g.height, r.top - gap - edge);
    assert.equal(g.top, edge);
});

test('上下都不足时选空间更大的一侧，浮层始终留在视口内', () => {
    const small = {width: 1280, height: 260};
    const upper = computePopGeometry(rect(100, 120), small, 900);
    assert.equal(upper.up, true); // 上方 106px > 下方 96px
    assert.equal(upper.height, 106);
    assert.equal(upper.top, edge);
    const lower = computePopGeometry(rect(100, 40), small, 900);
    assert.equal(lower.up, false); // 下方 176px > 上方 26px
    assert.equal(lower.height, small.height - 70 - gap - edge);
    for (const g of [upper, lower]) {
        assert.ok(g.top >= edge);
        assert.ok(g.top + g.height <= small.height - edge);
    }
});

test('靠右边界时左移，浮层不超出视口', () => {
    const r = rect(1230, 300, 200);
    const g = computePopGeometry(r, viewport, 200);
    assert.equal(g.width, 200);
    assert.equal(g.left, viewport.width - g.width - edge);
    assert.ok(g.left + g.width <= viewport.width - edge);
});

test('宽度 = max(最小宽度, 触发器宽度)：过窄给最小宽度，宽 select 不再被固定上限压窄', () => {
    assert.equal(computePopWidth(rect(10, 10, 80), viewport), SS_POP_LIMITS.minWidth);
    // 宽触发器（如 JDK 路径下拉，近 900px）展开后与触发器同宽，不再压到旧的 360px
    assert.equal(computePopWidth(rect(10, 10, 900), viewport), 900);
    assert.equal(computePopWidth(rect(10, 10, 400), viewport), 400);
});

test('视口过窄时宽度受视口约束，不溢出屏幕', () => {
    const narrow = {width: 200, height: 600};
    const w = computePopWidth(rect(10, 10, 500), narrow);
    assert.equal(w, narrow.width - edge * 2);
    assert.ok(w <= narrow.width - edge * 2);
});

test('几何结果在所有常规视口下都不越界', () => {
    for (const h of [240, 400, 800, 1200]) {
        for (const top of [8, 60, h / 2, h - 60, h - 20]) {
            for (const natural of [40, 200, 320, 900]) {
                const r = rect(20, Math.max(0, Math.min(top, h - 30)));
                const g = computePopGeometry(r, {width: 900, height: h}, natural);
                assert.ok(g.height >= 0 && g.height <= maxHeight, `height ${g.height}`);
                assert.ok(g.top >= edge, `top ${g.top} @h=${h} top=${top}`);
                assert.ok(g.top + g.height <= h - edge + 0.001, `bottom ${g.top + g.height} @h=${h}`);
                assert.ok(g.left >= edge && g.left + g.width <= 900 - edge + 0.001);
            }
        }
    }
});
