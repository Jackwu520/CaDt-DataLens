// wordcloud-render.js 的纯逻辑测试：```wordcloud 校验、调色板、SVG 拼装。
// SSR / d3-cloud 真实布局依赖浏览器（canvas / dynamic import），由浏览器冒烟覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleWordCloudSvg,
    estimateTextWidth,
    packWordCloudLayout,
    paletteFor,
    sizedWords,
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

test('estimateTextWidth 中文按 1em、ASCII 按 0.55em，空串至少 1em', () => {
    assert.equal(estimateTextWidth('解析', 20), 40);
    assert.equal(estimateTextWidth('abc', 20), 33);
    assert.equal(estimateTextWidth('', 20), 20);
});

test('sizedWords 字号落在 minFont..maxFont，最大词拿 maxFont', () => {
    const sorted = [{text: 'a', value: 30}, {text: 'b', value: 20}, {text: 'c', value: 10}];
    const sized = sizedWords(sorted);
    assert.equal(sized[0].size, WORDCLOUD_LIMITS.maxFont);
    assert.equal(sized[2].size, WORDCLOUD_LIMITS.minFont);
    for (const w of sized) {
        assert.ok(w.size >= WORDCLOUD_LIMITS.minFont && w.size <= WORDCLOUD_LIMITS.maxFont);
    }
});

test('packWordCloudLayout 铺开且不压字（无 canvas 兜底）', () => {
    const words = sizedWords([
        {text: '解析', value: 30}, {text: '缓存', value: 24}, {text: 'lazy', value: 18},
        {text: '会话', value: 16}, {text: '虚拟滚动', value: 14}, {text: '审批', value: 12},
        {text: '标签页', value: 10}, {text: '补丁', value: 9}, {text: '主题变量', value: 8},
        {text: '编码检测', value: 7}, {text: '工具卡', value: 6}, {text: '折叠', value: 5},
    ]);
    const layout = packWordCloudLayout(words);
    assert.equal(layout.length, words.length, '每个词都要出现');
    const boxes = layout.map((w) => {
        const bw = estimateTextWidth(w.text, w.size) + 6;
        const bh = w.size * 1.15 + 6;
        assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y), '坐标必须是有限值');
        return {x0: w.x - bw / 2, y0: w.y - bh / 2, x1: w.x + bw / 2, y1: w.y + bh / 2};
    });
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
            assert.ok(!overlap, `第 ${i} 与第 ${j} 个词的矩形重叠`);
        }
    }
    assert.ok(new Set(layout.map((w) => w.x)).size > 3, '不能退化成一列竖排');
});

test('assembleWordCloudSvg 的中文宽度估算不再按 0.35em 低估', () => {
    // 单个 30px 的「虚拟滚动」宽约 120px，viewBox 必须容得下左右各 60px
    const svg = assembleWordCloudSvg([{text: '虚拟滚动', size: 30, x: 0, y: 0}], COLORS);
    const m = svg.match(/viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/);
    assert.ok(m, '必须算出 viewBox');
    assert.ok(Number(m[3]) >= 120, 'viewBox 宽度须覆盖四个汉字');
});
