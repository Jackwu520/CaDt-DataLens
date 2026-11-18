// 快捷键注册表护栏（三套风格）。
// 目标：设置页表格只有一份文案来源（keybindings.js），且与 main.js 的真实绑定不漂移。
// 漂移事故：旧 index.html 手抄表里写「全屏 F11」「重命名 F2 / Shift+F6」，而代码里
// F11 是切书签、F2/Shift+F2 是跳书签、重命名只有右键菜单——表格一直在骗人。
// 风格化之后漂移面更大：同一动作在三套风格下键位不同，**表里写的必须就是按下去会响的**，
// 所以护栏钉死两条：① 风格间有差异的动作必须在 main.js 里被 keymap 分发；
// ② main.js 里被分发的动作必须在注册表里。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    KEY_BINDINGS, KEY_GROUPS, KEY_STYLES, DEFAULT_KEY_STYLE, DOUBLE_SHIFT,
    getShortcut, shortcutsByGroup, renderShortcutsTable, keyBindingsForStyle,
    findStyleConflicts, styleVariants, variesByStyle,
} from '../../src/core/keybindings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('注册表结构：id 唯一、分组合法、三套风格齐全', () => {
    const ids = KEY_BINDINGS.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, '动作 id 不得重复');
    for (const b of KEY_BINDINGS) {
        assert.ok(KEY_GROUPS.includes(b.group), `未知分组：${b.group}`);
        assert.ok(b.label && b.kind, `动作 ${b.id} 缺 label/kind`);
        assert.ok(b.kind === 'key' || b.kind === 'text', `动作 ${b.id} 的 kind 非法`);
        for (const style of KEY_STYLES) {
            assert.ok(Array.isArray(b.keys[style.id]) && b.keys[style.id].length,
                `动作 ${b.id} 缺 ${style.id} 键位`);
        }
    }
    assert.equal(DEFAULT_KEY_STYLE, 'candysweet', '默认是本软件当前实际生效的混合键位');
    assert.deepEqual(KEY_STYLES.map((s) => s.id), ['candysweet', 'jetbrains', 'vscode']);
});

test('每套风格内部的组合键互不冲突', () => {
    for (const style of KEY_STYLES) {
        const conflicts = findStyleConflicts(style.id);
        assert.deepEqual(conflicts, [],
            `${style.id} 风格内键位冲突：${conflicts.map((c) => `${c.combo}(${c.ids.join('/')})`).join(', ')}`);
    }
    // keyBindingsForStyle 跳过了描述性文本与双击 Shift 这类特殊触发
    const keys = keyBindingsForStyle('candysweet').map((b) => b.combo);
    assert.ok(!keys.includes(DOUBLE_SHIFT), '双击 Shift 不是组合键，不进冲突检测');
});

test('一个动作可以绑多个组合键', () => {
    assert.equal(getShortcut('edit.redo'), 'Ctrl+Y / Ctrl+Shift+Z', '重做两个组合');
    assert.equal(getShortcut('edit.globalSearch', 'vscode'), 'Ctrl+P / Ctrl+Shift+F', 'VS Code 风格全局搜索两个组合');
    assert.equal(getShortcut('view.sidebar'), 'Ctrl+B / Alt+1', '侧边栏两个组合');
});

test('getShortcut / shortcutsByGroup / renderShortcutsTable 与注册表一致', () => {
    assert.equal(getShortcut('edit.globalSearch'), DOUBLE_SHIFT);
    assert.equal(getShortcut('edit.format'), 'Ctrl+Alt+L');
    assert.equal(getShortcut('edit.format', 'jetbrains'), 'Ctrl+Alt+L');
    assert.equal(getShortcut('edit.format', 'vscode'), 'Alt+Shift+F');
    assert.equal(getShortcut('no.such.action'), '');
    const groups = shortcutsByGroup();
    assert.deepEqual([...groups.keys()], KEY_GROUPS, '分组顺序即展示顺序');
    const html = renderShortcutsTable();
    assert.match(html, /全局搜索[\s\S]*?双击 Shift/);
    assert.match(html, /切换当前行书签[\s\S]*?F11/);
    assert.ok(html.includes('class="kbd"'), '键位用 kbd 样式渲染，兼容既有 CSS');
    // 换风格后表格文案跟着变
    const vscode = renderShortcutsTable('vscode');
    assert.match(vscode, /格式化[\s\S]*?Alt\+Shift\+F/);
    assert.ok(!/全局搜索[\s\S]{0,80}?双击 Shift/.test(vscode), 'VS Code 风格不再用双击 Shift');
});

test('漂移已修正：书签键位对、全屏与重命名标注为无键盘快捷键', () => {
    assert.equal(getShortcut('edit.toggleBookmark'), 'F11');
    assert.equal(getShortcut('edit.nextBookmark'), 'F2');
    assert.equal(getShortcut('edit.prevBookmark'), 'Shift+F2');
    assert.equal(getShortcut('view.fullscreen'), '菜单操作', '全屏不绑键');
    assert.equal(getShortcut('tree.rename'), '右键菜单', '重命名不绑键');
    const html = renderShortcutsTable();
    assert.ok(!/重命名[\s\S]{0,40}F2/.test(html), '不能再把 F2 标成重命名');
    assert.ok(!/全屏[\s\S]{0,40}F11/.test(html), '不能再把 F11 标成全屏');
});

