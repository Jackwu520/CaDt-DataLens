// explorer-undo-wiring.test.mjs：文件树撤销接线护栏（源码断言）。
// 这些接线分散在 explorer-ops.js 与 main.js，单测无法派发真实键盘事件，按项目惯例钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('四类文件树操作都进入撤销栈', () => {
    const ops = read('explorer/explorer-ops.js');
    // 删除 / 重命名 / 新建 / 移动（粘贴剪切与拖拽共用 recordMove）
    for (const pattern of [
        /history\.push\(\{[\s\S]*?undo: \(\) => performRestore\(items\)/,
        /history\.push\(\{[\s\S]*?label: '重命名/,
        /history\.push\(\{[\s\S]*?label: '新建/,
        /function recordMove\([\s\S]*?history\.push\(\{/,
    ]) {
        assert.match(ops, pattern, '文件树操作应记录可逆动作到历史栈');
    }
    assert.match(ops, /recordMove\(results, destDir\)/g, '粘贴剪切与拖拽移动都要记录历史');
});

test('删除的撤销走后端回收站还原，且不走不可恢复的直删', () => {
    const ops = read('explorer/explorer-ops.js');
    assert.match(ops, /deps\.backend\.RestoreEntry\(item\.path\)/);
    assert.match(ops, /当前版本不支持从回收站还原/);
    // performDelete 与 performRestore 是显式的两个函数：撤销时不能复用"删除"动作
    assert.match(ops, /async function performRestore\(items\)/);
});

test('回放不重复记操作留痕，也不产生新历史', () => {
    const ops = read('explorer/explorer-ops.js');
    assert.match(ops, /if \(!skipLog\) \{[\s\S]*?activityLog\.log\('file\.delete'/);
    assert.match(ops, /redo: \(\) => performDelete\(items, \{skipLog: true\}\)[\s\S]*?\}/);
    const hist = read('explorer/explorer-history.js');
    assert.match(hist, /if \(replaying\) return;/, '回放期间 push 必须被忽略');
});

test('刷新走差量通知而非整树 refresh', () => {
    const ops = read('explorer/explorer-ops.js');
    assert.match(ops, /function afterHistoryChange\(paths\)[\s\S]*?notifyFileChange\(path\)/);
    assert.doesNotMatch(ops, /afterHistoryChange[\s\S]{0,200}?refresh\(\)/, '历史刷新不能触发整树重建');
});

test('Ctrl+Z/Y 在文件树焦点时改走 explorerOps，不让编辑器撤销', () => {
    const main = read('main.js');
    assert.match(main, /function isExplorerUndoTarget\(\)[\s\S]*?explorer\.hasFocus\(\)/);
    const handler = `function handleExplorerUndoKey(e) {`;
    assert.ok(norm(main).includes(norm(handler)), '应有文件树快捷键统一入口');
    assert.match(main, /e\.ctrlKey && !e\.shiftKey && e\.key\.toLowerCase\(\) === 'z'\) \{\s*if \(isPlainTextUndoTarget\(\)\) return;\s*if \(handleExplorerUndoKey\(e\)\) return;/);
    assert.match(main, /e\.key\.toLowerCase\(\) === 'z'\)\)\) \{\s*if \(isPlainTextUndoTarget\(\)\) return;\s*if \(handleExplorerUndoKey\(e\)\) return;/);
    // 捕获层（Ace 空栈回退）也必须让开文件树
    const capture = main.match(/window\.addEventListener\('keydown', \(e\) => \{\s*if \(!e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;[\s\S]*?\}, true\);/);
    assert.ok(capture, 'Ctrl+Z 捕获拦截器应存在');
    assert.match(capture[0], /handleExplorerUndoKey\(e\)/);
});

test('右键菜单有撤销/重做入口，且能显示最近操作', () => {
    const ops = read('explorer/explorer-ops.js');
    assert.match(ops, /label: '撤销' \+ \(history\.canUndo\(\) \? '：' \+ history\.peekUndo\(\) : ''\)/);
    assert.match(ops, /label: '重做' \+ \(history\.canRedo\(\) \? '：' \+ history\.peekRedo\(\) : ''\)/);
    assert.match(ops, /action: \(\) => \{ undoExplorer\(\); \}/);
});

test('mock 后端明确拒绝还原，不静默成功', () => {
    const mock = read('dev/mock-backend.js');
    assert.match(mock, /async RestoreEntry\(path\)[\s\S]*?throw new Error\('调试模式不支持从回收站还原/);
});
