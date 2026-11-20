// 终端弹出窗口接线护栏：tab 菜单入口、事件归属切换与收回路径三处必须同时存在。
// 机制（见 docs/finished-plans/window-geometry-memory.md 同批记录）：
//   主窗口 PopOutTerminal → 弹出窗口 attachResumedTermSession（切 owner + 环形缓冲回放）
//   → 弹出窗口关闭时 Go 广播 term-popout-closed 指定交还目标 → 主窗口接回页签。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const sessionsSrc = readFileSync(fileURLToPath(new URL('../../src/terminal/terminal-sessions.js', import.meta.url)), 'utf8');
const mainSrc = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
const bridgeSrc = readFileSync(fileURLToPath(new URL('../../src/bridge/bridge-ui.js', import.meta.url)), 'utf8');
const scopeSrc = readFileSync(fileURLToPath(new URL('../../src/core/event-scope.js', import.meta.url)), 'utf8');

test('终端页签菜单提供「在独立窗口打开」且走 PopOutTerminal', () => {
    assert.match(sessionsSrc, /'在独立窗口打开'/);
    assert.match(sessionsSrc, /popOutTermSession\(id\)/);
    const fn = sessionsSrc.slice(sessionsSrc.indexOf('async function popOutTermSession'));
    assert.match(fn, /backend\.PopOutTerminal/);
    assert.match(fn, /removeTermSession\(id\)/, '弹出成功后本窗口卸掉页签');
});

test('接回路径：切事件归属 + TermRead 快照回放，且不允许漏掉暂存清理', () => {
    const fn = sessionsSrc.slice(sessionsSrc.indexOf('async function attachResumedTermSession'));
    assert.match(fn, /RegisterEventOwner\('term', id\)/);
    assert.match(fn, /TermRead\(id, TERM_REPLAY_CHARS\)/);
    assert.match(fn, /discardPendingTermOut\(id\)/, '快照已覆盖暂存期，不清会双写');
    // 快照成功才跳过 flush（skipPendingFlush）；快照失败必须走 flushPendingTermOut
    // 保住交接间隙的输出（2026-11-21 审查 P2-2）。
    assert.match(fn, /skipPendingFlush: replayFailed \? false : true/);
    assert.match(fn, /if \(replayFailed\) \{\s*flushPendingTermOut\(id\);/);
});

test('弹出/接回保留页签标签（「本地」不漂移成 Shell 名）', () => {
    assert.match(sessionsSrc, /popoutLabels\.set\(id, \{label: s\.customName \|\| s\.defaultLabel, custom: !!s\.customName\}\)/,
        '弹出时记住页签名（含自定义名）');
    assert.match(sessionsSrc, /const remembered = popoutLabels\.get\(id\);/);
    assert.match(sessionsSrc, /label: remembered && remembered\.label/);
    assert.match(sessionsSrc, /popoutLabels\.delete\(id\);/);
});

test('主窗口监听 term-popout-closed 并按 target 接回', () => {
    const start = mainSrc.indexOf("appEvents.onApp('term-popout-closed'");
    assert.ok(start >= 0, 'main.js 缺少 term-popout-closed 处理器');
    const body = mainSrc.slice(start, start + 700);
    assert.match(body, /d\.target !== wailsWindowName/, '只接自己被指定的会话');
    assert.match(body, /attachResumedTermSession/);
    assert.match(scopeSrc, /'term-popout-closed': 'app'/, '事件必须登记进 event-scope');
});

test('终端独立窗口启动走 terminal-only 分支', () => {
    assert.match(bridgeSrc, /await deps\.terminalWindowMode/);
    assert.match(bridgeSrc, /deps\.startTerminalWindowMode\(\)/);
    const fn = mainSrc.slice(mainSrc.indexOf('async function startTerminalWindowMode'));
    assert.match(fn, /terminal-only/, '必须打 terminal-only 形态标记');
    assert.match(fn, /GetStartupTermID/);
    assert.match(fn, /attachResumedTermSession/);
});
