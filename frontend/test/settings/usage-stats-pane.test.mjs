// usage-stats-pane.test.mjs —— 使用统计面板布局的接线守卫。
//
// 背景（2026-11-22 用户实测）：使用统计作为「应用页面」标签页打开后，
// 各板块（Token 活动 / 趋势 / 模型用量 / 请求日志）上下紧贴、没有间距。
// 根因：板块间距靠 .us-root 的 flex gap，但骨架只往 host 里塞 .us-card，
// 没给 host 加 .us-root——应用页面宿主是 .apppage-root（无此 class），设置页旧宿主
// 是 #usage-stats-root（也无此 class），两处都拿不到 gap 布局。
//
// 修复契约：
//   · mountSkeleton 必须给 host 加 .us-root（组件自带样式，不依赖宿主 class）；
//   · 卸载函数必须移除 .us-root（关标签后不留残留 class）；
//   · .us-root CSS 必须有 flex column + gap 提供板块间距。
//
// 2026-11-22 追加：趋势/环形图宽度变化不重建。根因是只监听 window.resize，
// 而侧栏展开/收起、编辑器分栏拖动、标签页宽度变化都不派发 window.resize。
// 修复用 ResizeObserver 直接观察两个图表容器，window.resize 仅作宿主不派发 RO 的兜底。
// 守卫：mountSkeleton 必须 observe 两个容器 + 保留 window.resize；
//       卸载必须 disconnect RO + removeEventListener（对称解绑，避免重挂重复绑定）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const paneSrc = readFileSync(join(srcRoot, 'settings/settings-pane-usage-stats.js'), 'utf8');
const cssSrc = readFileSync(join(srcRoot, 'style.css'), 'utf8');
const mainSrc = readFileSync(join(srcRoot, 'main.js'), 'utf8');

