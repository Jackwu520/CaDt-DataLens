// settings-pane-patches 纯函数测试：状态徽标映射、行标题拼装、删除确认文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {patchStatusLabel, patchRowTitle, patchDeleteConfirmText} from '../../src/settings/settings-pane-patches.js';

const paneSrc = readFileSync(fileURLToPath(new URL('../../src/settings/settings-pane-patches.js', import.meta.url)), 'utf8');

// 2026-11-22 P0：mount 里用了 createSelect 做排序下拉，但顶部只 import 了 createInput，
// 导致打开补丁库标签页就抛 `createSelect is not defined`，整页空白。钉死 import 接线。
test('补丁库 mount 用到的 createSelect 必须已 import（防 ReferenceError 整页空白）', () => {
    const usesCreateSelect = /createSelect\s*\(/.test(paneSrc);
    const importsCreateSelect = /import\s*\{[^}]*\bcreateSelect\b[^}]*\}\s*from\s*['"]\.\.\/core\/form-controls\.js['"]/.test(paneSrc);
    if (usesCreateSelect) {
        assert.ok(importsCreateSelect,
            'mount 用了 createSelect 就必须从 core/form-controls.js import，否则打开补丁库抛 ReferenceError');
    }
});

test('patchStatusLabel：状态 → 文案与色调', () => {
    const cases = [
        ['applied', '已应用', 'ok'],
        ['partial', '部分应用', 'warn'],
        ['applying', '应用中', 'warn'],
        ['failed', '应用中断', 'error'],
        ['reverted', '已撤销', 'muted'],
        ['proposed', '未应用', 'muted'],
        ['', '未应用', 'muted'],
        ['unknown-status', '未应用', 'muted'],
    ];
    for (const [status, text, tone] of cases) {
        const got = patchStatusLabel(status);
        assert.equal(got.text, text, `status=${status} 文案`);
        assert.equal(got.tone, tone, `status=${status} 色调`);
    }
});

test('patchRowTitle：摘要 + 文件数 + 增删统计', () => {
    assert.equal(
        patchRowTitle({summary: '修 A', files: ['a.js', 'b.js'], added: 12, removed: 3}),
        '修 A · 2 个文件 · +12 −3',
    );
    // 缺字段时退化为「补丁」并补 0
    assert.equal(patchRowTitle({}), '补丁 · +0 −0');
    assert.equal(patchRowTitle(null), '补丁 · +0 −0');
    // 文件列表为空时不出现「0 个文件」
    assert.equal(patchRowTitle({summary: '空', files: [], added: 1, removed: 0}), '空 · +1 −0');
});

test('patchDeleteConfirmText：已应用的补丁必须点明无法撤销', () => {
    const applied = patchDeleteConfirmText({id: '20261113-1', summary: '已应用的补丁', status: 'applied'});
    assert.match(applied, /已应用的补丁/);
    assert.match(applied, /无法再撤销/);
    assert.match(applied, /回收站/);

    const partial = patchDeleteConfirmText({id: 'x', summary: '部分应用', status: 'partial'});
    assert.match(partial, /无法再撤销/);

    const proposed = patchDeleteConfirmText({id: 'y', summary: '没应用过', status: 'proposed'});
    assert.doesNotMatch(proposed, /无法再撤销/);
    assert.match(proposed, /没应用过/);
    // 摘要缺失时回落到 id，避免弹窗出现空标题
    assert.match(patchDeleteConfirmText({id: 'zzz', status: 'proposed'}), /zzz/);
});
