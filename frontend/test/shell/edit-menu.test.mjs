// shell/edit-menu：输入面右键编辑菜单（openEditMenu）与全局兜底（bindEditableContextMenuFallback）。
// 兜底的契约：defaultPrevented（已有自定义菜单接管）或目标不是输入面时不出手；
// 出手时 preventDefault + 打开应用编辑菜单——WebView2 原生编辑菜单由此全局消失。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openEditMenu, editableHasSelection, execEditable, pasteTextIntoEditable, bindEditableContextMenuFallback} from '../../src/shell/edit-menu.js';

// 轻量 DOM 桩：模块只在 window 缺 select 能力时才摸 window.getSelection
globalThis.window = {getSelection: () => null};

const labelsOf = (items) => items.filter((item) => item.label).map((item) => item.label);

function makeEvent(x = 10, y = 20) {
    return {clientX: x, clientY: y, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false};
}

test('openEditMenu：七项结构齐全，有选区时剪切/复制可用', () => {
    let captured = null;
    openEditMenu((items, x, y) => { captured = {items, x, y}; }, makeEvent(11, 22),
        {selectionStart: 2, selectionEnd: 5});
    assert.equal(captured.x, 11);
    assert.equal(captured.y, 22);
    assert.deepEqual(labelsOf(captured.items), ['撤销', '重做', '剪切', '复制', '粘贴', '全选']);
    const cut = captured.items.find((item) => item.label === '剪切');
    const copy = captured.items.find((item) => item.label === '复制');
    assert.equal(cut.disabled, false, '有选区可剪切');
    assert.equal(copy.disabled, false, '有选区可复制');
    for (const item of captured.items) {
        if (!item.sep) {
            assert.ok(item.icon, '菜单项缺 icon: ' + item.label);
            assert.equal(typeof item.action, 'function', '菜单项缺 action: ' + item.label);
        }
    }
});

test('openEditMenu：无选区时剪切/复制灰置', () => {
    let captured = null;
    openEditMenu((items) => { captured = items; }, makeEvent(), {});
    const cut = captured.find((item) => item.label === '剪切');
    const copy = captured.find((item) => item.label === '复制');
    assert.equal(cut.disabled, true);
    assert.equal(copy.disabled, true);
});

test('openEditMenu：options.paste 覆盖默认粘贴（composer 的图片/折叠分支）', () => {
    let captured = null;
    const customPaste = () => {};
    openEditMenu((items) => { captured = items; }, makeEvent(), {}, {paste: customPaste});
    const paste = captured.find((item) => item.label === '粘贴');
    assert.equal(paste.action, customPaste);
});

test('openEditMenu：showContextMenu 非函数时静默（旧调用方不报错）', () => {
    assert.doesNotThrow(() => openEditMenu(null, makeEvent(), {}));
});

test('editableHasSelection / execEditable：input 用 selectionStart 判定，命令走 execCommand', () => {
    assert.equal(editableHasSelection({selectionStart: 2, selectionEnd: 5}), true);
    assert.equal(editableHasSelection({selectionStart: 3, selectionEnd: 3}), false);
    assert.equal(editableHasSelection({}), false, '无数值选区回落 window.getSelection（桩返回 null）');
    let focused = false;
    let command = '';
    globalThis.document = {
        execCommand(cmd) { command = cmd; return true; },
    };
    const target = {focus() { focused = true; }};
    assert.equal(execEditable(target, 'copy'), true);
    assert.equal(focused, true, '先聚焦再执行命令');
    assert.equal(command, 'copy');
});

test('pasteTextIntoEditable：回读后端剪贴板插入；无文字返回 false 不动目标', async () => {
    let inserted = '';
    globalThis.document = {
        execCommand(cmd, _silent, text) { if (cmd === 'insertText') { inserted = text; return true; } return false; },
    };
    const target = {focus() {}, selectionStart: 1, selectionEnd: 3, value: 'abc'};
    const ok = await pasteTextIntoEditable(target, {GetClipboardText: async () => 'hi'});
    assert.equal(ok, true);
    assert.equal(inserted, 'hi');

    const target2 = {focus() {}};
    const miss = await pasteTextIntoEditable(target2, {GetClipboardText: async () => ''});
    assert.equal(miss, false);
});

test('pasteTextIntoEditable：execCommand 不可用时回退 setRangeText 并派发 input', async () => {
    let inputFired = 0;
    globalThis.document = {execCommand: () => false};
    const target = {
        focus() {},
        selectionStart: 1,
        selectionEnd: 3,
        value: 'abc',
        setRangeText(text, _s, _e, mode) { this.value = this.value.slice(0, 1) + text + this.value.slice(3); this._mode = mode; },
        dispatchEvent() { inputFired++; return true; },
    };
    const ok = await pasteTextIntoEditable(target, {GetClipboardText: async () => 'XY'});
    assert.equal(ok, true);
    assert.equal(target.value, 'aXY', '[1,3) 区间整体替换（bc 被 XY 换掉）');
    assert.equal(target._mode, 'end');
    assert.equal(inputFired, 1, '回退路径手动派发 input（composer 草稿检测依赖它）');
});

test('兜底：preventDefault 过（已有自定义菜单）不出手', () => {
    let handlers = [];
    globalThis.document = {addEventListener(_type, fn) { handlers.push(fn); }};
    let opened = 0;
    bindEditableContextMenuFallback(() => { opened++; });
    const ctxHandler = handlers[handlers.length - 1];
    const event = makeEvent();
    event.defaultPrevented = true; // 域处理器已 preventDefault（已开自定义菜单）
    event.target = {closest: () => ({tagName: 'INPUT'})};
    ctxHandler(event);
    assert.equal(opened, 0, '接管过的右键不再兜底');
    assert.equal(event.defaultPrevented, true, '兜底不再改 preventDefault 状态');
});

test('兜底：目标不是输入面不出手；是输入面则 preventDefault + 打开菜单', () => {
    let handlers = [];
    globalThis.document = {addEventListener(_type, fn) { handlers.push(fn); }};
    let opened = 0;
    let openedFirstItem = '';
    bindEditableContextMenuFallback((items) => { opened++; openedFirstItem = items[0].label; });
    const ctxHandler = handlers[handlers.length - 1];
    const miss = makeEvent();
    miss.target = {closest: () => null};
    ctxHandler(miss);
    assert.equal(opened, 0, '非输入面维持原行为');

    const hit = makeEvent();
    hit.target = {closest: () => ({tagName: 'INPUT'})};
    ctxHandler(hit);
    assert.equal(opened, 1);
    assert.equal(hit.defaultPrevented, true, '阻止原生菜单');
    assert.equal(openedFirstItem, '撤销');
});
