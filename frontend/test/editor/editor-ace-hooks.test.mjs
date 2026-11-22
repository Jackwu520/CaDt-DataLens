// editor-ace-hooks.test.mjs：adjustCodeFoldRange（折叠范围调整）纯函数测试
// + python token 染色（py-builtin / py-kwarg / py-doc）规则与补色时机测试。
// 背景：Ace cstyle 折叠范围起始在开括号后、结束在闭括号前，花括号块配默认占位符
// 正好渲染成 {...}；Go 的 import ( ) 块需要把圆括号本体折进去，折叠后显示 import ...。
// 染色部分：Ace 原生分词器把 __name__ 等双下划线预定义名当普通 identifier（白），
// 紫色等增强色是渲染后事后补染——补色必须发生在本帧绘制前（MutationObserver 微任务 /
// afterRender 同步执行），任何 setTimeout 去抖都会晚于绘制，肉眼看到「白→紫」闪烁。
import test from 'node:test';
import assert from 'node:assert/strict';
import {adjustCodeFoldRange, createEditorAceHooks} from '../../src/editor/editor-ace-hooks.js';

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

// —— python token 染色（py-builtin / py-kwarg / py-doc）——

// 极简 DOM 桩：classList + children 树，querySelectorAll 支持逗号分隔的类选择器
function el(cls, text = '', children = []) {
    const classes = new Set(String(cls).split(/\s+/).filter(Boolean));
    return {
        textContent: text,
        children,
        classList: {
            contains: (c) => classes.has(c),
            add: (...cs) => cs.forEach((c) => classes.add(c)),
            remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        },
        querySelectorAll(selector) {
            const groups = selector.split(',').map((part) => part.trim().split('.').filter(Boolean));
            const found = [];
            const walk = (parent) => {
                for (const child of parent.children) {
                    if (groups.some((names) => names.every((n) => child.classList.contains(n)))) found.push(child);
                    walk(child);
                }
            };
            walk(this);
            return found;
        },
    };
}

// MutationObserver 桩：浏览器里观察回调在渲染任务后的微任务、本帧绘制前同步执行；
// 测试用 flush() 手动派发，断言回调体内直接补色（不含任何定时器调度）
const observers = [];
class StubObserver {
    constructor(cb) {
        this.cb = cb;
        observers.push(this);
    }
    observe() {}
    flush() {
        this.cb([], this);
    }
}
globalThis.MutationObserver = StubObserver;

// 假 Ace：ace-mode-python 容器 + text layer；lines 是 [class, text] 二元组的数组
function pythonAce(lines) {
    const lineEls = lines.map((spans) => el('ace_line', '', spans.map(([c, t]) => el(c, t))));
    const layer = el('ace_text-layer', '', lineEls);
    const container = el('ace-mode-python');
    container.querySelector = (sel) => (sel === '.ace_text-layer' ? layer : null);
    const listeners = {};
    const ace = {
        container,
        renderer: {on: (ev, fn) => { (listeners[ev] ??= []).push(fn); }},
    };
    return {ace, layer, lineEls, listeners};
}

// 用户实测行：if __name__ == "__main__":
function nameLine() {
    return [
        ['ace_keyword', 'if'],
        ['ace_identifier', '__name__'],
        ['ace_keyword ace_operator', '=='],
        ['ace_string', '"__main__"'],
        ['ace_punctuation', ':'],
    ];
}

test('applyPythonTokenClasses: __name__ 补 py-builtin（双下划线预定义名紫）', () => {
    const {ace, lineEls} = pythonAce([nameLine()]);
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    assert.equal(lineEls[0].children[1].classList.contains('py-builtin'), true, '__name__ 应为紫');
    assert.equal(lineEls[0].children[3].classList.contains('py-doc'), false, '行不是整行字符串，不加 py-doc');
    assert.equal(lineEls[0].children[0].classList.contains('py-builtin'), false);
});

test('applyPythonTokenClasses: 括号内 标识符=值 补 py-kwarg（调用参数名）', () => {
    const {ace, lineEls} = pythonAce([[
        ['ace_identifier', 'foo'],
        ['ace_paren ace_operator', '('],
        ['ace_identifier', 'x'],
        ['ace_keyword ace_operator', '='],
        ['ace_constant ace_numeric', '1'],
        ['ace_paren ace_operator', ')'],
    ]]);
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    assert.equal(lineEls[0].children[2].classList.contains('py-kwarg'), true, 'x 是 kwarg');
    assert.equal(lineEls[0].children[0].classList.contains('py-kwarg'), false, 'foo 不是 kwarg');
});

