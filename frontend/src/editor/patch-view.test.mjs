// patch-view.js 的视图形态测试：用最小 DOM 桩锁住「只读审阅不出现预检 / 应用入口」，
// 以及普通 .patch 视图仍然保留原有应用条。DOMPurify / Shadow DOM 不在 node --test 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag || '').toLowerCase();
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this._classes = new Set();
        this._listeners = {};
    }
    appendChild(node) {
        this.children.push(node);
        if (node) node.parentNode = this;
        return node;
    }
    append(...nodes) {
        for (const node of nodes) this.appendChild(typeof node === 'string' ? {textContent: node, children: []} : node);
    }
    replaceChildren(...nodes) {
        this.children = [];
        for (const node of nodes) this.appendChild(node);
    }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    removeChild(node) {
        this.children = this.children.filter((child) => child !== node);
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    get classList() {
        const self = this;
        return {
            add: (...names) => names.forEach((n) => self._classes.add(n)),
            remove: (...names) => names.forEach((n) => self._classes.delete(n)),
            contains: (n) => self._classes.has(n),
            toggle: (n, on) => {
                const next = on === undefined ? !self._classes.has(n) : !!on;
                if (next) self._classes.add(n);
                else self._classes.delete(n);
            },
        };
    }
}

function installDom() {
    globalThis.document = {
        createElement: (tag) => new FakeNode(tag),
        createTextNode: (text) => ({textContent: text, children: []}),
    };
}

function collect(node, out = {texts: [], nodes: []}) {
    if (!node) return out;
    out.nodes.push(node);
    if (node.textContent != null && node.textContent !== '') out.texts.push(String(node.textContent));
    for (const child of node.children || []) collect(child, out);
    return out;
}

const HUNK_LINES = [
    {t: ' ', text: 'keep', oldLine: 1, newLine: 1},
    {t: '-', text: 'old', oldLine: 2, newLine: 0},
    {t: '+', text: 'new', oldLine: 0, newLine: 2},
    {t: '+', text: 'extra', oldLine: 0, newLine: 3},
];

function planFor(status) {
    return {
        planId: 'plan-1',
        patchId: '',
        root: 'D:/work',
        external: true,
        added: 2,
        removed: 1,
        applicable: true,
        files: [{
            relPath: 'src/a.js',
            kind: 'modify',
            status,
            reason: status === 'ok' ? '' : '上下文不匹配',
            added: 2,
            removed: 1,
            hunks: [{
                header: '@@ -1,2 +1,3 @@',
                status,
                reason: status === 'ok' ? '' : '上下文不匹配',
                applyAtLine: 1,
                lines: HUNK_LINES,
            }],
        }],
    };
}

function ctxFor(parseImpl, previewImpl) {
    return {
        backend: {
            PatchParseText: parseImpl,
            PatchPreviewFile: previewImpl,
        },
        getRoot: () => 'D:/work',
        chooseFolder: async () => '',
        openPath: () => {},
        notifyChanged: () => {},
        flash: () => {},
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('只读审阅：只有文件卡 / hunk，没有预检状态与应用入口', async () => {
    installDom();
    const {showPatchView, patchViewSnapshot, setPatchTargetRoot, repreviewPatchView} = await import('./patch-view.js');
    const doc = {
        name: '本轮改动审阅 — 1 个文件.diff',
        format: {patch: true},
        content: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n',
        patchReview: true,
        reviewNotes: ['src/new.js：未被 Git 跟踪'],
        pane: new FakeNode('div'),
    };
    const ctx = ctxFor(async () => planFor('ok'));
    showPatchView(doc, ctx);
    await tick();

    const {texts, nodes} = collect(doc.patchState.el);
    const joined = texts.join('\n');
    assert.match(joined, /只读快照/);
    assert.match(joined, /src\/a\.js/);
    assert.match(joined, /@@ -1,2 \+1,3 @@/);
    assert.match(joined, /src\/new\.js/);
    for (const forbidden of ['应用', '撤销', '预检', '目标：', '可应用', '冲突', '落到第']) {
        assert.equal(joined.includes(forbidden), false, '审阅视图不应出现「' + forbidden + '」');
    }
    assert.equal(nodes.filter((n) => n.tagName === 'input').length, 0, '审阅视图不应有勾选框');
    assert.equal(nodes.filter((n) => n.tagName === 'select').length, 0, '审阅视图不应有应用模式下拉');
    assert.ok(doc.pane.classList.contains('patch-review'));

    const snap = patchViewSnapshot(doc);
    assert.equal(snap.review, true);
    assert.equal(snap.loaded, true);
    for (const key of ['applicable', 'mode', 'selected', 'planId', 'root', 'patchId']) {
        assert.equal(Object.prototype.hasOwnProperty.call(snap, key), false, '快照不应含 ' + key);
    }
    await assert.rejects(() => setPatchTargetRoot(doc, ctx, 'D:/other'), /只读审阅/);
    await assert.rejects(() => repreviewPatchView(doc, ctx, {}), /只读审阅/);
});

test('普通 .patch 视图仍保留应用 / 撤销 / 重新预检', async () => {
    installDom();
    const {showPatchView, patchViewSnapshot} = await import('./patch-view.js');
    const doc = {
        name: 'fix.patch',
        path: 'D:/fix.patch',
        format: {patch: true},
        pane: new FakeNode('div'),
    };
    const ctx = ctxFor(null, async () => planFor('ok'));
    showPatchView(doc, ctx);
    await tick();

    const {texts, nodes} = collect(doc.patchState.el);
    const joined = texts.join('\n');
    assert.match(joined, /应用选中/);
    assert.match(joined, /撤销/);
    assert.match(joined, /重新预检/);
    assert.equal(nodes.filter((n) => n.tagName === 'input').length >= 3, true);
    const snap = patchViewSnapshot(doc);
    assert.equal(snap.loaded, true);
    assert.equal(snap.applicable, true);
    assert.deepEqual(snap.selected, ['src/a.js']);
});

test('审阅文档内容为空时不调用后端解析，只显示说明', async () => {
    installDom();
    const {showPatchView} = await import('./patch-view.js');
    let calls = 0;
    const doc = {
        name: '本轮改动审阅 — 1 个文件.diff',
        format: {patch: true},
        content: '',
        patchReview: true,
        reviewNotes: ['a.txt：无 Git 差异'],
        pane: new FakeNode('div'),
    };
    const ctx = ctxFor(async () => { calls += 1; return planFor('ok'); });
    showPatchView(doc, ctx);
    await tick();
    assert.equal(calls, 0);
    const {texts} = collect(doc.patchState.el);
    assert.match(texts.join('\n'), /没有可展示的 Git 差异/);
});
