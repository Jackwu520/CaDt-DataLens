// tab-kinds.test.mjs —— 虚拟标签页注册表的纯逻辑测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {TAB_KINDS, tabKindOf, suppressesViewOptions, tabIconName, tabKindByName} from '../../src/core/tab-kinds.js';

test('注册表结构完整：每项都有 marker / kind / icon / label，且无重复', () => {
    for (const spec of TAB_KINDS) {
        assert.equal(typeof spec.marker, 'string');
        assert.ok(spec.marker.length > 0, 'marker 不能为空');
        assert.ok(spec.kind.length > 0, spec.marker + ' 缺 kind');
        assert.ok(spec.icon.length > 0, spec.marker + ' 缺 icon');
        assert.ok(spec.label.length > 0, spec.marker + ' 缺 label');
    }
    const markers = TAB_KINDS.map((s) => s.marker);
    assert.equal(new Set(markers).size, markers.length, 'marker 有重复');
    const kinds = TAB_KINDS.map((s) => s.kind);
    assert.equal(new Set(kinds).size, kinds.length, 'kind 有重复（视图工厂按 kind 分派，重复会互相顶掉）');
});

test('tabKindOf：每个 marker 都能被识别', () => {
    for (const spec of TAB_KINDS) {
        const doc = {[spec.marker]: 'x'};
        assert.equal(tabKindOf(doc).kind, spec.kind, spec.marker + ' 识别失败');
    }
});

test('tabKindOf：文件 doc / 空值 / 无标记位一律返回 null', () => {
    assert.equal(tabKindOf(null), null);
    assert.equal(tabKindOf(undefined), null);
    assert.equal(tabKindOf({}), null);
    assert.equal(tabKindOf({path: '/a.json', name: 'a.json'}), null);
    // 文本型虚拟标签页（计划 / 差异）不是视图型，不该被识别
    assert.equal(tabKindOf({path: null, untitled: true, viewKind: 'plan'}), null);
});

test('tabKindOf：标记位为假值时不算命中（避免 0 / "" / false 误判）', () => {
    assert.equal(tabKindOf({browser: false}), null);
    assert.equal(tabKindOf({bgTerm: ''}), null);
    assert.equal(tabKindOf({memo: 0}), null);
});

test('suppressesViewOptions：只屏蔽视图型，不屏蔽文本型', () => {
    for (const spec of TAB_KINDS) {
        assert.equal(suppressesViewOptions({[spec.marker]: 'x'}), true, spec.marker + ' 应屏蔽视图下拉');
    }
    assert.equal(suppressesViewOptions({path: null, untitled: true, viewKind: 'plan'}), false,
        '计划文档（.md）应保留预览视图');
    assert.equal(suppressesViewOptions({path: '/a.md'}), false, '普通文件不该被屏蔽');
    assert.equal(suppressesViewOptions(null), false);
});

test('tabIconName：有图标名、无标记位返回空串', () => {
    assert.equal(tabIconName({browser: true}), 'browser');
    assert.equal(tabIconName({memo: 'panel'}), 'memo');
    assert.equal(tabIconName({path: '/a.json'}), '');
    assert.equal(tabIconName(null), '');
});

test('tabKindByName：反查类型项', () => {
    assert.equal(tabKindByName('terminal').marker, 'bgTerm');
    assert.equal(tabKindByName('agent').marker, 'agentView');
    assert.equal(tabKindByName('nope'), null);
});