test('applyPythonTokenClasses: 整行字符串补 py-doc', () => {
    const {ace, lineEls} = pythonAce([[
        ['ace_string', '"""docstring line"""'],
    ]]);
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    assert.equal(lineEls[0].children[0].classList.contains('py-doc'), true);
});

test('applyPythonTokenClasses: def/class 行整体跳过（形参不吃 kwarg 色）', () => {
    const {ace, lineEls} = pythonAce([[
        ['ace_keyword', 'def'],
        ['ace_identifier ace_function-name', 'foo'],
        ['ace_paren ace_operator', '('],
        ['ace_identifier', 'x'],
        ['ace_keyword ace_operator', '='],
        ['ace_constant ace_numeric', '1'],
        ['ace_paren ace_operator', ')'],
        ['ace_punctuation', ':'],
    ]]);
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    for (const span of lineEls[0].children) {
        assert.equal(span.classList.contains('py-kwarg'), false, 'def 行不做 kwarg 染色');
        assert.equal(span.classList.contains('py-builtin'), false);
    }
});

test('applyPythonTokenClasses: 括号外 标识符=值 不吃 kwarg 色（赋值不是 kwarg）', () => {
    const {ace, lineEls} = pythonAce([[
        ['ace_identifier', 'x'],
        ['ace_keyword ace_operator', '='],
        ['ace_constant ace_numeric', '1'],
    ]]);
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    assert.equal(lineEls[0].children[0].classList.contains('py-kwarg'), false);
});

test('applyPythonTokenClasses: 先清残留增强类再重补（防叠加）', () => {
    const {ace, lineEls} = pythonAce([[
        ['ace_identifier py-doc py-builtin', 'plain_name'],
    ]]);
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    const span = lineEls[0].children[0];
    assert.equal(span.classList.contains('py-doc'), false, '残留 py-doc 应被清掉');
    assert.equal(span.classList.contains('py-builtin'), false, '普通标识符不吃 builtin 色');
});

test('applyPythonTokenClasses: 非 python 模式不动 DOM', () => {
    const {ace, lineEls} = pythonAce([nameLine()]);
    ace.container = el('ace-mode-json');
    createEditorAceHooks({}).applyPythonTokenClasses(ace);
    for (const span of lineEls[0].children) {
        assert.equal(span.classList.contains('py-builtin'), false);
        assert.equal(span.classList.contains('py-kwarg'), false);
        assert.equal(span.classList.contains('py-doc'), false);
    }
});

test('hookPythonTokenClasses: 挂载即同步染色（旧 30ms 去抖实现此刻还是白字）', () => {
    const {ace, lineEls} = pythonAce([nameLine()]);
    const before = observers.length;
    createEditorAceHooks({}).hookPythonTokenClasses(ace);
    assert.equal(lineEls[0].children[1].classList.contains('py-builtin'), true, 'hook 返回时必须已补色');
    assert.equal(observers.length, before + 1, '应注册 MutationObserver');
    assert.equal(ace._pythonTokenHooked, true);
    // 幂等：重复 hook 不再注册观察器
    createEditorAceHooks({}).hookPythonTokenClasses(ace);
    assert.equal(observers.length, before + 1);
});

test('hookPythonTokenClasses: 击键重建行 DOM 后，观察回调同步补色（绘制前，无闪烁）', () => {
    const {ace, layer} = pythonAce([nameLine()]);
    createEditorAceHooks({}).hookPythonTokenClasses(ace);
    // 模拟击键：Ace 整行重建 DOM，py-* 类随重建丢失
    const rebuilt = el('ace_line', '', nameLine().map(([c, t]) => el(c, t)));
    layer.children[0] = rebuilt;
    // 浏览器里此刻是渲染任务后的微任务、绘制前
    observers.at(-1).flush();
    assert.equal(rebuilt.children[1].classList.contains('py-builtin'), true, '观察回调必须同步补回紫色');
});

test('hookPythonTokenClasses: afterRender 回调直接补色（不经定时器）', () => {
    const {ace, layer, listeners} = pythonAce([nameLine()]);
    createEditorAceHooks({}).hookPythonTokenClasses(ace);
    const rebuilt = el('ace_line', '', nameLine().map(([c, t]) => el(c, t)));
    layer.children[0] = rebuilt;
    const handlers = listeners['afterRender'] || [];
    assert.ok(handlers.length, '应注册 afterRender 钩子');
    for (const handler of handlers) handler();
    assert.equal(rebuilt.children[1].classList.contains('py-builtin'), true);
});
