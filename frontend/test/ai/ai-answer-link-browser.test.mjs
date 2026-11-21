// ai-answer-link-browser.test.mjs —— AI 回答正文链接走内置浏览器的接线守卫。
//
// 背景（2026-11-22 用户实测）：点 AI 回答里的 https 链接，弹出一个裸 WebView2 窗口，
// 而不是应用的内置浏览器标签页。根因：markdown 渲染给外链加了 target="_blank"，
// 而消息区点击委托没拦 <a>，于是走 WebView2 默认新窗口。
// 修复：main.js 注入 openBrowserTab 给 AI 面板；handleMessageClick 拦 .ai-md a[href]
// 的 http(s) 链接，preventDefault 后改走内置浏览器（未注入时降级系统浏览器）。
// ai-panel.js 顶层依赖庞大无法在 Node 直接执行，按仓库惯例做源码接线断言。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const panelSrc = readFileSync(new URL('../../src/ai/ai-panel.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');

// 截取 createAIPanel 工厂开头一段（读 opts 注入能力的地方）。
function factoryHead() {
    const start = panelSrc.indexOf('export function createAIPanel(options)');
    assert.ok(start >= 0, '找不到 createAIPanel 工厂');
    return panelSrc.slice(start, start + 30000);
}

test('main.js 给 createAIPanel 注入 openBrowserTab（箭头函数延迟求值避免 TDZ）', () => {
    const initStart = mainSrc.indexOf('function initAIPanel()');
    assert.ok(initStart >= 0, '找不到 initAIPanel');
    const init = mainSrc.slice(initStart, initStart + 12000);
    assert.match(init, /openBrowserTab:\s*\(url\)\s*=>\s*openBrowserTab\(url/,
        '必须以箭头函数注入 openBrowserTab，直接传值会在 bridgeUI 解构前 TDZ');
});

test('AI 面板工厂读取注入的 openBrowserTab 能力', () => {
    assert.match(factoryHead(), /const openBrowserTab = typeof opts\.openBrowserTab === 'function'\s*\?\s*opts\.openBrowserTab\s*:\s*null/,
        '工厂必须读取 opts.openBrowserTab，未注入时为 null');
});

test('handleMessageClick 拦截 .ai-md 正文里的 http(s) 链接', () => {
    const start = panelSrc.indexOf('function handleMessageClick(e, sessionOverride)');
    assert.ok(start >= 0, '找不到 handleMessageClick');
    const body = panelSrc.slice(start, start + 900);
    assert.match(body, /closest\('\.ai-md a\[href\]'\)/, '必须只拦正文 .ai-md 内的链接');
    assert.match(body, /\^https\?:\\\/\\\//, '必须限定 http(s) 协议');
    assert.match(body, /e\.preventDefault\(\)/, '必须 preventDefault 阻止 target=_blank 默认新窗口');
    assert.match(body, /if \(openBrowserTab\) openBrowserTab\(href\)/, '必须改走内置浏览器标签页');
    assert.match(body, /else openExternal\(href\)/, '未注入时降级回系统浏览器');
});
