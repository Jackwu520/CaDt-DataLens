// patch-store-page.test.mjs —— 补丁库应用页面现代化接线守卫。
// 重设计点：卡片列表 + 状态筛选 + 搜索 + 排序 + 前端分页 + 详情抽屉（复用 diff 思路）
// + 整行可点打开补丁视图 + 撤销入口。这些都是源码级接线，漏一处静默降级，故用守卫钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');
const paneSrc = read('src/settings/settings-pane-patches.js');
const mainSrc = read('src/main.js');

test('补丁库应用页：卡片列表 + 整行可点 + 状态徽标', () => {
    assert.ok(/function buildRow\(meta\)/.test(paneSrc), '必须有卡片行渲染');
    assert.ok(/row\.addEventListener\('click', \(\) => showDetail\(meta\)\)/.test(paneSrc),
        '整行必须可点开详情（旧版只有删除按钮可点）');
    assert.ok(/statusBadge\(label\.text, toneOf\(label\.tone\)\)/.test(paneSrc), '必须用 ui-kit 状态徽标');
});

test('补丁库应用页：状态筛选 + 搜索 + 排序 + 前端分页', () => {
    assert.ok(/filterChips\(\{/.test(paneSrc), '必须有状态筛选 chips');
    assert.ok(/commandBar\(\{/.test(paneSrc), '必须有搜索命令栏');
    assert.ok(/function filteredPatches\(/.test(paneSrc), '必须有前端筛选/排序纯函数');
    assert.ok(/patchFilter\.sort === 'size'/.test(paneSrc), '必须支持按改动量排序');
    assert.ok(/PAGE_SIZE/.test(paneSrc), '必须有前端分页');
    assert.ok(/共 ' \+ rows\.length \+ ' 条/.test(paneSrc), '必须显示总数（旧版硬编码 50 且无提示）');
});

test('补丁库应用页：详情抽屉 + 打开视图 + 撤销入口', () => {
    assert.ok(/function showDetail\(meta\)/.test(paneSrc), '必须有详情抽屉');
    assert.ok(/detailDrawer\(\{/.test(paneSrc), '必须用 ui-kit 的 detailDrawer（走 overlay-stack）');
    assert.ok(/openPatch\(meta\)/.test(paneSrc), '必须能打开补丁视图');
    assert.ok(/PatchRevert/.test(paneSrc), '已应用补丁必须提供撤销入口');
    assert.ok(/openPatchFile/.test(mainSrc), 'main.js 必须注入 openPatchFile（.patch 走 openPath）');
});

test('补丁库应用页：时间含相对时间 + 去掉嵌套滚动', () => {
    assert.ok(/relativeTime\(Number\(meta\.createdAt\)/.test(paneSrc), '时间必须显示相对时间');
    const css = read('src/style.css');
    const patchListRule = /\.patch-store-list\s*\{[^}]*\}/.exec(css);
    assert.ok(patchListRule, '必须有 .patch-store-list 样式');
    assert.ok(!/max-height/.test(patchListRule[0]), '去掉列表固定 max-height（避免嵌套滚动）');
});
