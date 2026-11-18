// 终端按键语义分流纯函数测试：Ctrl+C 选区复制 / SIGINT 放行、Ctrl+Shift+V 粘贴、
// 其余组合照常透传给 PTY。用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {termKeyAction} from '../../src/terminal/term-keys.js';

function key(mods, k) {
    return {type: 'keydown', ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
        altKey: !!mods.alt, metaKey: !!mods.meta, key: k};
}

test('Ctrl+C：有选中 → 复制（不再把 \\x03 发给 shell）', () => {
    assert.equal(termKeyAction(key({ctrl: true}, 'c'), true), 'copy');
    assert.equal(termKeyAction(key({ctrl: true}, 'C'), true), 'copy');
});

test('Ctrl+C：无选中 → 放行（SIGINT 中断前台程序）', () => {
    assert.equal(termKeyAction(key({ctrl: true}, 'c'), false), 'send');
});

test('Ctrl+Shift+C：有选中 → 复制，无选中 → 放行', () => {
    assert.equal(termKeyAction(key({ctrl: true, shift: true}, 'C'), true), 'copy');
    assert.equal(termKeyAction(key({ctrl: true, shift: true}, 'C'), false), 'send');
});

test('Ctrl+Shift+V → 粘贴；Ctrl+V 放行（走浏览器原生 paste 事件）', () => {
    assert.equal(termKeyAction(key({ctrl: true, shift: true}, 'v'), false), 'paste');
    assert.equal(termKeyAction(key({ctrl: true, shift: true}, 'V'), true), 'paste');
    assert.equal(termKeyAction(key({ctrl: true}, 'v'), false), 'send');
});

test('无 Ctrl 或带 alt/meta 一律放行（终端快捷键如 Ctrl+L、Ctrl+D 不受影响）', () => {
    assert.equal(termKeyAction(key({}, 'c'), true), 'send');
    assert.equal(termKeyAction(key({shift: true}, 'c'), true), 'send');
    assert.equal(termKeyAction(key({ctrl: true, alt: true}, 'c'), true), 'send');
    assert.equal(termKeyAction(key({ctrl: true, meta: true}, 'c'), true), 'send');
    assert.equal(termKeyAction(key({ctrl: true}, 'l'), false), 'send');
    assert.equal(termKeyAction(key({ctrl: true}, 'd'), false), 'send');
});

test('key 缺省（异常事件）不放行也不误触发', () => {
    assert.equal(termKeyAction({type: 'keydown', ctrlKey: true, shiftKey: false,
        altKey: false, metaKey: false}, true), 'send');
});