function sliceFunction(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const rest = text.slice(start + signature.length);
    const next = /\n    function [A-Za-z_]|\nfunction [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

test('mountSkeleton 给 host 加 .us-root class（板块间距的来源）', () => {
    const body = sliceFunction(paneSrc, 'function mountSkeleton(host)');
    assert.ok(body.includes("host.classList.add('us-root')"),
        'mountSkeleton 必须给 host 加 .us-root，否则 .us-root 的 flex gap 不生效、板块紧贴');
    // 加 class 必须在 innerHTML 之前（骨架内容依赖父容器的 gap 布局）
    const addAt = body.indexOf("host.classList.add('us-root')");
    const htmlAt = body.indexOf('host.innerHTML');
    assert.ok(addAt >= 0 && htmlAt >= 0 && addAt < htmlAt,
        '.us-root 必须在写入骨架前加上');
});

test('卸载函数移除 .us-root class', () => {
    // mount 返回的卸载函数里必须清理 hostEl 上的 .us-root
    const mountBody = sliceFunction(paneSrc, 'function mount(host)');
    assert.ok(mountBody.includes("hostEl.classList.remove('us-root')"),
        '关标签卸载时必须移除 .us-root，避免 host 复用时残留 class');
});

test('.us-root CSS 提供 flex column + gap 板块间距', () => {
    // 行首匹配（排除 .apppage-root > .us-root 的重置规则）
    const m = /^\.us-root\s*\{([^}]*)\}/m.exec(cssSrc);
    assert.ok(m, 'style.css 必须有 .us-root 规则（板块间距靠它）');
    assert.ok(/display:\s*flex/.test(m[1]), '.us-root 必须是 flex 容器');
    assert.ok(/flex-direction:\s*column/.test(m[1]), '.us-root 必须是纵向排列');
    assert.ok(/gap:\s*\d+px/.test(m[1]), '.us-root 必须有 gap 提供板块间距');
    // 负向断言：us-root 加在宿主 .apppage-root 身上（同节点合并），自带 padding 会在同特异性
    // 下因声明更晚压掉宿主内边距，整页贴边（2026-11-22 用户实测）。留白统一由宿主给。
    assert.ok(!/padding/.test(m[1]), '.us-root 不得自带 padding（会压掉 .apppage-root 的内边距，整页贴边）');
});

test('图表容器宽度变化用 ResizeObserver 观察（不依赖 window.resize）', () => {
    const body = sliceFunction(paneSrc, 'function mountSkeleton(host)');
    assert.ok(/new ResizeObserver\(/.test(body),
        'mountSkeleton 必须用 ResizeObserver 观察图表容器，否则侧栏/分栏/标签页宽度变化不会触发图表重建');
    // 两个图表容器都要观察：趋势图 us-trend + 环形图 us-donut
    assert.ok(/\.observe\(trendEl\)/.test(body), '必须观察趋势图容器 us-trend');
    assert.ok(/\.observe\(donutEl\)/.test(body), '必须观察环形图容器 us-donut');
    // window.resize 兜底保留（部分宿主不派发 RO 回调）
    assert.ok(/addEventListener\('resize',\s*scheduleChartResize\)/.test(body),
        '保留 window.resize 兜底，且复用 scheduleChartResize 与 RO 共用 debounce');
});

test('卸载时对称解绑 resize 监听与 RO（避免重挂重复绑定/实例泄漏）', () => {
    const mountBody = sliceFunction(paneSrc, 'function mount(host)');
    assert.ok(/chartResizeObserver\.disconnect\(\)/.test(mountBody),
        '卸载必须 disconnect ResizeObserver，否则图表容器与实例一起泄漏');
    assert.ok(/removeEventListener\('resize',\s*scheduleChartResize\)/.test(mountBody),
        '卸载必须移除 window.resize 监听（与绑定对称），否则再次 mount 会重复绑定');
    assert.ok(/state\.resizeBound = false/.test(mountBody),
        '卸载必须重置 resizeBound，否则下次 mount 跳过绑定');
});

test('.apppage-root 宿主统一给内边距、宽度收住并整体居中', () => {
    const m = /^\.apppage-root\s*\{([^}]*)\}/m.exec(cssSrc);
    assert.ok(m, 'style.css 必须有 .apppage-root 宿主规则');
    assert.ok(/padding:\s*\d+px/.test(m[1]), '宿主必须给内边距（各页骨架不得自带，见上一条）');
    assert.ok(/max-width:\s*\d+px/.test(m[1]), '宿主必须收住版面宽度');
    assert.ok(/margin:\s*0\s+auto/.test(m[1]), '宿主必须 margin auto 整体居中（2026-11-22 用户反馈：左对齐难看）');
});

// 2026-11-22 追加：请求日志「每页条数」下拉露出浏览器原生菜单（白底 10/20/50）。
// 根因：该 select 经 createSelect 建成原生控件，但使用统计作为「应用页面」标签页不走
// settings-ui 的 enhanceSetSelects 扫描（只扫 .settings-pane / .apppage-root 里已存在的），
// 且骨架是 mount 后异步建的，扫描时机也赶不上。修复：给 pane 注入 enhanceSelect，
// bindLogPager 建好下拉并入 DOM 后手动增强成自绘浮层。
test('请求日志「每页条数」下拉经 enhanceSelect 增强（去掉原生菜单）', () => {
    const body = sliceFunction(paneSrc, 'function bindLogPager()');
    assert.ok(/deps\.enhanceSelect/.test(body),
        'bindLogPager 必须调用 deps.enhanceSelect 增强「每页条数」下拉，否则露浏览器原生菜单');
    // 增强必须在 append 之后（增强器要读触发器布局算浮层位置）
    const appendAt = body.indexOf('host.append(prefix, element, suffix)');
    const enhanceAt = body.indexOf('deps.enhanceSelect');
    assert.ok(appendAt >= 0 && enhanceAt > appendAt,
        'enhanceSelect 必须在 host.append 之后调用（增强器依赖已入 DOM 的布局）');
});

test('热力图整体居中（safe center，溢出仍可靠左滚动）', () => {
    const m = /\.us-heatmap\s*\{([^}]*)\}/.exec(cssSrc);
    assert.ok(m, 'style.css 必须有 .us-heatmap 规则');
    assert.ok(/align-items:\s*safe\s+center/.test(m[1]),
        '热力图须用 align-items: safe center 居中：空间够时居中，溢出时靠左不裁切首列（普通 center 会裁掉左侧且滚不到）');
});

test('main.js 给 usage-stats pane 注入 enhanceSelect', () => {
    // 从 createSettingsPaneUsageStats( 起到匹配的 }); 为止，确认 deps 里有 enhanceSelect
    const start = mainSrc.indexOf('createSettingsPaneUsageStats({');
    assert.ok(start >= 0, 'main.js 必须创建 createSettingsPaneUsageStats');
    const chunk = mainSrc.slice(start, start + 500);
    assert.ok(/get enhanceSelect\(\)/.test(chunk),
        '必须给 usage-stats pane 注入 enhanceSelect（惰性 getter），否则下拉无法增强');
});

