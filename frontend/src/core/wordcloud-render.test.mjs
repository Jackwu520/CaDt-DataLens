// wordcloud-render.js 的纯逻辑测试：```wordcloud 校验、调色板、SVG 拼装。
// SSR / d3-cloud 真实布局依赖浏览器（canvas / dynamic import），由浏览器冒烟覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleWordCloudSvg,
    paletteFor,
    validateWordCloudSpec,
    WORDCLOUD_LIMITS,
} from './wordcloud-render.js';

const COLORS = {
    text: '#1f2328', muted: '#6b7280', panel: '#f4f6f8', panel2: '#fff', bg: '#eef1f5',
    border: 'rgba(0,0,0,.24)', accent: '#4f8cff', onAccent: '#fff',
    green: '#2da44e', red: '#cf222e', warn: '#bf8700',
};

test('validateWordCloudSpec 放行合法词表并归一化 value', () => {
    const out = validateWordCloudSpec('{"words":[{"text":"解析","value":30},{"text":"缓存"},{"text":"x","value":-5}]}');
    assert.equal(out.ok, true);
    assert.deepEqual(out.words.map((w) => w.value), [30, 1, 1], '缺省 value=1，负值按 1');
});

test('validateWordCloudSpec 拒绝非 JSON / 空 words / 超上限 / 缺 text', () => {
    assert.equal(validateWordCloudSpec('nope').ok, false);
    assert.equal(validateWordCloudSpec('{"words":[]}').ok, false);
    assert.equal(validateWordCloudSpec('{}').ok, false);
    const many = {words: []};
    for (let i = 0; i <= WORDCLOUD_LIMITS.maxWords; i++) many.words.push({text: 'w' + i});
    assert.equal(validateWordCloudSpec(JSON.stringify(many)).ok, false);
    assert.equal(validateWordCloudSpec('{"words":[{"value":2}]}').ok, false);
    assert.equal(validateWordCloudSpec('{"words":[{"text":""}]}').ok, false);
});

test('paletteFor 按权重排名分色，最高权重拿 accent', () => {
    const sorted = [{text: 'a', value: 30}, {text: 'b', value: 20}, {text: 'c', value: 10}, {text: 'd', value: 5}, {text: 'e', value: 1}, {text: 'f', value: 0}];
    const map = paletteFor(sorted, COLORS);
    assert.equal(map.get('a'), COLORS.accent);
    assert.equal(map.get('f'), COLORS.muted);
    assert.ok(map.get('c') !== undefined);
});

test('assembleWordCloudSvg 产出静态 SVG：viewBox 按实际边界，无脚本', () => {
    const layout = [
        {text: '解析', size: 30, x: 320, y: 180},
        {text: '缓存', size: 14, x: 100, y: 60},
        {text: '虚拟滚动', size: 11, x: 500, y: 300},
    ];
    const svg = assembleWordCloudSvg(layout, COLORS);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.includes('viewBox="'), '必须有 viewBox');
    assert.ok(!svg.includes('viewBox="0 0 640 360"'), 'viewBox 不应是写死的 640×360');
    assert.match(svg, /font-size="30"/);
    assert.match(svg, /fill="#4f8cff"/, '最大词用 accent');
    assert.ok(svg.includes('dominant-baseline="central"'));
    assert.ok(svg.includes('aria-label="词云：3 个词"'));
    assert.ok(!/<script/i.test(svg), '产物不得含脚本');
});
