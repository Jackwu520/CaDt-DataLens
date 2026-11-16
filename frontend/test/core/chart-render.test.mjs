// chart-render.js 的纯逻辑测试：option 白名单校验、主题注入、强制边界。
// renderEchartsToSvg 依赖浏览器（window.echarts / SSR），由浏览器冒烟覆盖，不在 node --test 跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyThemeToOption, contrastRatio, enforceReadableText, validateEchartsOption} from '../../src/core/chart-render.js';

const COLORS = {
    text: '#1f2328', muted: '#6b7280', panel: '#f4f6f8', panel2: '#fff', bg: '#eef1f5',
    border: 'rgba(0,0,0,.24)', accent: '#4f8cff', onAccent: '#fff',
    green: '#2da44e', red: '#cf222e', warn: '#bf8700',
};

// 深色主题的实测值（frontend/src/style.css 的 [data-theme=dark] 块）。
const DARK = {
    text: '#bcbec4', muted: '#9da0a8', panel: '#232326', panel2: '#303236', bg: '#1b1c1f',
    border: '#393b40', accent: '#548af7', onAccent: '#fff',
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

// —— 深色主题可读性（ECharts 6 默认配色是给白底设计的，直接搬到深色卡片上会翻车）——

test('applyThemeToOption 把坐标轴默认配色换成主题色', () => {
    const option = {
        xAxis: {type: 'value'},
        yAxis: {type: 'category', data: ['a']},
        series: [{type: 'bar', data: [1]}],
    };
    applyThemeToOption(option, DARK);
    // 分类标签是名字（主信息）→ 正文色；数值刻度（次要信息）→ muted
    assert.equal(option.yAxis.axisLabel.color, DARK.text);
    assert.equal(option.xAxis.axisLabel.color, DARK.muted);
    // 轴线 / 刻度 / 分割线一律走边框色，不再是 ECharts 默认的 #54555a / #dbdee4
    assert.equal(option.xAxis.axisLine.lineStyle.color, DARK.border);
    assert.equal(option.xAxis.axisTick.lineStyle.color, DARK.border);
    assert.equal(option.xAxis.splitLine.lineStyle.color, DARK.border);
    assert.equal(option.xAxis.nameTextStyle.color, DARK.text);
});

test('applyThemeToOption 不给分类轴凭空造分割线', () => {
    const option = {xAxis: {type: 'category', data: ['a']}, yAxis: {type: 'value'}, series: []};
    applyThemeToOption(option, DARK);
    assert.equal(option.xAxis.splitLine, undefined, '分类轴默认不画分割线');
    assert.ok(option.yAxis.splitLine, '数值轴默认有分割线，只换色');
});

test('applyThemeToOption 外侧标签用正文色 + 卡片底色描边，内侧标签不动', () => {
    const option = {
        series: [
            {type: 'bar', data: [1], label: {show: true, position: 'right'}},
            {type: 'pie', data: [{name: 'A', value: 1}], label: {show: true, position: 'inside', color: '#fff'}},
        ],
    };
    applyThemeToOption(option, DARK);
    assert.equal(option.series[0].label.color, DARK.text);
    assert.equal(option.series[0].label.textBorderColor, DARK.panel2, '白描边在深色卡片上会糊成一团');
    assert.equal(option.series[1].label.color, '#fff', '内侧标签压在色块上，背景色未知，保持原样');
});

test('applyThemeToOption 图例与标题文字走主题色', () => {
    const option = {
        title: {text: '标题', subtext: '副标题'},
        legend: {data: ['A']},
        series: [],
    };
    applyThemeToOption(option, DARK);
    assert.equal(option.title.textStyle.color, DARK.text);
    assert.equal(option.title.subtextStyle.color, DARK.muted);
    assert.equal(option.legend.textStyle.color, DARK.text);
});

test('applyThemeToOption 把浅底专用色（#333）在深色主题上换成正文色', () => {
    const option = {
        xAxis: {type: 'category', data: ['a'], axisLabel: {color: '#333'}},
        yAxis: {type: 'value'},
        series: [{type: 'bar', data: [1], label: {show: true, position: 'right', color: '#333'}}],
    };
    applyThemeToOption(option, DARK);
    assert.equal(option.xAxis.axisLabel.color, DARK.text, '深色主题下 #333 不可读 → 换正文色');
    assert.equal(option.series[0].label.color, DARK.text);

    const lightOption = {
        xAxis: {type: 'category', data: ['a'], axisLabel: {color: '#333'}},
        yAxis: {type: 'value'},
        series: [{type: 'bar', data: [1], label: {show: true, position: 'right', color: '#333'}}],
    };
    applyThemeToOption(lightOption, COLORS);
    assert.equal(lightOption.xAxis.axisLabel.color, '#333', '浅色主题下 #333 够清楚 → 保留模型的选择');
    assert.equal(lightOption.series[0].label.color, '#333');
});

test('contrastRatio 认得 hex / rgb / 短写法', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
    assert.equal(Math.round(contrastRatio('#fff', '#fff')), 1);
    assert.ok(Math.abs(contrastRatio('rgb(0, 0, 0)', '#ffffff') - 21) < 0.01);
    assert.equal(contrastRatio('not-a-color', '#fff'), null);
});

test('enforceReadableText 对比度不足时换兜底色，够清楚时不动', () => {
    const node = {color: '#333'};
    enforceReadableText(node, 'color', DARK, DARK.text);
    assert.equal(node.color, DARK.text);
    const ok = {color: '#bcbec4'};
    enforceReadableText(ok, 'color', DARK, DARK.text);
    assert.equal(ok.color, '#bcbec4');
});
