// layout-render.js 的纯逻辑测试：```graph 校验、简单分层兜底、SVG 拼装。
// ELK 真实布局依赖浏览器（window.ELK / worker），由浏览器冒烟覆盖，不在 node --test 跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleGraphSvg,
    simpleLayeredLayout,
    validateGraphSpec,
    GRAPH_LIMITS,
} from './layout-render.js';

const COLORS = {
    text: '#1f2328', muted: '#6b7280', panel: '#f4f6f8', panel2: '#fff', bg: '#eef1f5',
    border: 'rgba(0,0,0,.24)', accent: '#4f8cff', onAccent: '#fff',
    green: '#2da44e', red: '#cf222e', warn: '#bf8700',
};

const GOOD_SPEC = JSON.stringify({
    nodes: [{id: 'a', label: '前端'}, {id: 'b'}, {id: 'c', label: '数据库'}],
    edges: [{from: 'a', to: 'b'}, {from: 'b', to: 'c'}],
    algorithm: 'layered',
});

test('validateGraphSpec 放行合法 spec 并归一化 label / algorithm', () => {
    const out = validateGraphSpec(GOOD_SPEC);
    assert.equal(out.ok, true);
    assert.equal(out.spec.nodes[1].label, 'b', '缺 label 时用 id 兜底');
    assert.equal(out.spec.algorithm, 'layered');
    assert.equal(out.spec.dropped, 0);
});

test('validateGraphSpec 拒绝非 JSON / 空节点 / 超上限 / 重复 id / 缺 id', () => {
    assert.equal(validateGraphSpec('nope').ok, false);
    assert.equal(validateGraphSpec('{"nodes":[]}').ok, false);
    assert.equal(validateGraphSpec('{"nodes":[{"id":"a"}],"edges":[]}').ok, true);
    const many = {nodes: [], edges: []};
    for (let i = 0; i <= GRAPH_LIMITS.maxNodes; i++) many.nodes.push({id: 'n' + i});
    assert.equal(validateGraphSpec(JSON.stringify(many)).ok, false);
    assert.equal(validateGraphSpec('{"nodes":[{"id":"a"},{"id":"a"}]}').ok, false);
    assert.equal(validateGraphSpec('{"nodes":[{"label":"x"}]}').ok, false);
    assert.equal(validateGraphSpec('[]').ok, false);
});

test('validateGraphSpec 丢弃悬空边与自环而非整体失败', () => {
    const out = validateGraphSpec(JSON.stringify({
        nodes: [{id: 'a'}, {id: 'b'}],
        edges: [{from: 'a', to: 'ghost'}, {from: 'a', to: 'a'}, {from: 'a', to: 'b'}, 'junk'],
    }));
    assert.equal(out.ok, true);
    assert.equal(out.spec.edges.length, 1);
    assert.equal(out.spec.dropped, 3);
});

test('validateGraphSpec 未知 algorithm 回退 layered', () => {
    const out = validateGraphSpec('{"nodes":[{"id":"a"}],"algorithm":"force"}');
    assert.equal(out.spec.algorithm, 'force');
    const out2 = validateGraphSpec('{"nodes":[{"id":"a"}],"algorithm":"hype"}');
    assert.equal(out2.spec.algorithm, 'layered');
});

test('simpleLayeredLayout 按 BFS 分层，环退化也不死循环', () => {
    const spec = validateGraphSpec(JSON.stringify({
        nodes: [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}],
        edges: [{from: 'a', to: 'b'}, {from: 'b', to: 'c'}, {from: 'c', to: 'a'}, {from: 'a', to: 'd'}],
    })).spec;
    const layout = simpleLayeredLayout(spec);
    const levelOf = (id) => layout.positions.get(id).level;
    assert.equal(levelOf('a'), 0);
    assert.ok(layout.columns.size >= 2);
});

test('assembleGraphSvg 产出静态 SVG：含节点矩形与箭头 marker，无脚本', () => {
    const spec = validateGraphSpec(GOOD_SPEC).spec;
    const positions = new Map([
        ['a', {x: 10, y: 10, width: 80, height: 34}],
        ['b', {x: 140, y: 10, width: 64, height: 34}],
        ['c', {x: 250, y: 10, width: 90, height: 34}],
    ]);
    const edgePaths = [
        {from: 'a', to: 'b', label: '', points: [{x: 90, y: 27}, {x: 140, y: 27}]},
        {from: 'b', to: 'c', label: '依赖', points: [{x: 204, y: 27}, {x: 250, y: 27}]},
    ];
    const svg = assembleGraphSvg(spec, positions, edgePaths, COLORS);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.includes('viewBox="'), '必须有 viewBox');
    assert.ok(svg.includes('marker-end="url(#gw-ar)"'));
    assert.ok(svg.includes('>前端</text>'));
    assert.ok(svg.includes('>依赖</text>'));
    assert.ok(svg.includes('fill="' + COLORS.panel2 + '"'));
    assert.ok(!/<script/i.test(svg), '产物不得含脚本');
});
