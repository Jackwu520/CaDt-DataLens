// settings-pane-lang 纯函数测试：首开「全语言扫描」的全空判定与扫描清单。
// firstFullScanRuns：全空（从未扫出任何结果且无在扫）→ 返回全语言工具清单；
// 只要有任何一条 scannedAt / scanning → null，走各语言 pane 自己的首开补扫。
import test from 'node:test';
import assert from 'node:assert/strict';
import {firstFullScanRuns} from '../../src/settings/settings-pane-lang.js';

const LANGS = [
    {id: 'python', tools: [{id: 'python', name: '解释器'}, {id: 'pip', name: 'pip', optional: true}]},
    {id: 'node', tools: [{id: 'node', name: 'Node'}, {id: 'npm', name: 'npm'}]},
    {id: 'go', tools: [{id: 'go', name: 'Go 工具链'}]},
];

// 与 settings-pane-lang.js 里 readLangToolEnv 同形的只读读取器
function envTable(map) {
    return (langId, toolId) => {
        const entry = map && map[langId];
        const tools = entry && entry.tools;
        return (tools && tools[toolId]) || null;
    };
}

test('firstFullScanRuns：全空 → 按语言×工具顺序返回完整扫描清单', () => {
    const runs = firstFullScanRuns(LANGS, envTable(null));
    assert.deepEqual(runs, [
        {langId: 'python', toolId: 'python'},
        {langId: 'python', toolId: 'pip'},
        {langId: 'node', toolId: 'node'},
        {langId: 'node', toolId: 'npm'},
        {langId: 'go', toolId: 'go'},
    ]);
});

test('firstFullScanRuns：任一工具已有扫描结果 → null（不再是全空）', () => {
    const map = {go: {tools: {go: {scannedAt: 123, envs: []}}}};
    assert.equal(firstFullScanRuns(LANGS, envTable(map)), null);
});

test('firstFullScanRuns：任一工具在扫 → null（防止与进行中的扫描重复触发）', () => {
    const map = {python: {tools: {python: {scanning: true}}}};
    assert.equal(firstFullScanRuns(LANGS, envTable(map)), null);
});

test('firstFullScanRuns：缺档 / 空条目都视为未扫', () => {
    // 只建了一半档：python 有空 tools 容器、node 完全没档
    const map = {python: {tools: {}}, go: {}};
    const runs = firstFullScanRuns(LANGS, envTable(map));
    assert.equal(runs.length, 5);
});

test('firstFullScanRuns：旧结构（语言级缓存、无 tools 键）视为未扫', () => {
    // 旧档会在运行时经 langEnvFor 迁移（scannedAt 保留），全语言循环前复查会跳过它，不重扫
    const map = {python: {envs: [{path: 'C:/py'}], scannedAt: 42}};
    const runs = firstFullScanRuns(LANGS, envTable(map));
    assert.equal(runs.length, 5);
});

test('firstFullScanRuns：空语言表 / 非数组入参 → 空清单（不触发）', () => {
    assert.deepEqual(firstFullScanRuns([], envTable(null)), []);
    assert.deepEqual(firstFullScanRuns(null, envTable(null)), []);
});

test('firstFullScanRuns：语言缺 tools 键 → 只跳过该语言，不炸', () => {
    const langs = [{id: 'python', tools: [{id: 'python'}]}, {id: 'weird'}];
    const runs = firstFullScanRuns(langs, envTable(null));
    assert.deepEqual(runs, [{langId: 'python', toolId: 'python'}]);
});
