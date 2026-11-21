// external-tools-page.test.mjs —— 「外部工具」迁为应用页面的接线守卫。
//
// 背景（2026-11-22 用户需求）：设置 → AI → 外部工具 迁为「应用页面」内容区标签页
// （与使用统计 / 定时任务同族）。迁移形态：
//   · DOM 常驻 index.html 的 #extcap-park 停靠区（隐藏），mount/unmount 搬进搬出标签页；
//   · 搬运保持节点身份——ai-mcp-settings.js 启动时按 id 捕获的引用与事件绑定始终有效；
//   · 设置弹层不再有 external-tools 子页；设置目录页「应用页面」一行可直达。
//
// 漏接线的代价是**静默降级**——标签页开着却渲染到隐藏停靠区、关标签后 DOM 丢失、
// MCP 绑定失效、AI 指引用户去不存在的设置页。都不会报错，所以必须有守卫。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_PAGES, appPageOf} from '../../src/core/app-pages.js';
import {ICONS} from '../../src/core/icons.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const htmlSrc = read('index.html');
const paneSrc = read('src/settings/settings-pane-external-tools.js');
const dirPaneSrc = read('src/settings/settings-pane-app-pages.js');
const mainSrc = read('src/main.js');
const uiSrc = read('src/settings/settings-ui.js');
const selectSrc = read('src/settings/settings-select.js');
const cssSrc = read('src/style.css');

test('APP_PAGES 注册 external-tools，图标已在注册表', () => {
    const page = appPageOf('external-tools');
    assert.ok(page, 'core/app-pages.js 必须注册 external-tools 应用页面');
    assert.equal(page.label, '外部工具');
    assert.ok(ICONS[page.icon], '页面图标 ' + page.icon + ' 必须先登记 core/icons.js');
});

test('index.html：设置导航不再有 external-tools 子页，停靠区在设置弹层之外', () => {
    assert.ok(!htmlSrc.includes('data-pane="external-tools"'),
        '设置导航与 settings-pane 都不得再有 external-tools——它已是应用页面');
    const parkAt = htmlSrc.indexOf('id="extcap-park"');
    const dlgAt = htmlSrc.indexOf('id="dlg-settings"');
    assert.ok(parkAt >= 0, 'index.html 必须有 #extcap-park 停靠区（DOM 的常驻位置）');
    assert.ok(dlgAt >= 0 && parkAt > dlgAt,
        '停靠区必须在设置弹层之外（buildSettingsTree 只扫 .settings-pane，停进去会被误索引）');
    // 停靠区必须带着 MCP 服务器组：那些 id 被 ai-mcp-settings.js 启动时按 id 捕获
    for (const id of ['extcap-list', 'extcap-provider', 'extcap-desktop', 'ai-opt-mcp-enabled', 'ai-opt-mcp-add', 'ai-opt-mcp-list', 'ai-opt-mcp-samples', 'ai-opt-mcp-samples-list']) {
        const at = htmlSrc.indexOf('id="' + id + '"');
        assert.ok(at > parkAt, '停靠区必须包含 #' + id + '（ai-mcp-settings / 本模块按 id 捕获）');
    }
});

test('index.html：设置导航「应用页面」用 apps 图标（与侧栏活动栏同款四方格）', () => {
    const nav = /data-pane="app-pages"><span class="snav-ic" data-icon="([^"]+)"/.exec(htmlSrc);
    assert.ok(nav, '设置导航必须有 data-pane="app-pages" 项');
    assert.equal(nav[1], 'apps', '应用页面导航图标必须是 apps（用户要求与侧栏对齐，旧值 list 是难看的清单图标）');
    assert.ok(ICONS.apps, 'apps 图标必须登记在 core/icons.js');
});

test('settings-pane-external-tools.js：mount 搬运停靠区、卸载搬回', () => {
    assert.ok(/function mount\(root\)/.test(paneSrc), '必须导出 mount(root) 供 appPageMounters 调用');
    const mountBody = paneSrc.slice(paneSrc.indexOf('function mount(root)'), paneSrc.indexOf('return {mount, renderExternalToolsPane}'));
    assert.ok(mountBody.includes("getElementById('extcap-park')"),
        'mount/unmount 必须以 #extcap-park 为搬运源（节点身份不变，id 引用与绑定才有效）');
    assert.ok(/return \(\) =>/.test(mountBody), 'mount 必须返回卸载函数（关标签把 DOM 搬回停靠区）');
    assert.ok(/return \{mount, renderExternalToolsPane\}/.test(paneSrc),
        '导出面必须同时保留 mount 与 renderExternalToolsPane（后者供 MCP 事件刷新）');
});

