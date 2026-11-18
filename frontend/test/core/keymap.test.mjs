// 快捷键分发层护栏（core/keymap.js）。
// 目标：① 事件 → 组合串的归一化要抗中文输入法（字母走 e.code 物理键位）；
// ② 一个动作可绑多个组合，命中任一即触发；③ 切风格立即换索引并通知订阅者。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {comboFromEvent, comboSpecFromText, createKeymap} from '../../src/core/keymap.js';
import {KEY_BINDINGS, KEY_STYLES, DEFAULT_KEY_STYLE, DOUBLE_SHIFT, keyListFor} from '../../src/core/keybindings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// 造一个按键事件：code 走物理键位，key 走字符。
function ev(code, key, mods = {}) {
    return {
        code, key,
        ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
    };
}

test('组合串归一化：修饰键顺序固定、主键取物理键位', () => {
    assert.equal(comboFromEvent(ev('KeyP', 'p', {ctrl: true, shift: true})), 'Ctrl+Shift+P');
    assert.equal(comboFromEvent(ev('F5', 'F5')), 'F5');
    assert.equal(comboFromEvent(ev('F5', 'F5', {shift: true})), 'Shift+F5');
    assert.equal(comboFromEvent(ev('Digit1', '1', {alt: true})), 'Alt+1');
    assert.equal(comboFromEvent(ev('Backquote', '`', {ctrl: true})), 'Ctrl+`');
    assert.equal(comboFromEvent(ev('Backquote', '`', {ctrl: true, shift: true})), 'Ctrl+Shift+`');
    assert.equal(comboFromEvent(ev('Comma', ',', {ctrl: true})), 'Ctrl+,');
    assert.equal(comboFromEvent(ev('Delete', 'Delete')), 'Delete');
    assert.equal(comboFromEvent(ev('Equal', '=', {ctrl: true})), 'Ctrl+=');
    assert.equal(comboFromEvent(ev('Minus', '-', {ctrl: true})), 'Ctrl+-');
});

test('中文输入法下字母仍按物理键位归一化（不被组字字符污染）', () => {
    // 组字中的「中」：e.key 是汉字，e.code 仍是 KeyZ
    assert.equal(comboFromEvent(ev('KeyZ', '中', {ctrl: true})), 'Ctrl+Z');
    assert.equal(comboFromEvent(ev('KeyS', '的', {ctrl: true})), 'Ctrl+S');
});

test('一个动作可绑多个组合：命中任一即触发', () => {
    const km = createKeymap({bindings: KEY_BINDINGS, style: DEFAULT_KEY_STYLE});
    assert.ok(km.is('Ctrl+Y', 'edit.redo'));
    assert.ok(km.is('Ctrl+Shift+Z', 'edit.redo'));
    assert.ok(!km.is('Ctrl+Z', 'edit.redo'));
    assert.ok(km.is('Ctrl+B', 'view.sidebar'));
    assert.ok(km.is('Alt+1', 'view.sidebar'));
});

test('切风格立即换索引，并通知订阅者', () => {
    const km = createKeymap({bindings: KEY_BINDINGS, style: DEFAULT_KEY_STYLE});
    const seen = [];
    km.subscribe((id) => seen.push(id));
    // CandySweet：格式化是 Ctrl+Alt+L；VS Code：Alt+Shift+F（顺序须与 comboFromEvent 归一一致）
    assert.ok(km.is('Ctrl+Alt+L', 'edit.format'));
    assert.ok(!km.is('Alt+Shift+F', 'edit.format'));
    assert.equal(km.setStyle('vscode'), true);
    assert.ok(km.is('Alt+Shift+F', 'edit.format'));
    assert.ok(!km.is('Ctrl+Alt+L', 'edit.format'), '旧风格的键位应立即失效');
    assert.deepEqual(seen, ['vscode']);
    assert.equal(km.style, 'vscode');
    // 非法风格 / 重复切换
    assert.equal(km.setStyle('nope'), false);
    assert.equal(km.setStyle('vscode'), false);
    assert.equal(km.style, 'vscode');
});

