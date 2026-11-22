// editor-completion.test.mjs —— 文件编辑器侧补全（frontend/src/editor/editor-completion.js）。
// 覆盖：模式路由（结构感知只认数据格式）、启用判定（设置开关 + 只读判定）、mode 关键词
// 提取、词表节流、按格式组装候选、completer 回调、幂等挂载（node 无 window → 静默不挂）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    routeForMode, shouldEnableFileCompletion, modeKeywords,
    wordsForSession, itemsForSession, createFileCompleter, setupEditorCompletion,
    refreshCompletionSettings, decoratePopupRows,
} from '../../src/editor/editor-completion.js';

// ── 路由 ──

test('routeForMode：数据格式进结构感知，其余词法兜底', () => {
    assert.equal(routeForMode('ace/mode/json'), 'json');
    assert.equal(routeForMode('ace/mode/yaml'), 'yaml');
    assert.equal(routeForMode('ace/mode/xml'), 'xml');
    assert.equal(routeForMode('ace/mode/ini'), 'ini');
    assert.equal(routeForMode('ace/mode/properties'), 'ini');
    assert.equal(routeForMode('ace/mode/toml'), 'ini', 'vendored 有 mode-toml，同走 ini 形态提取');
    assert.equal(routeForMode('ace/mode/python'), 'lexical');
    assert.equal(routeForMode('ace/mode/golang'), 'lexical');
    assert.equal(routeForMode('ace/mode/text'), 'lexical');
    assert.equal(routeForMode(''), 'lexical');
    assert.equal(routeForMode(null), 'lexical');
});

// ── 启用判定 ──

test('shouldEnableFileCompletion：设置开关 + 非只读 + doc 必须存在', () => {
    const doc = {name: 'a.json', format: {id: 'json'}};
    assert.equal(shouldEnableFileCompletion({}, doc), true, '缺省开启');
    assert.equal(shouldEnableFileCompletion({completion: {files: false}}, doc), false, '总开关关');
    assert.equal(shouldEnableFileCompletion({}, null), false, '无 doc 不挂');
    assert.equal(shouldEnableFileCompletion({}, {name: 'a.json', readOnlyFixed: true}), false, '标签只读锁');
    assert.equal(shouldEnableFileCompletion({readOnlyMode: true}, doc), false, '全局只读锁');
    assert.equal(shouldEnableFileCompletion({}, {name: 'big.json', large: true}), false, '大文件只读档');
});

// ── mode 关键词（零成本顺带层）──

test('modeKeywords：$keywordList 存在则按 | 拆分并缓存；不存在回空数组', () => {
    const session = {$mode: {$highlightRules: {$keywordList: ['foo|bar', 'baz']}}};
    const list = modeKeywords(session);
    assert.deepEqual(list, ['foo', 'bar', 'baz']);
    assert.equal(modeKeywords(session), list, '缓存复用');
    const bare = {};
    assert.deepEqual(modeKeywords(bare), [], 'vendored 多数 mode 无 $keywordList（实测），回空');
    assert.deepEqual(modeKeywords(null), []);
});

// ── 词表缓存与节流 ──

test('wordsForSession：缓存 + 脏标记节流 + 到期重建', async () => {
    const session = {getValue: () => 'alpha beta gamma delta alpha'};
    const first = wordsForSession(session, {row: 0});
    assert.ok(first.includes('alpha') && first.includes('delta'));
    assert.equal(wordsForSession(session, {row: 0}), first, '未脏直接复用');
    session.$cadtWordsDirty = true;
    assert.equal(wordsForSession(session, {row: 0}), first, '脏了但 300ms 节流窗口内：复用旧表');
    await new Promise((r) => setTimeout(r, 330));
    const rebuilt = wordsForSession(session, {row: 0});
    assert.notEqual(rebuilt, first, '节流窗口过后重建');
    assert.deepEqual(rebuilt, first, '内容不变时重建结果一致');
});

// ── 候选组装 ──

function fakeSession(modeId, text) {
    return {getValue: () => text, getMode: () => ({$id: modeId})};
}

test('itemsForSession：JSON 文档给键候选（结构层）+ 词法兜底 + 同名去重', () => {
    const session = fakeSession('ace/mode/json', '{"name": 1, "user_name": 2}');
    const items = itemsForSession(session, {row: 0});
    const keys = items.filter((i) => i.meta === '键').map((i) => i.caption);
    assert.deepEqual(keys, ['name', 'user_name']);
    // 键与文档词重名只出一行（结构层先到先得）
    assert.equal(items.filter((i) => i.caption === 'name').length, 1, '同名候选去重');
    const words = items.filter((i) => i.meta === '文档').map((i) => i.caption);
    assert.ok(!words.includes('name') && !words.includes('user_name'), '重名词不再以文档 meta 重复');
});

