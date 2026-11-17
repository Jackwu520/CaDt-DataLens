// git-graph-lane.test.mjs —— Git 图谱泳道 SVG 几何纯函数测试。
// 泳道拓扑本身在 Go 侧算（internal/gitinfo/graph.go 的 assignLanes），前端只负责渲染；
// 这里测渲染几何：laneCenterX / laneSvgWidth / buildLaneSvg。
import test from 'node:test';
import assert from 'node:assert/strict';
import {laneCenterX, laneSvgWidth, buildLaneSvg} from '../../src/git-graph/git-graph.js';

test('laneCenterX 按泳道序号递增，间距恒定', () => {
    const x0 = laneCenterX(0);
    const x1 = laneCenterX(1);
    const x2 = laneCenterX(2);
    assert.equal(x1 - x0, x2 - x1, '相邻泳道间距应相等');
    assert.ok(x0 > 0, '首泳道应留左留白');
});

test('laneSvgWidth 容纳所有泳道且不小于单泳道', () => {
    assert.ok(laneSvgWidth(1) >= laneCenterX(0) + 8);
    assert.ok(laneSvgWidth(4) > laneSvgWidth(1));
    // 宽度应能容纳最后一条泳道的圆点
    assert.ok(laneSvgWidth(3) >= laneCenterX(2) + 8);
});

test('buildLaneSvg 为每行画一个圆点', () => {
    const commits = [
        {sha: 'a', parents: ['b'], lane: 0, throughLanes: []},
        {sha: 'b', parents: [], lane: 0, throughLanes: []},
    ];
    const svg = buildLaneSvg(commits, 1);
    const dots = svg.match(/class="gg-dot"/g) || [];
    assert.equal(dots.length, 2, '两行应有两个圆点');
    assert.ok(svg.includes('<svg'), '应包含 svg 壳');
});

test('buildLaneSvg 穿线泳道画额外竖线', () => {
    const commits = [
        {sha: 'm', parents: ['a', 'b'], lane: 0, throughLanes: [1]},
        {sha: 'a', parents: [], lane: 0, throughLanes: []},
    ];
    const svg = buildLaneSvg(commits, 2);
    // lane 0 与 lane 1 都应有竖线（gg-line）
    const lines = svg.match(/class="gg-line"/g) || [];
    assert.ok(lines.length >= 2, '穿线应产生额外竖线，实际 ' + lines.length);
});

test('buildLaneSvg 父分支拐点画弧线', () => {
    // 合并提交：lane0 的 m 有父 a(lane0) 与 b(lane1)，b 在下一行 → 应画弧线
    const commits = [
        {sha: 'm', parents: ['a', 'b'], lane: 0, throughLanes: [1]},
        {sha: 'b', parents: [], lane: 1, throughLanes: []},
        {sha: 'a', parents: [], lane: 0, throughLanes: []},
    ];
    const svg = buildLaneSvg(commits, 2);
    const curves = svg.match(/class="gg-curve"/g) || [];
    assert.ok(curves.length >= 1, '合并应有分支拐点弧线');
});

test('buildLaneSvg 空列表返回空 svg', () => {
    const svg = buildLaneSvg([], 1);
    assert.ok(svg.includes('<svg'));
    assert.equal((svg.match(/gg-dot/g) || []).length, 0);
});
