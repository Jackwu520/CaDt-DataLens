// 通用确认框的可选触发键（options.keys）护栏。
// 场景：AI 消息原地编辑点「重新发送」时弹出的二次确认框，焦点仍在编辑区 textarea 上，
// 用户按 Enter 期望等同点「重新发送」。为此给 openConfirmDialog 加第 6 参 options.keys，
// 在 window 捕获阶段绑定触发键。Esc 仍归 overlay-stack，不在此列。
// 依赖真实 DOM 与 Wails 后端，按项目惯例用源码断言钉住接线点。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

function sliceFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, '找不到函数：' + marker);
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\n {0,2}(?:async )?function /);
    return next < 0 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

const writing = read('writing/writing-mode.js');

test('openConfirmDialog 接受第 6 参 options，解析 keys 为数组', () => {
    const open = sliceFunction(writing, 'function openConfirmDialog(');
    assert.match(open, /function openConfirmDialog\(message, action, okLabel, title, variant, options\)/);
    assert.match(open, /const rawKeys = options && options\.keys;/);
    assert.match(open, /Array\.isArray\(rawKeys\) \? rawKeys\.slice\(\) : \[rawKeys\]/,
        '字符串和数组都支持，且对数组做拷贝避免外部改动影响');
    assert.match(open, /confirmKeys = rawKeys \?/);
});

test('触发键监听在 window 捕获阶段，守卫齐全', () => {
    // 必须 window + capture：弹框时焦点仍在触发它的输入框，冒泡会被它自己的 handler 截断
    assert.match(writing, /window\.addEventListener\('keydown', \(e\) => \{[\s\S]*?\}, \{capture: true\}\);/);
    const listener = sliceFunction(writing, "window.addEventListener('keydown', (e) => {");
    assert.match(listener, /confirmKeys\.length/);
    assert.match(listener, /e\.defaultPrevented \|\| e\.isComposing \|\| e\.keyCode === 229/, '输入法组词态放行');
    assert.match(listener, /e\.shiftKey \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey/, '带修饰键不触发');
    assert.match(listener, /elsDialogs\.confirm\.classList\.contains\('hidden'\)/, '框不可见时不触发');
    assert.match(listener, /confirmKeys\.includes\(e\.key\)/);
    assert.match(listener, /e\.stopImmediatePropagation\(\)/);
    assert.match(listener, /submitConfirm\(\)/);
});

test('确认提交后清空本次绑定键，避免残留', () => {
    const submit = sliceFunction(writing, 'function submitConfirm() {');
    assert.match(submit, /confirmKeys = \[\];/);
});

test('重新发送确认框显式绑定 Enter', () => {
    const panel = read('ai/ai-panel.js');
    const save = sliceFunction(panel, 'function saveInlineEdit(skipConfirm) {');
    assert.match(save, /askConfirm\('重新发送这条消息？将丢弃它之后的 ' \+ tail \+ ' 条对话。',[\s\S]*?'重新发送', undefined, undefined, \{keys: \['Enter'\]\}\)/);
});

test('透传链完整：main.js 包装与补丁视图都转发第 6 参', () => {
    const main = read('main.js');
    const forwards = [...main.matchAll(/(?:confirm:|return) \([^)]*variant, options\) => openConfirmDialog\(message, action, okLabel, title, variant, options\)/g)];
    assert.ok(forwards.length >= 4, `main.js 的透传包装应全部带 options（实际 ${forwards.length} 处）`);
    const groups = read('editor/editor-groups.js');
    assert.match(groups, /openConfirmDialog: \(message, action, okLabel, title, variant, options\) => deps\.openConfirmDialog\(message, action, okLabel, title, variant, options\)/);
});
