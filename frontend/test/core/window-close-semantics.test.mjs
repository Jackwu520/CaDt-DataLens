// 窗口关闭语义护栏（v3 一进程多窗口）：runtime.Quit 是应用级退出，
// 只有显式的「退出应用」动作可以用；浮窗、独立调试台、标题栏 X 必须走
// 窗口级关闭，否则会绕过 WindowClosing（托盘/关窗确认）或直接杀掉整个应用。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const mainSrc = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
const aiPanelSrc = readFileSync(fileURLToPath(new URL('../../src/ai/ai-panel.js', import.meta.url)), 'utf8');
const appActionsSrc = readFileSync(fileURLToPath(new URL('../../src/shell/app-actions.js', import.meta.url)), 'utf8');

// 从函数声明截到所属函数结束（顶层 `}` 或 4 空格缩进的 `}`）。
function blockAt(src, marker) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `找不到 ${marker}`);
    const match = src.slice(start).match(/^[\s\S]*?^ {0,4}\}$/m);
    assert.ok(match, `${marker} 的函数体没有闭合`);
    return match[0];
}

test('主窗口标题栏 X 先走窗口级关闭', () => {
    const line = mainSrc.split(/\r?\n/).find((l) => l.includes("getElementById('wc-close')"));
    assert.ok(line, '找不到 wc-close 绑定');
    assert.match(line, /if \(rt\.WindowClose\)/);
    assert.ok(
        line.indexOf('rt.WindowClose') < line.indexOf('rt.Quit'),
        'WindowClose 必须先于 Quit：Quit 是应用级退出，会绕过 WindowClosing',
    );
});

test('独立调试控制台关闭不退出整个应用', () => {
    const body = blockAt(mainSrc, 'function startConsoleWindowMode()');
    assert.ok(!/runtime\.Quit\s*\(/.test(body), '调试台 onClose 不得调用 runtime.Quit');
    assert.match(body, /backend\.ForceClose/, '调试台应经 ForceClose 只关当前窗口');
});

test('AI 浮窗关闭兜底不退出整个应用', () => {
    const body = blockAt(aiPanelSrc, 'function forceQuitFloatWindow()');
    assert.ok(!/runtime\.Quit\s*\(/.test(body), '浮窗关闭不得调用 runtime.Quit');
    assert.match(body, /runtime\.WindowClose/, '绑定不可用时应只关当前窗口');
});

test('显式退出走应用级退出请求（确认后 ForceQuitAll）', () => {
    // Go 的 QuitApp 汇总全部窗口风险后发 app-quit-request；前端确认后调 ForceQuitAll。
    const start = mainSrc.indexOf("appEvents.onWindow('app-quit-request'");
    assert.ok(start >= 0, '找不到 app-quit-request 处理器');
    assert.match(mainSrc.slice(start, start + 900), /backend\.ForceQuitAll/);

    const exitStart = appActionsSrc.indexOf('function exitApp()');
    assert.ok(exitStart >= 0, '找不到 exitApp');
    const exit = appActionsSrc.slice(exitStart, exitStart + 700);
    assert.match(exit, /deps\.backend\.QuitApp/, '菜单退出应经 QuitApp 走确认流程');
    assert.ok(
        exit.indexOf('deps.backend.QuitApp') < exit.indexOf('deps.rt.Quit'),
        'QuitApp 必须先于应用级 Quit（后者只作绑定缺失时的兜底）',
    );
});
