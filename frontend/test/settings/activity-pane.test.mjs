// activity-pane.test.mjs —— 操作记录应用页面现代化接线守卫。
// 重设计点：日志表格（列头 + 中文动作名 + 格式化详情 + 复制）；筛选防抖 + 清除；
// 复合游标 ts+seq 翻页；导出分流；设置项留在设置页 + 页内「去设置」跳转。
// 这些都是源码级接线，漏一处会静默降级，故用守卫钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');
const paneSrc = read('src/settings/activity-pane.js');
const mainSrc = read('src/main.js');
const cssSrc = read('src/style.css');
const goSrc = readFileSync(fileURLToPath(new URL('../../../internal/activity/activity.go', import.meta.url)), 'utf8');

test('操作记录应用页：日志表格 + 中文动作名 + 日期分组 + 格式化详情', () => {
    assert.ok(/act-thead/.test(paneSrc), '必须有表头容器');
    assert.ok(/function actionLabel\(/.test(paneSrc), '必须把 file.save 映射为中文动作名');
    assert.ok(/ACTIVITY_ACTION_LABEL/.test(paneSrc), '必须有 domain → 中文名映射表');
    assert.ok(/act-day-group/.test(paneSrc), '必须按日期分组');
    assert.ok(/function formatDetail\(/.test(paneSrc), '详情必须格式化（JSON.stringify(_, null, 2)）');
    assert.ok(/JSON\.stringify\(detail, null, 2\)/.test(paneSrc), '详情必须缩进格式化，不再裸串');
    assert.ok(/copyButton\(/.test(paneSrc), '详情必须有复制按钮');
});

test('操作记录应用页：命令栏（防抖搜索）+ 清除筛选 + 刷新', () => {
    assert.ok(/commandBar\(\{/.test(paneSrc), '必须用 ui-kit 的 commandBar（自带 200ms 防抖）');
    assert.ok(/清除筛选/.test(paneSrc), '必须有清除筛选按钮');
    assert.ok(/bar\.setSearch\('', true\)/.test(paneSrc), '清除筛选必须重置搜索并立即触发');
});

test('操作记录应用页：复合游标 ts+seq 翻页', () => {
    assert.ok(/oldestSeq/.test(paneSrc), '必须维护 oldestSeq 游标');
    assert.ok(/query\.beforeSeq = activityView\.oldestSeq/.test(paneSrc),
        '翻页必须带 beforeSeq（配合 beforeTs 消除同毫秒重复/漏）');
});

test('操作记录应用页：设置项留设置页 + 页内「去设置」跳转', () => {
    assert.ok(/去设置/.test(paneSrc), '页内必须有「去设置」按钮');
    assert.ok(/deps\.openActivitySettings\(\)/.test(paneSrc), '必须调 deps.openActivitySettings 跳转');
    assert.ok(/openActivitySettings\(\)/.test(mainSrc), 'main.js 必须注入 openActivitySettings');
    assert.ok(/openSettingsAtRow\('general', elsSettings\.activityLog\)/.test(mainSrc),
        '跳转必须定位到设置页的 opt-activity-log（settings-tree 反射契约不破）');
});

// 2026-11-22：有详情的行原本把「详情钮 + 复制钮」直接 append，grid 5 列塞 7 个子元素，
// 复制钮掉到下一行且因 .dlg-icon-btn 无 CSS 定义变成裸方块。修复：操作按钮包进 .act-ops 一格。
test('操作记录：详情/复制按钮包进 .act-ops 一格（grid 列不错位）', () => {
    assert.ok(/className = 'act-ops'/.test(paneSrc), '必须有 .act-ops 操作列容器');
    assert.ok(/ops\.append\(toggle, copyButton/.test(paneSrc),
        '详情钮与复制钮必须一起 append 进 .act-ops，不能直接 append 到 row（否则掉行）');
    assert.ok(/\.act-ops\s*\{/.test(cssSrc), 'style.css 必须定义 .act-ops（横排、不换行）');
});

test('应用页面通用图标按钮 .dlg-icon-btn 必须有 CSS 定义（否则裸方块）', () => {
    // ui-kit 的 copyButton/iconButton/detailDrawer 关闭钮都挂这个类；漏定义会显示成浏览器裸按钮。
    assert.ok(/\.dlg-icon-btn\s*\{/.test(cssSrc),
        'style.css 必须定义 .dlg-icon-btn 基础样式，否则操作记录/补丁库/定时任务的图标按钮是裸方块');
});

test('Go 侧复合游标：activityQuery 有 BeforeSeq 且 Read 做 ts+seq 比较', () => {
    assert.ok(/BeforeSeq\s+int64\s+`json:"beforeSeq"`/.test(goSrc), 'activityQuery 必须有 BeforeSeq 字段');
    assert.ok(/entry\.TS == query\.BeforeTs && entry\.Seq >= query\.BeforeSeq/.test(goSrc),
        'Read 必须在同毫秒按 seq 精确切页');
    assert.ok(/query\.BeforeSeq > 0/.test(goSrc), 'BeforeSeq=0 时必须退化为旧单 ts 游标（兼容）');
});
