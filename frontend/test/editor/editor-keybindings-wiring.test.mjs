// 编辑器内键位接线守卫：键位表 → 运行时重绑 → 组合根注入 → 建编辑器/切风格两处生效。
// 纯源码断言，不启动浏览器；防止「表写了但没接线」的静默失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const main = read('src/main.js');
const groups = read('src/editor/editor-groups.js');
const aceHooks = read('src/editor/editor-ace-hooks.js');
const ui = read('src/settings/settings-ui.js');
const runtime = read('src/editor/editor-keybindings.js');

test('组合根创建实例并注入两个消费方', () => {
    assert.match(main, /import \{createEditorKeybindings\} from '\.\/editor\/editor-keybindings\.js'/);
    assert.match(main, /const editorKeybindings = createEditorKeybindings\(/);
    // settingsUI 切风格时 applyToAll
    assert.match(main, /get applyEditorKeybindingsToAll\(\) \{ return \(\) => editorKeybindings\.applyToAll\(\); \}/);
    // editorGroups 建编辑器时 applyTo
    assert.match(main, /get applyEditorKeybindings\(\) \{ return \(aceEditor\) => editorKeybindings\.applyTo\(aceEditor\); \}/);
});

test('建编辑器时调用 applyTo（Ace commands 就绪后）', () => {
    assert.match(groups, /deps\.applyEditorKeybindings\(ed\.aceEditor\)/,
        'createDocEditor 的 aceEditor 挂接块必须调用 applyTo');
    assert.match(aceHooks, /deps\.applyEditorKeybindings\(deps\.editor\.aceEditor\)/,
        'applyAceMode 里也要重绑（模式切换后 Ace 实例若重建可恢复，幂等无害）');
});

test('切风格时调用 applyToAll（已开编辑器即时换键位）', () => {
    assert.match(ui, /function setKeyStyle\(id\)/);
    assert.match(ui, /keymap\.setStyle\(value\)/);
    assert.match(ui, /deps\.applyEditorKeybindingsToAll\(\)/,
        'setKeyStyle 必须重绑所有已开编辑器');
});

test('设置页表格追加编辑器键位分组', () => {
    assert.match(ui, /import \{renderEditorShortcutsTable\} from '\.\.\/core\/editor-keybindings\.js'/);
    assert.match(ui, /renderShortcutsTable\(keymap\.style\)[\s\S]{0,120}renderEditorShortcutsTable\(keymap\.style\)/,
        '全局表下方要追加编辑器内键位表');
});

test('运行时重绑策略：精确解绑冲突键 + 专属命令名 + 幂等', () => {
    assert.match(runtime, /commands\.bindKey\(key, null\)/, '必须精确解绑被占用的键');
    assert.match(runtime, /commands\.removeCommand\(name\)/, '幂等：清掉本模块上次注册的命令');
    assert.match(runtime, /commands\.addCommand\(\{name: item\.name, exec: item\.exec, bindKey: item\.keys\.join\('\|'\)\}\)/,
        '按当前风格重新绑定');
    assert.match(runtime, /OWNED_PREFIX/, '用专属前缀隔离本模块的命令，不碰 Ace 内建命令');
});

test('自定义多选命令用 session 文本查找 + addRange，不依赖缺失的 Ace 命令', () => {
    assert.match(runtime, /function selectNextMatch\(editor\)/);
    assert.match(runtime, /function selectAllMatches\(editor\)/);
    assert.match(runtime, /sel\.addRange\(target, true\)/, '多选下一个匹配要把新 range 加入选区');
    assert.match(runtime, /function allMatchRanges\(/, '自己逐行查找，不依赖 session.find 的 options 机制');
    assert.match(runtime, /got\.bareWord/, '光标停在词上第一次按 Ctrl+D 先选中该词');
});

test('新测试已登记进 npm test 清单', () => {
    const pkg = JSON.parse(read('package.json'));
    const allScripts = Object.values(pkg.scripts || {}).join(' ');
    assert.match(allScripts, /test\/core\/editor-keybindings\.test\.mjs/);
    assert.match(allScripts, /test\/editor\/editor-keybindings-wiring\.test\.mjs/);
});
