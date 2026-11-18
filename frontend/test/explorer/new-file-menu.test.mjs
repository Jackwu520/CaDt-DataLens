// new-file-menu.test.mjs —— 右键「新建」菜单定制的纯函数 + 接线守卫。
// 背景：docs/unfinished-plans/feature-evaluations-2026-11-18.md §1

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    BUILTIN_FILE_TYPES, DEFAULT_ORDER, MAX_CUSTOM, SPECIAL_IDS,
    defaultNewFileMenu, moveMenuItem, normalizeNewFileMenu, promoteMenuItem,
    removeCustomTemplate, reorderMenuItem, resolveNewFileMenu, setMenuItemHidden,
    upsertCustomTemplate, validateCustomTemplate,
} from '../../src/explorer/new-file-menu.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, '..', '..', 'src', rel), 'utf8');
const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');

test('缺省配置 = 当前内置顺序与全集（零迁移）', () => {
    assert.deepEqual(normalizeNewFileMenu(undefined), defaultNewFileMenu());
    const {top, more} = resolveNewFileMenu(undefined);
    assert.deepEqual(top.map((item) => item.id), DEFAULT_ORDER);
    assert.equal(more.length, 15);
    assert.deepEqual(top.slice(0, 3).map((item) => item.id), SPECIAL_IDS);
    assert.equal(BUILTIN_FILE_TYPES.length, 25);
});

test('hidden 真正消失；order 之外的内置类型收进「更多」', () => {
    const config = {...defaultNewFileMenu(), hidden: ['type.py', 'nope']};
    const next = normalizeNewFileMenu(config);
    assert.ok(!next.hidden.includes('nope'), '未知 id 应被丢弃');
    const {top, more} = resolveNewFileMenu(config);
    assert.ok(!top.some((item) => item.id === 'type.py'));
    assert.ok(!more.some((item) => item.id === 'type.py'));
    assert.ok(more.some((item) => item.id === 'type.ts'));
});

test('上移 / 下移改变一级顺序；「更多」条目可提升为一级', () => {
    const original = defaultNewFileMenu();
    const moved = moveMenuItem(original, 'type.md', 1);
    assert.equal(moved.order.indexOf('type.md'), original.order.indexOf('type.txt'));
    assert.equal(original.order.indexOf('type.md'), DEFAULT_ORDER.indexOf('type.md'), '不能改入参');
    assert.ok(!resolveNewFileMenu(moved).top.some((item) => item.id === 'type.ts'));
    const promoted = promoteMenuItem(moved, 'type.ts');
    assert.ok(resolveNewFileMenu(promoted).top.some((item) => item.id === 'type.ts'));
});

test('拖拽排序：before / after 落点正确，且能提升「更多」条目', () => {
    const base = defaultNewFileMenu();
    const toBefore = reorderMenuItem(base, 'type.vue', 'type.md', false);
    assert.deepEqual(toBefore.order.slice(3, 5), ['type.vue', 'type.md']);
    const toAfter = reorderMenuItem(base, 'type.vue', 'type.txt', true);
    assert.deepEqual(toAfter.order.slice(3, 6), ['type.md', 'type.txt', 'type.vue']);
    assert.equal(base.order.indexOf('type.vue'), 12, '不能改入参');

    // 拖动项在「更多」二级 → 提升进一级
    const promoted = reorderMenuItem(base, 'type.ts', 'type.go', false);
    assert.ok(resolveNewFileMenu(promoted).top.some((item) => item.id === 'type.ts'));

    // 目标是「更多」二级 → 落到一级末尾（即一级与二级之间），不吞掉其它条目
    const ontoMore = reorderMenuItem(base, 'type.md', 'type.ts', false);
    assert.equal(ontoMore.order[ontoMore.order.length - 1], 'type.md');
    assert.equal(ontoMore.order.length, base.order.length);

    assert.equal(reorderMenuItem(base, '', 'type.md', false).order.length, base.order.length);
    assert.equal(reorderMenuItem(base, 'type.md', 'type.md', false).order.length, base.order.length);
    assert.equal(reorderMenuItem(base, 'type.md', 'ghost', false).order.length, base.order.length);
});

test('显示 / 隐藏可逆', () => {
    const hidden = setMenuItemHidden(defaultNewFileMenu(), 'type.md', true);
    assert.ok(!resolveNewFileMenu(hidden).top.some((item) => item.id === 'type.md'));
    const shown = setMenuItemHidden(hidden, 'type.md', false);
    assert.ok(resolveNewFileMenu(shown).top.some((item) => item.id === 'type.md'));
});

test('模板校验：空名 / 无扩展名拒绝；非法路径字符剔除；内容限长', () => {
    assert.equal(validateCustomTemplate({label: '', name: 'a.vue'}).ok, false);
    assert.equal(validateCustomTemplate({label: 'A', name: 'abc'}).ok, false);
    const checked = validateCustomTemplate({label: ' 组件 ', name: '..\\新建组件?.vue', content: 'x'.repeat(5000)});
    assert.equal(checked.ok, true);
    assert.equal(checked.value.label, '组件');
    assert.equal(checked.value.name, '..新建组件.vue');
    assert.equal(checked.value.content.length, 4096);
});