test('main.js：挂载器登记 external-tools，事件刷新不再找设置 pane', () => {
    assert.ok(/'external-tools': \(root\) => settingsPaneExternalTools\.mount\(root\)/.test(mainSrc),
        'appPageMounters 必须登记 external-tools（漏了 = 标签页只显示「界面尚未就绪」）');
    assert.ok(!mainSrc.includes('.settings-pane[data-pane="external-tools"]'),
        'refreshExternalToolsPaneIfVisible 不得再查设置 pane（子页已删，永远查不到）');
    assert.ok(/d\.appPage === 'external-tools'/.test(mainSrc),
        '事件刷新应判应用页面标签是否开着');
});

test('外部工具页现代化：页头保存反馈 + 能力有效性徽标 + 工具面板无监听器累积', () => {
    // 页头：统一 pageHeader + 保存状态徽标，mount 时 prepend、unmount 时移除
    assert.ok(/pageHeader\(\{/.test(paneSrc), '外部工具页必须用 ui-kit 的 pageHeader 统一页头');
    assert.ok(/statusBadge\(/.test(paneSrc), '页头必须有保存状态徽标（保存中/已保存/失败）');
    assert.ok(/setSaveState\('保存中/.test(paneSrc), 'save 必须有「保存中」反馈，避免连续编辑无反馈');
    assert.ok(/setSaveState\('已保存/.test(paneSrc), 'save 成功后必须更新「已保存」状态');
    assert.ok(/headEl\.parentNode\.removeChild\(headEl\)/.test(paneSrc),
        'unmount 必须移除 mount 时新建的页头，避免残留到下次挂载');
    // 能力矩阵：提示升级为「有效性徽标 + 说明」
    assert.ok(/function capabilityState\(/.test(paneSrc), '能力提示应升级为 capabilityState（徽标 tone + 文案）');
    assert.ok(/statusBadge\(state\.text, state\.tone\)/.test(paneSrc), '能力卡必须渲染有效性徽标');
    // MCP 工具面板：每次重建 panel 节点，消除监听器累积
    const mcpSrc = read('src/ai/ai-mcp-settings.js');
    assert.ok(/if \(panel\) panel\.remove\(\);/.test(mcpSrc),
        'renderToolsPanel 必须先移除旧 panel 节点再新建，否则每次叠加一组监听器');
});

test('settings-ui.js：不再渲染 external-tools 子页', () => {
    assert.ok(!uiSrc.includes("'external-tools'"),
        'selectSettingsPane 里的 external-tools 分支必须摘除（pane 已不存在）');
});

test('settings-pane-app-pages.js：目录行打开页面后关设置弹层', () => {
    const openBody = dirPaneSrc.slice(dirPaneSrc.indexOf('function openPage(page)'), dirPaneSrc.indexOf('function renderAppPagesPane'));
    assert.ok(openBody.includes('deps.closeSettings()'),
        'openPage 必须调 deps.closeSettings——设置弹层挡着刚打开的标签页（用户要求 3）');
    const renderBody = dirPaneSrc.slice(dirPaneSrc.indexOf('function renderAppPagesPane'));
    assert.ok((renderBody.match(/openPage\(page\)/g) || []).length >= 2,
        '按钮与整行两条点击路径都要走 openPage（只改按钮会漏整行点击）');
});

test('settings-select.js：行式下拉增强覆盖应用页面宿主', () => {
    assert.ok(/\.settings-pane select,\s*\.apppage-root select/.test(selectSrc),
        'enhanceSetSelects 必须扫 .apppage-root select（外部工具的 opt-select 已不在 .settings-pane 里）');
});

test('style.css：外部工具页纵向节奏 + 目录行 hover 圆角内收', () => {
    assert.ok(/\.apppage-root\.extcap-root\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*\d+px/.test(cssSrc),
        '.extcap-root 必须沿用设置 pane 的 flex+gap 节奏（搬运后卡片会紧贴）');
    assert.ok(/\.set-row\.app-pages-row\s*\{[^}]*border-radius/.test(cssSrc),
        '目录行 hover 必须带圆角（贴边直角色块是用户嫌弃的形态）');
    assert.ok(/\.set-row\.app-pages-row\s*\+\s*\.set-row\.app-pages-row\s*\{[^}]*border-top:\s*none/.test(cssSrc),
        '目录行之间要去掉分隔线（hover 色块压着分隔线同样难看）');
    assert.ok(/\.set-row\.app-pages-row:hover\s*\{[^}]*background:\s*var\(--hover\)/.test(cssSrc),
        'hover 底色必须保留（整行可点的可见反馈）');
    assert.ok(/#extcap-list\s*\{[^}]*grid-template-columns/.test(cssSrc),
        '能力矩阵必须改为响应式网格（自动适配列数），不再是单列堆叠');
});
