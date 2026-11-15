// editor-ace-hooks.test.mjs：adjustCodeFoldRange（折叠范围调整）纯函数测试。
// 背景：Ace cstyle 折叠范围起始在开括号后、结束在闭括号前，花括号块配默认占位符
// 正好渲染成 {...}；Go 的 import ( ) 块需要把圆括号本体折进去，折叠后显示 import ...。
import test from 'node:test';
import assert from 'node:assert/strict';
import {adjustCodeFoldRange} from './editor-ace-hooks.js';

// 模拟 session.getLine：按行给文本
function fakeSession(lines) {
    return (row) => lines[row];
}

// cstyle 折叠范围：start 在开括号后一列，end 在闭括号所在列（不含闭括号）
function cstyleRange(startRow, startColumn, endRow, endColumn) {
    return {start: {row: startRow, column: startColumn}, end: {row: endRow, column: endColumn}};
}

test('adjustCodeFoldRange: import 圆括号块把括号本体折进去', () => {
    const getLine = fakeSession(['import (', '"strings"', '"testing"', ')']);
    const range = cstyleRange(0, 8, 3, 0); // ( "strings" "testing" <此处> )
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.deepEqual(adjusted.start, {row: 0, column: 7}, 'start 移到 ( 所在列');
    assert.deepEqual(adjusted.end, {row: 3, column: 1}, 'end 越过 ) 一列');
});

test('adjustCodeFoldRange: import 无空格直接跟 ( 也生效', () => {
    const getLine = fakeSession(['import("strings")']);
    const range = cstyleRange(0, 7, 0, 16);
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.equal(adjusted.start.column, 6);
    assert.equal(adjusted.end.column, 17);
});

test('adjustCodeFoldRange: 闭括号后还有内容时 end 仍越过 )', () => {
    const getLine = fakeSession(['import (', '"strings"', ') // 内置块']);
    const range = cstyleRange(0, 8, 2, 0);
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.equal(adjusted.end.column, 1);
});

test('adjustCodeFoldRange: 非 import 的圆括号块不动', () => {
    const getLine = fakeSession(['foo(', 'arg,', ')']);
    const range = cstyleRange(0, 4, 2, 0);
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.equal(adjusted.start.column, 4);
    assert.equal(adjusted.end.column, 0);
});

test('adjustCodeFoldRange: var/const 圆括号块不动（只有 import 特判）', () => {
    const getLine = fakeSession(['var (', 'a = 1', ')']);
    const range = cstyleRange(0, 5, 2, 0);
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.equal(adjusted.start.column, 5);
});

test('adjustCodeFoldRange: 花括号块不动（{ 留在行尾、} 留在占位符后 → {...}）', () => {
    const getLine = fakeSession(['if shell != "bash" {', 't.Fatal()', '}']);
    const range = cstyleRange(0, 20, 2, 0);
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.equal(adjusted.start.column, 20);
    assert.equal(adjusted.end.column, 0);
});

test('adjustCodeFoldRange: import 字样出现在行中不误判', () => {
    const getLine = fakeSession(['mod.import (', 'x', ')']);
    const range = cstyleRange(0, 12, 2, 0);
    const adjusted = adjustCodeFoldRange(getLine, range);
    assert.equal(adjusted.start.column, 12);
});

test('adjustCodeFoldRange: 健壮性——空/残缺/Fold 形状的原样返回', () => {
    const getLine = fakeSession(['import (', ')']);
    assert.equal(adjustCodeFoldRange(getLine, null), null);
    assert.deepEqual(adjustCodeFoldRange(getLine, {}), {});
    const foldLike = cstyleRange(0, 8, 1, 0);
    foldLike.range = {start: foldLike.start, end: foldLike.end}; // 已是 Fold 实例
    const passed = adjustCodeFoldRange(getLine, foldLike);
    assert.equal(passed.start.column, 8);
});
