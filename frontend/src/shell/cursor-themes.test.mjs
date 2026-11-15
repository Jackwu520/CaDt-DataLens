// cursor-themes.test.mjs：全局拖拽态自愈的回归测试（最小假 DOM，不需要浏览器）。
// 锁住「大部分区域变左右箭头 + 完全点不动」的两条链路：
//   A. Wails frameless 的 resizeEdge / html 内联光标残留 → 误入系统模态 sizing loop；
//   B. body.cursor-ew / csv-col-resizing / userSelect 残留 → 全局光标与点击被吞。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCursorThemes} from './cursor-themes.js';

class FakeClassList {
    constructor() { this.items = new Set(); }
    add(...names) { for (const n of names) this.items.add(n); }
    remove(...names) { for (const n of names) this.items.delete(n); }
    contains(name) { return this.items.has(name); }
    toggle(name, force) { if (force) this.add(name); else this.remove(name); }
}

function harness(flagOverrides = {}) {
    const listeners = {window: {}, document: {}};
    const addTo = (target) => (type, fn, opts) => {
        const capture = opts === true || (opts && opts.capture === true);
        (listeners[target][type] || (listeners[target][type] = [])).push({fn, capture});
    };
    const body = {classList: new FakeClassList(), style: {}};
    const root = {style: {}};
    const doc = {
        body,
        documentElement: root,
        addEventListener: addTo('document'),
        getElementById: () => null,
        createElement: () => ({style: {}}),
        head: {appendChild() {}},
    };
    const flags = {
        enableResize: true,
        borderThickness: 6,
        resizeEdge: undefined,
        ...flagOverrides,
    };
    const win = {
        outerWidth: 1000,
        outerHeight: 800,
        wails: {flags},
        addEventListener: addTo('window'),
    };
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    globalThis.window = win;
    globalThis.document = doc;
    const api = createCursorThemes({backend: {}});
    const fire = (target, type, event = {}) => {
        const list = (listeners[target][type] || []).slice();
        // 真实事件流里捕获阶段先于冒泡阶段
        list.sort((a, b) => Number(b.capture) - Number(a.capture));
        for (const item of list) item.fn(event);
    };
    const addStuckState = () => {
        body.classList.add('cursor-ew', 'cursor-ns', 'csv-col-resizing');
        body.style.userSelect = 'none';
        flags.resizeEdge = 'w-resize';
        root.style.cursor = 'w-resize';
    };
    const assertClean = () => {
        assert.equal(body.classList.contains('cursor-ew'), false);
        assert.equal(body.classList.contains('cursor-ns'), false);
        assert.equal(body.classList.contains('csv-col-resizing'), false);
        assert.equal(body.style.userSelect, '');
        assert.equal(flags.resizeEdge, undefined);
        assert.equal(root.style.cursor, '');
    };
    return {
        api, body, root, flags, fire, addStuckState, assertClean,
        restore() {
            globalThis.window = prevWindow;
            globalThis.document = prevDocument;
        },
    };
}

test('setDragCursor(null) 清干净前端全局拖拽态', () => {
    const h = harness();
    try {
        h.body.classList.add('cursor-ew', 'csv-col-resizing');
        h.body.style.userSelect = 'none';
        h.api.setDragCursor(null);
        assert.equal(h.body.classList.contains('cursor-ew'), false);
        assert.equal(h.body.classList.contains('csv-col-resizing'), false);
        assert.equal(h.body.style.userSelect, '');
    } finally { h.restore(); }
});

test('pointerup 捕获阶段清残留，且不受业务 stopPropagation 影响', () => {
    const h = harness();
    try {
        h.addStuckState();
        h.fire('window', 'pointerup');
        assert.equal(h.body.classList.contains('cursor-ew'), false);
        assert.equal(h.body.classList.contains('csv-col-resizing'), false);
        assert.equal(h.body.style.userSelect, '');
    } finally { h.restore(); }
});

test('无按键的 pointermove 自愈；拖拽中 buttons=1 不误伤', () => {
    const h = harness();
    try {
        h.addStuckState();
        h.fire('window', 'pointermove', {buttons: 1});
        assert.equal(h.body.classList.contains('cursor-ew'), true);
        h.fire('window', 'pointermove', {buttons: 0});
        assert.equal(h.body.classList.contains('cursor-ew'), false);
        assert.equal(h.body.classList.contains('csv-col-resizing'), false);
    } finally { h.restore(); }
});

test('enableResize 关闭时，在窗口中间 mousedown 会清掉 Wails 残留', () => {
    const h = harness({enableResize: false, resizeEdge: 'e-resize'});
    try {
        h.root.style.cursor = 'e-resize';
        h.fire('window', 'mousedown', {clientX: 500, clientY: 400, buttons: 1});
        assert.equal(h.flags.resizeEdge, undefined);
        assert.equal(h.root.style.cursor, '');
    } finally { h.restore(); }
});

test('resizeEdge 与鼠标位置不符时清残留，避免误入系统 sizing loop', () => {
    const h = harness({resizeEdge: 'w-resize'});
    try {
        h.root.style.cursor = 'w-resize';
        h.fire('window', 'mousedown', {clientX: 500, clientY: 400, buttons: 1});
        assert.equal(h.flags.resizeEdge, undefined);
        assert.equal(h.root.style.cursor, '');
    } finally { h.restore(); }
});

test('鼠标确实在 6px 边缘时保留 resizeEdge，不破坏正常拖窗口', () => {
    const h = harness({resizeEdge: 'e-resize'});
    try {
        h.root.style.cursor = 'e-resize';
        h.fire('window', 'mousedown', {clientX: 998, clientY: 400, buttons: 1});
        assert.equal(h.flags.resizeEdge, 'e-resize');
        assert.equal(h.root.style.cursor, 'e-resize');
    } finally { h.restore(); }
});

test('窗口尺寸变化且 resize 已禁用时清残留；页面隐藏同样清理', () => {
    const h = harness({enableResize: false, resizeEdge: 'nw-resize'});
    try {
        h.root.style.cursor = 'nw-resize';
        h.fire('window', 'resize');
        assert.equal(h.flags.resizeEdge, undefined);
        assert.equal(h.root.style.cursor, '');
        h.flags.resizeEdge = 's-resize';
        h.root.style.cursor = 's-resize';
        h.fire('document', 'visibilitychange');
        assert.equal(h.flags.resizeEdge, undefined);
        assert.equal(h.root.style.cursor, '');
    } finally { h.restore(); }
});

test('clearDragState() 一次清掉前端态与 Wails 态', () => {
    const h = harness();
    try {
        h.addStuckState();
        h.api.clearDragState();
        h.assertClean();
    } finally { h.restore(); }
});
