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

test('操作记录应用页：复合游标 ts+seq 真分页（页码 + 上一页/下一页 + 每页条数）', () => {
    assert.ok(/function fetchActivityPage\(page\)/.test(paneSrc), '必须按页取数（fetchActivityPage）');
    assert.ok(/query\.beforeTs = cursor\.ts/.test(paneSrc), '第 N>1 页必须带 beforeTs 游标');
    assert.ok(/query\.beforeSeq = cursor\.seq/.test(paneSrc),
        '翻页必须带 beforeSeq（配合 beforeTs 消除同毫秒重复/漏）');
    assert.ok(/activityView\.pages\.set\(page, data\)/.test(paneSrc),
        '取过的页必须缓存，来回翻不重复读文件');
    assert.ok(/ACTIVITY_PAGE_SIZES/.test(paneSrc), '必须有每页条数档位');
    for (const id of ['activity-page-first', 'activity-page-prev', 'activity-page-next', 'activity-page-info', 'activity-page-size']) {
        assert.ok(paneSrc.includes("'" + id + "'"), '必须有分页控件 ' + id);
    }
    assert.ok(!/activity-more/.test(paneSrc), '追加式「加载更早记录」按钮（#activity-more）必须彻底移除');
    assert.ok(/\.act-pager\s*\{/.test(cssSrc), 'style.css 必须定义 .act-pager');
});

// 2026-11-22：每页条数下拉是 createSelect 建的（.opt-select），应用页面标签页挂载后由
// bridge-app-page-view 统一调 enhanceSetSelects 增强成自绘浮层。增强后原生 select 隐藏、
// wrap 继承布局类，触发器默认 30px 高会与 24px 分页按钮错位，必须给紧凑样式。
test('操作记录：每页条数下拉走封装 + 增强后触发器紧凑（与分页按钮齐平）', () => {
    assert.ok(/const pageSizeCtl = createSelect\(\{/.test(paneSrc), '每页条数必须用 createSelect 封装，不写裸 select');
    assert.ok(/pageSizeCtl\.classList\.add\('act-page-size'\)/.test(paneSrc),
        '必须给下拉加 act-page-size（增强后 wrap 继承它）');
    assert.ok(/\.act-page-size \.set-select-btn\s*\{/.test(cssSrc),
        'style.css 必须把增强后的触发器压到 24px（否则与分页按钮错位）');
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
// 2026-11-22 用户反馈：详情展开只显示参数，对象列被省略号截断时只能 hover 看 tooltip。
// 现在展开区分「对象 / 详情」两段；复制按钮复制整条记录（见下一条用例）。
// 长对象即使没有参数也挂展开钮。
test('操作记录：展开区同时显示对象与参数（对象不再只靠 tooltip）', () => {
    assert.ok(/function buildDetailBody\(/.test(paneSrc), '必须有展开区构建函数');
    assert.ok(/addSection\('对象'/.test(paneSrc), '展开区必须有「对象」段');
    assert.ok(/addSection\('详情'/.test(paneSrc), '展开区必须有「详情」段');
    assert.ok(/targetText\.length > 32/.test(paneSrc),
        '会被截断的长对象即使没有参数也要挂展开钮');
    assert.ok(/\.act-detail-sec\s*\{/.test(cssSrc), 'style.css 必须有分段样式');
    assert.ok(/\.act-detail-text\s*\{/.test(cssSrc), 'style.css 必须有 .act-detail-text（字体与滚动在它身上）');
});

// 2026-11-22 用户要求：复制按钮要复制**整条记录**（时间 / 来源 / 动作 / 对象 / 详情）成一个
// JSON，而不是只复制参数或两段拼接文本。
test('操作记录：复制按钮复制整条记录 JSON（时间 / 来源 / 动作 / 对象 / 详情）', () => {
    const body = paneSrc.slice(paneSrc.indexOf('function activityEntryJson'), paneSrc.indexOf('function buildDetailBody'));
    assert.ok(body.length > 0, '必须有 activityEntryJson 序列化函数');
    for (const field of ['ts:', 'time:', 'actor:', 'action:', 'target:']) {
        assert.ok(body.includes(field), '整条记录 JSON 必须含字段 ' + field);
    }
    assert.ok(/record\.detail = entry\.detail/.test(body), '有参数时必须把 detail 一并放进 JSON');
    assert.ok(/JSON\.stringify\(record, null, 2\)/.test(body), '必须缩进输出，便于粘贴阅读');
    assert.ok(/copyButton\(\(\) => activityEntryJson\(entry\)/.test(paneSrc),
        '复制按钮必须调 activityEntryJson，不能只拼对象/参数文本');
    // 内部字段 v / seq 是存储实现细节，不进剪贴板
    assert.ok(!/v: entry\.v|seq: entry\.seq/.test(body), '不得把内部字段 v / seq 复制出去');
});

// 复用同一个 class 名但分两处定义，会让后一处静默覆盖前一处（本次就是这样踩到的：
// 11521 的新规则被 11772 的旧规则按源码顺序压掉，展开区退回 160px 高、文字居中错位）。
test('style.css 里 .act-detail 只允许一处定义', () => {
    const count = (cssSrc.match(/^\s*\.act-detail\s*\{/gm) || []).length;
    assert.equal(count, 1, '.act-detail 重复定义会静默覆盖，实际出现 ' + count + ' 处');
});

test('操作记录：复制钮每行都有，详情钮每行都占位（按钮对齐同一列）', () => {
    assert.ok(/className = 'act-ops'/.test(paneSrc), '必须有 .act-ops 操作列容器');
    assert.ok(/const copyBtn = copyButton\(\(\) => activityEntryJson\(entry\)/.test(paneSrc),
        '复制钮必须在分支外创建——短对象无参数的行也要能复制整条记录');
    // 2026-11-23 用户反馈：详情钮按条件渲染会让复制钮在有/无它的行之间左右跳动，
    // 窄容器下更明显。改为每行都渲染，内容不可截断时带 .is-empty 隐形占位。
    assert.ok(/ops\.append\(toggle, copyBtn\)/.test(paneSrc),
        '详情钮与复制钮必须一起进 .act-ops，且顺序固定（否则列内位置会跳）');
    assert.ok(!/ops\.append\(copyBtn\)\s*;/.test(paneSrc.replace(/\s+/g, ' ')) ||
        !/else \{\s*ops\.append\(copyBtn\)/.test(paneSrc),
        '不能再有「无详情钮时只挂复制钮」的分支（那样两行结构不同，对不齐）');
    assert.ok(/classList\.add\('is-empty'\)/.test(paneSrc),
        '内容不可截断的行要把详情钮标成 .is-empty 占位，而不是不渲染');
    assert.ok(/\.act-ops\s*\{/.test(cssSrc), 'style.css 必须定义 .act-ops（横排、不换行）');
    assert.ok(/justify-content: flex-end/.test(cssSrc.slice(cssSrc.indexOf('.act-ops'), cssSrc.indexOf('.act-ops') + 400)),
        '按钮必须在列内靠右对齐，每一行同一水平位置');
    assert.ok(/\.act-detail-btn\.is-empty \{ visibility: hidden/.test(cssSrc),
        '占位态用 visibility（保留宽度），不能用 display:none（会把复制钮推回左边）');
});

// 2026-11-22 用户反馈：每行一个复制图标看着花眼 → hover / 聚焦 / 详情已展开时显形。
// 必须用 opacity（不占位变化），用 display/visibility 会让列宽跳动、复制钮位置左右晃。
// 2026-11-23 用户截图：对象列看着空、右侧详情/复制按钮看不见。根因不是渲染丢数据，而是
// `.activity-list { width: max-content }` 让行宽等于最长对象的固有宽度，整个表格比容器宽几百
// 像素 → 对象列和操作列被推出视野（用户只能横向滚动或根本不知道）。
test('操作记录：列表不得横向溢出（行宽跟容器，对象列可收缩）', () => {
    assert.ok(!/\.activity-list \{[^}]*width:\s*max-content/.test(cssSrc),
        '.activity-list 不得再用 width: max-content（会把对象/操作列推出视野）');
    const grid = (cssSrc.match(/\.act-thead, \.activity-row \{[^}]*\}/) || [''])[0];
    assert.ok(grid.length > 0, '必须有 .act-thead / .activity-row 的 grid 规则');
    assert.ok(/minmax\(0,\s*2fr\)/.test(grid),
        '对象列下限必须是 0（minmax(160px, 2fr) 这类固定下限在窄容器下会撑破容器）');
    assert.ok(/\.act-thead > span \{ white-space: nowrap/.test(cssSrc),
        '表头单元格不许折行（否则窄宽时「对象」被拆成两行）');
});

test('操作记录：复制钮 hover 才显形且不改变占位', () => {
    assert.ok(/\.activity-row \.ap-copy-btn \{ opacity: 0;/.test(cssSrc), '复制钮默认透明');
    assert.ok(/\.activity-row:hover \.ap-copy-btn/.test(cssSrc), '悬停整行时显形');
    assert.ok(/\.activity-row:focus-within \.ap-copy-btn/.test(cssSrc), '键盘聚焦时显形（无障碍）');
    assert.ok(/\.activity-row:has\(\.act-detail:not\(\.hidden\)\) \.ap-copy-btn/.test(cssSrc),
        '详情已展开时保持显形');
    assert.ok(/@media \(hover: none\)/.test(cssSrc), '无 hover 环境（触屏）必须常显');
    assert.ok(!/\.activity-row[^{]*\.ap-copy-btn[^{]*\{[^}]*display:\s*none/.test(cssSrc),
        '不得用 display:none 隐藏（会让列宽与对齐跳动）');
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