test('模板增 / 改 / 删：新建落在「新建」一级，携带初始内容；撤销不残留', () => {
    const added = upsertCustomTemplate(defaultNewFileMenu(),
        {label: 'Vue 组件', name: '新建组件.vue', content: '<template></template>'});
    assert.equal(added.ok, true);
    const id = added.config.custom[0].id;
    assert.ok(resolveNewFileMenu(added.config).top.some((item) => item.id === id && item.content === '<template></template>'));
    const edited = upsertCustomTemplate(added.config,
        {label: 'Vue3 组件', name: '新建组件.vue', content: '<script setup></script>'}, id);
    assert.equal(edited.config.custom[0].label, 'Vue3 组件');
    const removed = removeCustomTemplate(edited.config, id);
    assert.equal(removed.custom.length, 0);
    assert.ok(!removed.order.includes(id));
    assert.ok(!resolveNewFileMenu(removed).top.some((item) => item.id === id));
});

test('模板数量有上限', () => {
    let config = defaultNewFileMenu();
    for (let i = 0; i < MAX_CUSTOM; i += 1) {
        config = upsertCustomTemplate(config, {label: 'T' + i, name: 't' + i + '.txt', content: ''}).config;
    }
    const overflow = upsertCustomTemplate(config, {label: 'T', name: 't.txt', content: ''});
    assert.equal(overflow.ok, false);
});

test('损坏配置不 throw，回退到可用菜单', () => {
    for (const bad of [null, 42, 'oops', [], {order: 'not-array', hidden: {}, custom: 'x'},
        {order: ['type.md', 'type.md', 'ghost'], hidden: ['ghost'], custom: [{}, null, {label: 'x'}]}]) {
        const config = normalizeNewFileMenu(bad);
        assert.ok(Array.isArray(config.order) && Array.isArray(config.hidden) && Array.isArray(config.custom));
        assert.ok(SPECIAL_IDS.every((id) => config.order.includes(id)), '结构项不能丢');
        assert.ok(resolveNewFileMenu(bad).top.length > 0, '菜单不能变空');
    }
});

test('接线：main.js 从注册表派生旧表并归一化 settings', () => {
    const main = src('main.js');
    assert.match(main, /from '\.\/explorer\/new-file-menu\.js'/);
    assert.match(main, /BUILTIN_FILE_TYPES\.filter\(\(t\) => t\.group === 'top'\)/);
    assert.match(main, /settings\.newFileMenu = normalizeNewFileMenu\(settings\.newFileMenu\)/);
    assert.match(main, /newFileMenu: defaultNewFileMenu\(\)/);
});

test('接线：explorer-ops 按配置合成菜单，保留只读判定并写模板正文', () => {
    const ops = src('explorer/explorer-ops.js');
    assert.match(ops, /resolveNewFileMenu\(deps\.settings && deps\.settings\.newFileMenu\)/);
    assert.match(ops, /fileTypeMenuItem\(entry, createType\)/);
    assert.match(ops, /disabled: readOnly/);
    assert.match(ops, /deps\.backend\.SaveFile\(target, body/);
    assert.match(ops, /label: '配置菜单…'/);
    assert.match(ops, /openSettings\('new-file-menu'\)/);
});

test('接线：设置页有独立「菜单管理」页、容器与渲染入口，控件走 form-controls', () => {
    assert.match(html, /id="new-file-menu-settings"/);
    // 独立导航项 + 独立 pane；容器不再嵌在通用 pane 内
    assert.match(html, /class="snav-item" data-pane="new-file-menu"/);
    assert.match(html, /class="settings-pane hidden" data-pane="new-file-menu"/);
    const ui = src('settings/settings-ui.js');
    assert.match(ui, /pane === 'new-file-menu' && deps\.newFileMenuPane/);
    const pane = src('settings/settings-pane-new-file-menu.js');
    assert.match(pane, /from '\.\.\/core\/form-controls\.js'/);
    assert.match(pane, /createSwitch\(/);
    assert.match(pane, /createTextarea\(/);
    assert.doesNotMatch(pane, /document\.createElement\('input'\)/);
});

test('接线：拖拽排序用排队消息同款手柄 + 让位插槽，上下移保留', () => {
    const pane = src('settings/settings-pane-new-file-menu.js');
    assert.match(pane, /iconSvg\('grip', 12\)/);
    assert.match(pane, /handle\.draggable = true/);
    assert.match(pane, /drop-gap-before/);
    assert.match(pane, /drop-gap-after/);
    assert.match(pane, /reorderMenuItem\(config, id, line\.dataset\.nfmId, !before\)/);
    assert.match(pane, /moveMenuItem\(config, row\.id, -1\)/);
    assert.match(pane, /moveMenuItem\(config, row\.id, 1\)/);
    const css = src('style.css');
    assert.match(css, /\.set-row\.nfm-row\.drop-gap-before \{ margin-top/);
    assert.match(css, /\.set-row\.nfm-row\.drop-gap-after \{ margin-bottom/);
});