test('itemsForSession：INI/TOML 给段与键；XML 给标签与属性；其余模式只有词法', () => {
    const ini = itemsForSession(fakeSession('ace/mode/toml', '[server]\nport = 8080'), {row: 0});
    assert.ok(ini.some((i) => i.caption === 'server' && i.meta === '段'));
    assert.ok(ini.some((i) => i.caption === 'port' && i.meta === '键'));

    const xml = itemsForSession(fakeSession('ace/mode/xml', '<rect width="10"/>'), {row: 0});
    assert.ok(xml.some((i) => i.caption === 'rect' && i.meta === '标签'));
    assert.ok(xml.some((i) => i.caption === 'width' && i.meta === '属性'));

    const py = itemsForSession(fakeSession('ace/mode/python', 'import os.path'), {row: 0});
    assert.ok(py.every((i) => i.meta === '文档'), '无 $keywordList 的 mode 只剩词法兜底');
});

test('createFileCompleter：回调按前缀过滤', () => {
    const completer = createFileCompleter();
    const session = fakeSession('ace/mode/json', '{"name": 1, "nickname": 2, "age": 3}');
    const items = new Promise((resolve) => {
        completer.getCompletions(null, session, {row: 0}, 'na', (err, list) => resolve(list || []));
    });
    return items.then((list) => {
        const captions = list.map((i) => i.caption);
        assert.ok(captions.includes('name'));
        assert.ok(captions.includes('nickname'));
        assert.ok(!captions.includes('age'), '前缀过滤');
    });
});

// ── 挂载 ──

test('setupEditorCompletion：node 环境（无 window.ace）静默不挂、不抛错', () => {
    const fakeEditor = {session: {on() {}}};
    assert.equal(setupEditorCompletion(fakeEditor, {name: 'a.json'}, {}), false);
    assert.equal(fakeEditor._cadtCompletionSetup, undefined, '早期 return 不置标记，可重入重试');
    // 设置关闭时同样不挂
    assert.equal(setupEditorCompletion(fakeEditor, {name: 'a.json'}, {completion: {files: false}}), false);
});

test('refreshCompletionSettings：已挂载编辑器热更新 live，未挂载的按需补挂', () => {
    const attached = {_cadtCompletionSetup: true, setOption(k, v) { this[k] = v; }};
    const plain = {session: {on() {}}};
    refreshCompletionSettings(
        [{aceEditor: attached, doc: {name: 'a.json'}}, {aceEditor: plain, doc: {name: 'b.json'}}],
        {completion: {live: true}},
    );
    assert.equal(attached.enableLiveAutocompletion, true, '已挂载：live 即时翻上');
    assert.equal(plain._cadtCompletionSetup, undefined, 'node 无 window.ace：补挂静默失败（浏览器内会成功）');
    refreshCompletionSettings([{aceEditor: attached, doc: null}], {completion: {live: false}});
    assert.equal(attached.enableLiveAutocompletion, false, '显式关闭才关');
    refreshCompletionSettings([], {}), // 空集合不抛
    assert.equal(refreshCompletionSettings([{aceEditor: null}], {}), undefined, '缺 aceEditor 的条目跳过');
});

test('decoratePopupRows：按 meta 注入图标 span（幂等，无 meta 行跳过）', () => {
    // 轻量 DOM 桩：querySelectorAll/querySelector 按预置结构应答
    function el(metaText, withIcon) {
        return {
            _meta: metaText,
            _withIcon: withIcon,
            dataset: {},
            children: [],
            insertBefore(node, ref) { this.children.unshift(node); },
            querySelector(sel) {
                if (sel === '.cadt-cmpl-icon') return this._withIcon ? {fake: true} : null;
                if (sel === '.ace_completion-meta') return this._meta == null ? null : {textContent: this._meta};
                return null;
            },
        };
    }
    const popup = {
        container: {
            querySelectorAll(sel) {
                if (sel === '.ace_line') return rowsOf;
                return [];
            },
        },
    };
    const rowA = el('关键词', false);
    const rowB = el('INTEGER', false); // 动态列类型 → 默认 database 图标
    const rowC = el(null, false); // 无 meta → 跳过
    const rowD = el('表', true); // 已有图标 → 跳过
    const rowsOf = [rowA, rowB, rowC, rowD];
    const fakeDoc = {createElement: () => ({dataset: {}, className: '', innerHTML: '', children: []})};
    decoratePopupRows(popup, fakeDoc);
    assert.equal(rowA.children.length, 1, '注入一个图标 span');
    assert.equal(rowA.children[0].className, 'cadt-cmpl-icon');
    assert.equal(rowA.children[0].dataset.cadtType, 'keyword');
    assert.ok(String(rowA.children[0].innerHTML).includes('<svg'), 'iconSvg 内容注入');
    assert.equal(rowB.children[0].dataset.cadtType, 'column', '未知 meta（列类型串）走默认图标');
    assert.equal(rowC.children.length, 0, '无 meta 行跳过');
    assert.equal(rowD.children.length, 0, '已装饰行跳过（幂等）');
});
