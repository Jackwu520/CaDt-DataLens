// 编辑器内键位表护栏：三套风格下键位不冲突、核心键语义正确、展示文案与表一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EDITOR_KEY_BINDINGS, editorKeyListFor, editorBindingsForStyle, formatAceKey,
    getEditorShortcut, findEditorStyleConflicts, editorStyleVariants,
    renderEditorShortcutsTable, CUSTOM_EXEC,
} from '../../src/core/editor-keybindings.js';
import {KEY_STYLES} from '../../src/core/keybindings.js';

test('表结构：id 唯一、三套风格字段齐全', () => {
    const ids = EDITOR_KEY_BINDINGS.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, '动作 id 不得重复');
    for (const b of EDITOR_KEY_BINDINGS) {
        assert.ok(b.label && b.aceCommand, `动作 ${b.id} 缺 label/aceCommand`);
        for (const s of KEY_STYLES) {
            assert.ok(Array.isArray(b.keys[s.id]), `${b.id} 缺 ${s.id} 键位数组`);
        }
    }
});

test('每套风格内部组合键互不冲突', () => {
    for (const s of KEY_STYLES) {
        const conflicts = findEditorStyleConflicts(s.id);
        assert.deepEqual(conflicts, [], `${s.id} 风格内键位冲突：${JSON.stringify(conflicts)}`);
    }
});

test('核心键语义：默认/JetBrains Ctrl+D 复制行、Ctrl+Y 删除行；VSCode Ctrl+D 多选', () => {
    assert.equal(getEditorShortcut('editorKey.duplicate', 'candysweet'), 'Ctrl+D');
    assert.equal(getEditorShortcut('editorKey.duplicate', 'jetbrains'), 'Ctrl+D');
    assert.equal(getEditorShortcut('editorKey.duplicate', 'vscode'), 'Ctrl+Shift+Alt+↓');
    assert.equal(getEditorShortcut('editorKey.removeLine', 'candysweet'), 'Ctrl+Y');
    assert.equal(getEditorShortcut('editorKey.removeLine', 'jetbrains'), 'Ctrl+Y');
    assert.equal(getEditorShortcut('editorKey.removeLine', 'vscode'), 'Ctrl+Shift+K');
    assert.equal(getEditorShortcut('editorKey.selectNextMatch', 'vscode'), 'Ctrl+D');
    assert.equal(getEditorShortcut('editorKey.selectNextMatch', 'candysweet'), '', '默认风格不启用多选');
    assert.equal(getEditorShortcut('editorKey.selectAllMatches', 'vscode'), 'Ctrl+Shift+L');
});

test('自定义命令标记正确（多选 / 切大小写走 custom exec）', () => {
    const byId = Object.fromEntries(EDITOR_KEY_BINDINGS.map((b) => [b.id, b]));
    assert.equal(byId['editorKey.selectNextMatch'].aceCommand, CUSTOM_EXEC.SELECT_NEXT_MATCH);
    assert.equal(byId['editorKey.selectAllMatches'].aceCommand, CUSTOM_EXEC.SELECT_ALL_MATCHES);
    assert.equal(byId['editorKey.toggleCase'].aceCommand, CUSTOM_EXEC.TOGGLE_CASE);
    // 内建命令复用 Ace exec，不自己实现
    assert.equal(byId['editorKey.duplicate'].aceCommand, 'duplicateSelection');
    assert.equal(byId['editorKey.removeLine'].aceCommand, 'removeline');
});

test('formatAceKey 方向键转箭头、连字符转加号', () => {
    assert.equal(formatAceKey('Ctrl-D'), 'Ctrl+D');
    assert.equal(formatAceKey('Ctrl-Shift-Alt-Down'), 'Ctrl+Shift+Alt+↓');
    assert.equal(formatAceKey('Alt-Shift-Up'), 'Alt+Shift+↑');
    assert.equal(formatAceKey('Ctrl-/'), 'Ctrl+/');
});

test('editorBindingsForStyle / editorStyleVariants 与表一致', () => {
    const rows = editorBindingsForStyle('vscode');
    assert.equal(rows.length, EDITOR_KEY_BINDINGS.length);
    const dup = rows.find((r) => r.id === 'editorKey.duplicate');
    assert.deepEqual(dup.keys, ['Ctrl-Shift-Alt-Down']);
    const variants = editorStyleVariants('editorKey.duplicate');
    assert.equal(variants.candysweet, 'Ctrl+D');
    assert.equal(variants.vscode, 'Ctrl+Shift+Alt+↓');
    assert.ok(variants.candysweet !== variants.vscode, '该动作应随风格变化');
});

test('renderEditorShortcutsTable 按风格渲染，空键显示破折号', () => {
    const html = renderEditorShortcutsTable('vscode');
    assert.match(html, /编辑器内键位/);
    assert.match(html, /多选下一个匹配[\s\S]*?Ctrl\+D/);
    assert.match(html, /class="kbd"/);
    const candy = renderEditorShortcutsTable('candysweet');
    assert.match(candy, /复制行 \/ 选区[\s\S]*?Ctrl\+D/);
    assert.ok(candy.includes('—'), '未启用动作应显示破折号');
});

test('editorKeyListFor 空风格回退默认', () => {
    const b = EDITOR_KEY_BINDINGS.find((x) => x.id === 'editorKey.duplicate');
    assert.deepEqual(editorKeyListFor(b, 'nope'), ['Ctrl-D']);
    assert.deepEqual(editorKeyListFor(null), []);
});
