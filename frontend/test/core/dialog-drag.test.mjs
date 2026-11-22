// dialog-drag.test.mjs：对话框头部拖动的纯逻辑测试（node:test，手写 DOM 桩，无浏览器依赖）。
// 覆盖：只在句柄上按下才拖、exclude 元素不触发、首次按下归一到 fixed+像素定位并清 transform、
// 增量位移、左键限定、松开后停止、多规则（.dialog-head / .ai-dialog-head）、targetOf 自定义。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDialogDrag} from '../../src/core/dialog-drag.js';

function fakeEl(classes = []) {
    const set = new Set(classes);
    return {
        style: {},
        getBoundingClientRect() { return {left: 100, top: 200, width: 400, height: 300}; },
        closest(sel) {
            // 选择器形如 '.dialog-head' / 'button'：按 class 或 tag 匹配
            if (sel.startsWith('.')) return set.has(sel.slice(1)) ? this : null;
            if (sel === 'button') return set.has('button') ? this : null;
            return null;
        },
    };
}

function event(target, opts = {}) {
    return {
        target,
        button: opts.button === undefined ? 0 : opts.button,
        clientX: opts.clientX || 0,
        clientY: opts.clientY || 0,
        prevented: 0,
        preventDefault() { this.prevented++; },
    };
}

const DEFAULT_RULES = [
    {handle: '.dialog-head', exclude: '.dialog-close', clearTransform: true},
    {handle: '.ai-dialog-head', exclude: 'button'},
];

test('只在句柄上按下才拖动，首次归一到 fixed+像素定位并清 transform', () => {
    const drag = createDialogDrag(DEFAULT_RULES);
    const head = fakeEl(['dialog-head']);
    const dlg = fakeEl();
    head.parentElement = dlg;

    drag.onMouseDown(event(head, {clientX: 150, clientY: 250}));
    assert.equal(dlg.style.position, 'fixed');
    assert.equal(dlg.style.transform, 'none');
    assert.equal(dlg.style.left, '100px');
    assert.equal(dlg.style.top, '200px');

    // 增量位移：按下点 (150,250) → 移动到 (180,290)，位移 (+30,+40)
    drag.onMouseMove(event(null, {clientX: 180, clientY: 290}));
    assert.equal(dlg.style.left, '130px');
    assert.equal(dlg.style.top, '240px');

    drag.onMouseUp();
    drag.onMouseMove(event(null, {clientX: 300, clientY: 400}));
    assert.equal(dlg.style.left, '130px', '松开后不再跟随');
});

test('非句柄元素按下不触发；右键不触发', () => {
    const drag = createDialogDrag(DEFAULT_RULES);
    const other = fakeEl(['some-other']);
    drag.onMouseDown(event(other));
    assert.deepEqual(other.style, {});

    const head = fakeEl(['dialog-head']);
    const dlg = fakeEl();
    head.parentElement = dlg;
    drag.onMouseDown(event(head, {button: 2}));
    assert.deepEqual(dlg.style, {}, '右键不拖动');
});

test('exclude 元素（关闭按钮）不触发拖动', () => {
    const drag = createDialogDrag(DEFAULT_RULES);
    // target 同时命中 .dialog-head 与 .dialog-close：exclude 优先，放弃拖动
    const closeBtn = fakeEl(['dialog-head', 'dialog-close']);
    const dlg = fakeEl();
    closeBtn.parentElement = dlg;
    drag.onMouseDown(event(closeBtn));
    assert.deepEqual(dlg.style, {});
});

test('AI 弹窗句柄：flex 居中，不设 transform', () => {
    const drag = createDialogDrag(DEFAULT_RULES);
    const head = fakeEl(['ai-dialog-head']);
    const card = fakeEl();
    head.parentElement = card;
    drag.onMouseDown(event(head, {clientX: 10, clientY: 20}));
    assert.equal(card.style.position, 'fixed');
    assert.equal(card.style.transform, undefined, 'AI 弹窗不清 transform');
    assert.equal(card.style.left, '100px');
    assert.equal(card.style.top, '200px');
});

test('targetOf 自定义目标', () => {
    const custom = fakeEl();
    const drag = createDialogDrag([
        {handle: '.dialog-head', targetOf: () => custom, clearTransform: true},
    ]);
    const head = fakeEl(['dialog-head']);
    drag.onMouseDown(event(head, {clientX: 0, clientY: 0}));
    assert.equal(custom.style.left, '100px');
    assert.equal(custom.style.top, '200px');
});

test('install 把三个监听挂到目标上', () => {
    const drag = createDialogDrag(DEFAULT_RULES);
    const registered = [];
    drag.install({
        addEventListener(name) { registered.push(name); },
    });
    assert.deepEqual(registered, ['mousedown', 'mousemove', 'mouseup']);
});
