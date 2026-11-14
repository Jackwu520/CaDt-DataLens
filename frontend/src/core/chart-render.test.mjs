// chart-render.js 的纯逻辑测试：option 白名单校验、主题注入、强制边界。
// renderEchartsToSvg 依赖浏览器（window.echarts / SSR），由浏览器冒烟覆盖，不在 node --test 跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyThemeToOption, validateEchartsOption} from './chart-render.js';

const COLORS = {
    text: '#1f2328', muted: '#6b7280', panel: '#f4f6f8', panel2: '#fff', bg: '#eef1f5',
    border: 'rgba(0,0,0,.24)', accent: '#4f8cff', onAccent: '#fff',
    green: '#2da44e', red: '#cf222e', warn: '#bf8700',
};

test('validateEchartsOption 拒绝非 JSON / 非对象 / 超限', () => {
    assert.equal(validateEchartsOption('not json').ok, false);
    assert.equal(validateEchartsOption('[1,2]').ok, false);
    assert.equal(validateEchartsOption('42').ok, false);
    assert.equal(validateEchartsOption('').ok, false);
    assert.equal(validateEchartsOption(null).ok, false);
    // 嵌套过深
    let deep = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) { cursor.child = {}; cursor = cursor.child; }
    assert.equal(validateEchartsOption(JSON.stringify(deep)).ok, false);
    // 节点过多
    const huge = {data: []};
    for (let i = 0; i < 25000; i++) huge.data.push(i);
    assert.equal(validateEchartsOption(JSON.stringify(huge)).ok, false);
});

test('validateEchartsOption 拒绝 formatter / rich 字段（任意层级）', () => {
    assert.equal(validateEchartsOption('{"series":[{"type":"bar","formatter":"function(x){return x}"}]}').ok, false);
    assert.equal(validateEchartsOption('{"label":{"rich":{"a":{"b":1}}}}').ok, false);
    assert.equal(validateEchartsOption('{"tooltip":{"valueFormatter":"()=>x"}}').ok, true);
});

test('validateEchartsOption 拒绝外链资源，放行正常 option', () => {
    assert.equal(validateEchartsOption('{"graphic":{"elements":[{"type":"image","style":{"image":"https://evil/x.png"}}]}}').ok, false);
    assert.equal(validateEchartsOption('{"graphic":{"elements":[{"type":"image","style":{"image":"//evil/x.png"}}]}}').ok, false);
    const ok = validateEchartsOption('{"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]}');
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.option.series[0].data, [1, 2]);
});

test('applyThemeToOption 强制关动画、透明背景、注入调色板与文本色', () => {
    const option = {series: [{type: 'bar', data: [1]}], animation: true, backgroundColor: 'transparent'};
    applyThemeToOption(option, COLORS);
    assert.equal(option.animation, false);
    assert.equal(option.animationDuration, 0);
    assert.equal(option.backgroundColor, 'transparent');
    assert.equal(option.textStyle.color, COLORS.text);
    assert.deepEqual(option.color, [COLORS.accent, COLORS.green, COLORS.warn, COLORS.red, COLORS.muted, COLORS.border]);
});

test('applyThemeToOption 保留模型显式色值并解析 var(--x) 字符串', () => {
    const option = {
        textStyle: {color: '#ff0000'},
        series: [{type: 'pie', itemStyle: {color: 'var(--accent)'}, data: [{'name': 'A', 'value': 1}]}],
        xAxis: {axisLine: {lineStyle: {color: 'var(--border, #ccc)'}}},
        yAxis: {name: 'var(--unknown-var, #0aa)'},
    };
    applyThemeToOption(option, COLORS);
    assert.equal(option.textStyle.color, '#ff0000', '模型显式指定的颜色不动');
    assert.equal(option.series[0].itemStyle.color, COLORS.accent);
    assert.equal(option.xAxis.axisLine.lineStyle.color, COLORS.border);
    assert.equal(option.yAxis.name, '#0aa', '未知变量取 var() 兜底值');
});
