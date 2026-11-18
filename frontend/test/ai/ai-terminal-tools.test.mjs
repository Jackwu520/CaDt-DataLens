// ai-terminal-tools 测试：终端输出的 ANSI 清洗、read 整形与 list 合并（纯函数，无 DOM）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatCommandDuration,
    formatTerminalList,
    formatTerminalRead,
    formatWaitDuration,
    normalizeTermText,
    stripAnsi,
    terminalSendLabel,
} from '../../src/ai/ai-terminal-tools.js';

test('stripAnsi：颜色、光标移动、OSC 标题都去掉', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain'), 'red plain');
    assert.equal(stripAnsi('\u001b]0;title\u0007PS C:\\>'), 'PS C:\\>');
    assert.equal(stripAnsi('a\u001b[2Kb'), 'ab');
    assert.equal(stripAnsi(null), '');
});

test('normalizeTermText：CRLF 归一、\\r 重绘取最后形态、去尾部空行', () => {
    assert.equal(normalizeTermText('a\r\nb\r\n'), 'a\nb');
    // 进度条：多次 \r 重绘同一行，只保留最后一次
    assert.equal(normalizeTermText('10%\r50%\r100%\n'), '100%');
    // ANSI 与重绘组合
    assert.equal(normalizeTermText('\u001b[32mok\u001b[0m\r\n\u001b[2Kdone\r'), 'ok\ndone');
});

test('formatTerminalRead：运行中 / 已退出 / 截断 / 空输出', () => {
    const running = formatTerminalRead('term-1', {text: 'hello\r\n', exited: false}, 4000);
    assert.match(running, /终端 term-1（运行中）/);
    assert.match(running, /hello/);

    const exited = formatTerminalRead('term-2', {text: 'bye', exited: true, exitCode: 3}, 4000);
    assert.match(exited, /已退出，退出码 3/);
    assert.match(exited, /bye/);

    const truncated = formatTerminalRead('term-3', {text: 'x', truncated: true}, 1200);
    assert.match(truncated, /最近约 1200 个字符/);

    const empty = formatTerminalRead('term-4', {text: ''}, 4000);
    assert.match(empty, /暂无输出/);
});

test('formatTerminalList：无终端时给 open 提示', () => {
    assert.match(formatTerminalList([], []), /没有打开的终端/);
    assert.match(formatTerminalList(null, undefined), /没有打开的终端/);
});

test('formatTerminalList：合并本地页签与后端状态，标注当前页签与最后一行', () => {
    const out = formatTerminalList(
        [{id: 'term-1', shell: 'pwsh', label: '本地', active: true}],
        [{id: 'term-1', shell: 'pwsh', exited: false, last: 'PS C:\\ws>'},
            {id: 'term-2', shell: 'cmd', exited: true, exitCode: 1, last: 'error'}],
    );
    assert.match(out, /内置终端（2 个）/);
    assert.match(out, /term-1（本地 · pwsh · 运行中 · 当前页签）.*最后一行：PS C:\\ws>/);
    assert.match(out, /term-2（cmd · 已退出（退出码 1））/);
    assert.match(out, /terminal read/);
});

test('terminalSendLabel：回车换成可见符号并截断', () => {
    assert.equal(terminalSendLabel('npm run dev\r'), 'npm run dev⏎');
    assert.equal(terminalSendLabel('a\nb\r\nc'), 'a⏎b⏎c');
    assert.equal(terminalSendLabel('x'.repeat(500), 10), 'xxxxxxxxxx…');
});

test('formatWaitDuration：秒 / 分钟 / 小时三档，非法与 0 返回空', () => {
    assert.equal(formatWaitDuration(9400), '9.4 秒');
    assert.equal(formatWaitDuration(42000), '42.0 秒');
    assert.equal(formatWaitDuration(60000), '1.0 分钟');
    assert.equal(formatWaitDuration(510000), '8.5 分钟');
    assert.equal(formatWaitDuration(3000000), '50 分钟');
    assert.equal(formatWaitDuration(35517800), '9.9 小时');
    assert.equal(formatWaitDuration(0), '');
    assert.equal(formatWaitDuration(null), '');
    assert.equal(formatWaitDuration(undefined), '');
    assert.equal(formatWaitDuration(-1), '');
    assert.equal(formatWaitDuration('abc'), '');
});

test('formatCommandDuration：秒 / 分钟进位 / 非法输入返回空', () => {
    assert.equal(formatCommandDuration(0), '0.00 s');
    assert.equal(formatCommandDuration(1250), '1.25 s');
    assert.equal(formatCommandDuration(12345), '12.3 s');
    assert.equal(formatCommandDuration(60000), '1 m 00 s');
    assert.equal(formatCommandDuration(125000), '2 m 05 s');
    // 59.9 s 舍入进位不出现「2 m 60 s」
    assert.equal(formatCommandDuration(119900), '2 m 00 s');
    assert.equal(formatCommandDuration(undefined), '');
    assert.equal(formatCommandDuration(null), '');
    assert.equal(formatCommandDuration(-1), '');
    assert.equal(formatCommandDuration('abc'), '');
});