test('VS Code 风格：全局搜索走 Ctrl+P / Ctrl+Shift+F，双击 Shift 失效', () => {
    const km = createKeymap({bindings: KEY_BINDINGS, style: 'candysweet'});
    assert.ok(km.hasSpecial('edit.globalSearch', DOUBLE_SHIFT), '默认风格双击 Shift 生效');
    assert.ok(!km.is('Ctrl+P', 'edit.globalSearch'));
    km.setStyle('vscode');
    assert.ok(km.is('Ctrl+P', 'edit.globalSearch'));
    assert.ok(km.is('Ctrl+Shift+F', 'edit.globalSearch'));
    assert.ok(!km.hasSpecial('edit.globalSearch', DOUBLE_SHIFT), 'VS Code 风格双击 Shift 不再触发');
});

test('main.js 按键链确实查表分发，且双击 Shift 按风格开关', () => {
    const main = read('src/main.js');
    assert.match(main, /import \{[^}]*\bkeymap\b[^}]*\} from '\.\/core\/keymap\.js';/);
    assert.match(main, /const kb = keymap\.combo\(e\);/, '每次按键先归一化成组合串');
    assert.match(main, /keymap\.is\(kb, 'edit\.format'\)/);
    assert.match(main, /keymap\.is\(kb, 'edit\.globalSearch'\)/);
    assert.match(main, /keymap\.hasSpecial\('edit\.globalSearch', DOUBLE_SHIFT\)/, '双击 Shift 受风格控制');
    assert.ok(!/gsShiftCount|gsShiftAt/.test(main), '不得残留旧的三击计数变量');
});

// ==================== 组合串解析（press_key 支持组合键） ====================

function specFlags(spec) {
    return {
        ctrlKey: spec.modifiers.ctrl, altKey: spec.modifiers.alt,
        shiftKey: spec.modifiers.shift, metaKey: spec.modifiers.meta,
    };
}

test('comboSpecFromText：与 comboFromEvent 互逆（覆盖应用全部快捷键组合）', () => {
    for (const binding of KEY_BINDINGS) {
        if (binding.kind !== 'key') continue;
        for (const style of KEY_STYLES) {
            for (const combo of keyListFor(binding, style.id)) {
                if (combo === DOUBLE_SHIFT) continue;
                const spec = comboSpecFromText(combo);
                assert.equal(spec.ok, true, combo + ' 解析失败：' + (spec.error || ''));
                assert.equal(comboFromEvent({code: spec.code, key: spec.key, ...specFlags(spec)}), combo, '往返不一致：' + combo);
            }
        }
    }
});

test('comboSpecFromText：修饰键别名 / 主键别名 / 特殊主键', () => {
    let spec = comboSpecFromText('ctrl+shift+p');
    assert.equal(spec.combo, 'Ctrl+Shift+P');
    assert.equal(spec.key, 'P');
    assert.equal(spec.code, 'KeyP');
    spec = comboSpecFromText('Shift+a');
    assert.equal(spec.key, 'A');
    assert.equal(spec.code, 'KeyA');
    spec = comboSpecFromText('esc');
    assert.equal(spec.key, 'Escape');
    assert.equal(spec.combo, 'Escape');
    spec = comboSpecFromText('Alt+7');
    assert.equal(spec.code, 'Digit7');
    spec = comboSpecFromText('Ctrl+`');
    assert.equal(spec.code, 'Backquote');
    spec = comboSpecFromText('Ctrl+,');
    assert.equal(spec.code, 'Comma');
    spec = comboSpecFromText('Ctrl++');
    assert.equal(spec.key, '+');
    assert.equal(spec.code, 'Equal');
    spec = comboSpecFromText('Space');
    assert.equal(spec.key, ' ');
    assert.equal(spec.code, 'Space');
    spec = comboSpecFromText('option+cmd+left');
    assert.equal(spec.combo, 'Alt+Meta+ArrowLeft');
    // 未登记的单字符主键仍可派发（code 为空，靠 e.key 归一）
    spec = comboSpecFromText('Ctrl+中');
    assert.equal(spec.ok, true);
    assert.equal(spec.code, '');
});

test('comboSpecFromText：无法识别时明确报错', () => {
    assert.equal(comboSpecFromText('').ok, false);
    assert.match(comboSpecFromText('Ctrl+').error, /格式/);
    assert.match(comboSpecFromText('Ctrl+Shift').error, /缺少主键/);
    assert.match(comboSpecFromText('Hyper+P').error, /修饰键/);
    assert.match(comboSpecFromText('Ctrl+Foo').error, /不认识的按键/);
});
