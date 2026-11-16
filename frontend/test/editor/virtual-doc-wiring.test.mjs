// virtual-doc-wiring.test.mjs —— 内容区「虚拟文档」标签页的接线守卫。
//
// 虚拟文档 = 不属于任何磁盘文件的标签页（浏览器 / 后台终端 / 子代理详情 / 支线对话）：
// 它们靠 doc 上的一个标记位（doc.browser / doc.bgTerm / doc.agentView / doc.sideChat）
// 接进编辑器，**四处必须同时改**，漏一处都不会报错：
//   1. `createDocEditor` 分支：漏了 → 标签页打开是空白，控制台没有任何错误；
//   2. `viewOptionsFor` 返回 []：漏了 → 虚拟标签页出现文件视图下拉（切换视图即坏）；
//   3. `closeDocNow` 的卸载：漏了 → 关闭后订阅 / 事件监听 / 面板 DOM 泄漏；
//   4. `src/bridge/` 里的创建点：漏了 → 分支是死代码（改了一半）。
//
// 判定以源码为准（这些分支是 if 链，没有注册表可 import）：从 `createDocEditor` 里
// 「if (doc.X) { … View(doc) … }」的块推出虚拟类型集合，再和其余三处对账。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (rel) => readFileSync(join(srcRoot, rel), 'utf8');

const groupsSrc = read('editor/editor-groups.js');
const writingSrc = read('writing/writing-ui.js');
const bridgeSrc = readdirSync(join(srcRoot, 'bridge'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => read('bridge/' + name))
    .join('\n');

// 切出顶层函数体（这些文件的域函数都在 0 缩进的 `function` 层）。
function sliceTopFunction(text, signature) {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, '找不到函数：' + signature);
    const rest = text.slice(start + signature.length);
    const next = /\nfunction [A-Za-z_]/.exec(rest);
    return signature + (next ? rest.slice(0, next.index) : rest);
}

const createEditorBody = sliceTopFunction(groupsSrc, 'function createDocEditor(doc) {');
const closeDocBody = sliceTopFunction(groupsSrc, 'function closeDocNow(doc, remember = true) {');
const viewOptionsBody = sliceTopFunction(writingSrc, 'function viewOptionsFor(fmt, doc) {');

// 虚拟文档分支 = `if (doc.X) { … }` 且块内建的是视图（调用 `…View(doc)`）。
function virtualKinds(editorBody) {
    const kinds = new Set();
    for (const match of editorBody.matchAll(/if \(doc\.([A-Za-z]+)\) \{/g)) {
        const start = match.index;
        const next = editorBody.indexOf('\n    if (doc.', start + 5);
        const block = editorBody.slice(start, next > 0 ? next : start + 400);
        if (/View\(doc\)/.test(block)) kinds.add(match[1]);
    }
    return [...kinds].sort();
}

const editorKinds = virtualKinds(createEditorBody);

// viewOptionsFor 的虚拟清单：`if (doc && (doc.a || doc.b)) return [];`
const viewListMatch = /if \(doc && \((doc\.[A-Za-z]+(?:\s*\|\|\s*doc\.[A-Za-z]+)*)\)\) return \[\]/.exec(viewOptionsBody);
assert.ok(viewListMatch, 'viewOptionsFor 里找不到「虚拟文档返回 []」那一行（结构变了就更新本守卫）');
const viewKinds = [...new Set([...viewListMatch[1].matchAll(/doc\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();

test('虚拟文档类型：createDocEditor 分支 ↔ viewOptionsFor 清单一致', () => {
    assert.deepEqual(editorKinds, viewKinds,
        '两个清单不一致：漏 viewOptionsFor → 虚拟标签页出现文件视图下拉；漏 createDocEditor → 标签打开是空白');
});

test('每个虚拟文档都在 closeDocNow 里卸载', () => {
    const missing = editorKinds.filter((kind) => !closeDocBody.includes('doc.' + kind));
    assert.deepEqual(missing, [], '这些虚拟文档没在 closeDocNow 里处理：关闭后订阅 / 监听 / DOM 会泄漏');
});

test('每个虚拟文档都能在 bridge 里找到创建点', () => {
    const missing = editorKinds.filter((kind) => !new RegExp('(^|[^A-Za-z])' + kind + ':').test(bridgeSrc));
    assert.deepEqual(missing, [], '这些虚拟文档没有创建点（src/bridge/*.js 里应出现 `kind: …`），分支是死代码');
});