test('CandySweet 风格逐条等于软件当前真实生效的键位', () => {
    // 这些是「切风格前就在生效」的键，改注册表必须同步改真实行为。
    const expected = {
        'file.new': 'Ctrl+N', 'file.newWindow': 'Ctrl+Shift+N', 'file.open': 'Ctrl+O',
        'file.save': 'Ctrl+S', 'file.saveAs': 'Ctrl+Shift+S', 'file.closeTab': 'Ctrl+W',
        'file.reopenTab': 'Ctrl+Shift+T', 'file.settings': 'Ctrl+,',
        'edit.undo': 'Ctrl+Z', 'edit.redo': 'Ctrl+Y / Ctrl+Shift+Z', 'edit.format': 'Ctrl+Alt+L',
        'edit.find': 'Ctrl+F', 'edit.globalSearch': DOUBLE_SHIFT, 'edit.gotoLine': 'Ctrl+G',
        'run.current': 'F5', 'run.stop': 'Shift+F5', 'run.project': 'Ctrl+F5', 'run.panel': 'Alt+F11',
        'view.sidebar': 'Ctrl+B / Alt+1', 'view.terminal': 'Alt+F12', 'view.quickSwitch': 'Ctrl+`',
        'view.palette': 'Ctrl+Shift+P', 'ai.togglePanel': 'Alt+9',
    };
    for (const [id, combo] of Object.entries(expected)) {
        assert.equal(getShortcut(id), combo, `CandySweet 风格的 ${id} 键位变了`);
    }
});

test('main.js 真实绑定与注册表对账（源码断言）', () => {
    const main = read('src/main.js');
    // 书签三个键确实服务于书签（已改为查表分发）
    assert.match(main, /keymap\.is\(kb, 'edit\.nextBookmark'\)[\s\S]{0,120}?jumpBookmark\(1\)/);
    assert.match(main, /keymap\.is\(kb, 'edit\.prevBookmark'\)[\s\S]{0,120}?jumpBookmark\(-1\)/);
    assert.match(main, /keymap\.is\(kb, 'edit\.toggleBookmark'\)[\s\S]{0,160}?toggleBookmark\(\)/);
    // 注册表的动作在菜单里也有对应入口（F11 / F2 / Shift+F2 的 shortcut 文案）
    assert.match(main, /label: '书签： 切换当前行书签', shortcut: 'F11'/);
    assert.match(main, /label: '书签： 跳到下一个书签', shortcut: 'F2'/);
    assert.match(main, /label: '书签： 跳到上一个书签', shortcut: 'Shift\+F2'/);
});

test('表与行为不漂移：风格间有差异的动作必须真的被 keymap 分发', () => {
    const main = read('src/main.js');
    const dispatched = new Set([...main.matchAll(/keymap\.is\(kb, '([^']+)'\)/g)].map((m) => m[1]));
    assert.ok(dispatched.size > 20, `main.js 里应有大把查表分发，实际 ${dispatched.size}`);
    // ① 被分发的动作必须在注册表里
    for (const id of dispatched) {
        assert.ok(KEY_BINDINGS.some((b) => b.id === id), `main.js 分发了未登记的动作：${id}`);
    }
    // ② 风格间有差异的动作（切风格会改行为）必须被分发，否则表里写一套、实际按另一套
    for (const b of KEY_BINDINGS) {
        if (!variesByStyle(b.id)) continue;
        assert.ok(dispatched.has(b.id),
            `动作 ${b.id} 在风格间有差异（${JSON.stringify(styleVariants(b.id))}）但 main.js 没用 keymap 分发`);
    }
});

test('设置页表格由注册表渲染，index.html 不再手抄快捷键条目', () => {
    const html = read('index.html');
    const ui = read('src/settings/settings-ui.js');
    assert.match(html, /<div class="popover-shortcuts" id="shortcuts-table"><\/div>/);
    assert.ok(!/F2 \/ Shift\+F6/.test(html), 'index.html 不得残留旧的重命名文案');
    assert.ok(!/全屏 \/ 退出全屏<\/span><span class="kbd">F11/.test(html), 'index.html 不得残留旧的全屏文案');
    assert.match(ui, /from '\.\.\/core\/keybindings\.js';/);
    assert.match(ui, /renderShortcutsTable\(keymap\.style\)/, '表格必须按当前风格渲染');
    // 风格切换控件与落盘
    assert.match(html, /id="opt-key-style"/, '设置页要有快捷键风格下拉');
    assert.match(ui, /function setKeyStyle\(id\)/);
    assert.match(ui, /keymap\.setStyle\(value\)/, '切换必须换运行时索引');
    assert.match(ui, /deps\.settings\.keyStyle = value;/, '选择必须落盘');
});
