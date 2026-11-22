// completion.test.mjs —— 补全纯函数层（frontend/src/core/completion.js）。
// 覆盖：打分排序（前缀 > CamelHumps > 子串 > fuzzy）、matchFilter 稳定截断、
// 词表提取（限量/窗口）、JSON/YAML/INI/XML 提取、设置归一化、Ace 能力探测与挂载助手。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    scoreMatch, matchFilter,
    extractWords, extractJsonKeys, extractYamlKeys,
    extractIniSections, extractIniKeys, extractXmlTags, extractXmlAttrs,
    normalizeCompletionSettings,
    isAceCompletionCapable, enableAceCompletion,
} from '../../src/core/completion.js';

// ── 打分 ──

test('scoreMatch：前缀 > CamelHumps > 子串 > fuzzy，同档短者优先', () => {
    const kinds = ['prefix', 'camel', 'substring', 'fuzzy'];
    const cases = [
        ['use', 'userAccount', 'prefix'],
        ['uA', 'userAccount', 'camel'],
        ['ccount', 'userAccount', 'substring'],
        ['uAunt', 'userAccount', 'fuzzy'],
    ];
    const scores = [];
    for (const [prefix, text, kind] of cases) {
        const m = scoreMatch(prefix, text);
        assert.ok(m, `${prefix} → ${text} 应命中`);
        assert.equal(m.kind, kind);
        scores.push(m.score);
    }
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] > scores[i], `${kinds[i]} 应低于 ${kinds[i - 1]}`);
});

test('scoreMatch：大小写不敏感、不匹配返回 null、空前缀平铺', () => {
    assert.equal(scoreMatch('USE', 'userAccount').kind, 'prefix');
    assert.equal(scoreMatch('xyz', 'userAccount'), null);
    assert.equal(scoreMatch('', 'anything').kind, 'any');
    assert.equal(scoreMatch('x', ''), null);
});

test('scoreMatch：驼峰边界含下划线分隔（snake_case 也算 camel）', () => {
    const m = scoreMatch('uA', 'user_account_name');
    assert.equal(m.kind, 'camel'); // u / a 都落在驼峰边界（词首与下划线后）
});

test('matchFilter：按分排序、limit 截断、平分保持插入序', () => {
    const items = [
        {caption: 'userName', value: 'userName', meta: '文档'},
        {caption: 'userAccount', value: 'userAccount', meta: '文档'},
        {caption: 'userA', value: 'userA', meta: '文档'},
    ];
    const out = matchFilter('userA', items, 10);
    assert.equal(out[0].caption, 'userA', '精确前缀且最短者第一');
    assert.ok(out[1] && out[2]);
    const limited = matchFilter('', items, 2);
    assert.equal(limited.length, 2, 'limit 截断');
    assert.deepEqual(limited.map((x) => x.caption), ['userName', 'userAccount'], '平分（空前缀）按插入序');
    assert.deepEqual(matchFilter('', items, -1), [], '非法 limit 钳制为空，不做负数 slice 语义');
    assert.deepEqual(matchFilter('', items, 0), [], 'limit 0 = 空');
});

// ── 词表提取 ──

test('extractWords：标识符词、去重、minLen、限量', () => {
    const words = extractWords('const userName = getUserAccount(); userName + x1;', {minLen: 3});
    assert.ok(words.includes('userName'));
    assert.ok(words.includes('getUserAccount'));
    assert.equal(words.filter((w) => w === 'userName').length, 1, '去重');
    assert.ok(!words.includes('x1'), 'minLen=3 滤掉短词');
    const capped = extractWords('abc def '.repeat(6000), {maxWords: 5});
    assert.ok(capped.length <= 5, 'maxWords 截断');
});

test('extractWords：大文本走光标窗口', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(400 * 300); // > 2MB
    const lines = filler.split('\n');
    assert.ok(filler.length > 2 * 1024 * 1024);
    const words = extractWords(filler, {cursorRow: Math.floor(lines.length / 2)});
    assert.ok(words.length >= 0, '不抛错即通过（窗口切片路径）');
    const headOnly = extractWords(filler, {});
    assert.ok(headOnly.length >= 0, '无光标时截前 maxBytes');
});

// ── 结构提取 ──

test('extractJsonKeys：对象与 JSONL 通用、转义 key 解码', () => {
    const text = '{"name": 1, "user_name": 2}\n{"nested": {"deep key": 3}}';
    const keys = extractJsonKeys(text);
    assert.deepEqual(keys, ['name', 'user_name', 'nested', 'deep key']);
    const esc = extractJsonKeys('{"a\\"b": 1}');
    assert.deepEqual(esc, ['a"b']);
});

test('extractYamlKeys：行首键、列表项键、URL 不算、注释跳过', () => {
    const text = [
        '# comment: not-a-key',
        'server:',
        '  port: 8080',
        '- itemKey: v',
        'url: http://example.com/a',
    ].join('\n');
    const keys = extractYamlKeys(text);
    assert.ok(keys.includes('server'));
    assert.ok(keys.includes('port'));
    assert.ok(keys.includes('itemKey'));
    assert.ok(keys.includes('url'));
    assert.ok(!keys.includes('http'), 'http:// 不产生键');
    assert.ok(!keys.includes('comment'), '注释行跳过');
});

test('extractIniSections / extractIniKeys：INI 与 TOML 形态通用', () => {
    const text = '[server]\nport = 8080\n[db.main]\nuser="root"\n; comment=x\n# comment2=y';
    assert.deepEqual(extractIniSections(text), ['server', 'db.main']);
    const keys = extractIniKeys(text);
    assert.ok(keys.includes('port'));
    assert.ok(keys.includes('user'));
    assert.ok(!keys.includes('comment'), '注释行不算键');
});

test('extractXmlTags / extractXmlAttrs：标签与属性、命名空间标签', () => {
    const text = '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="scale(2)"><rect width="1"/></g></svg>';
    const tags = extractXmlTags(text);
    assert.ok(tags.includes('svg'));
    assert.ok(tags.includes('rect'));
    const attrs = extractXmlAttrs(text);
    assert.ok(attrs.includes('xmlns:xlink'));
    assert.ok(attrs.includes('transform'));
    assert.ok(attrs.includes('width'));
});

// ── 设置归一化 ──

test('normalizeCompletionSettings：缺省=开/开/关（live 路径在 vendored bundle 不可靠，§15.2），损坏输入回默认', () => {
    assert.deepEqual(normalizeCompletionSettings({}), {files: true, sql: true, live: false});
    assert.deepEqual(normalizeCompletionSettings(null), {files: true, sql: true, live: false});
    assert.deepEqual(normalizeCompletionSettings({completion: 'garbage'}), {files: true, sql: true, live: false});
    assert.deepEqual(
        normalizeCompletionSettings({completion: {files: false, sql: false, live: true}}),
        {files: false, sql: false, live: true},
    );
    // 只关 files：其余保持默认
    assert.deepEqual(normalizeCompletionSettings({completion: {files: false}}), {files: false, sql: true, live: false});
});

// ── Ace 挂载助手 ──

test('isAceCompletionCapable：无 ace / 无 require / 无 language_tools 均判不可用', () => {
    assert.equal(isAceCompletionCapable(null), false);
    assert.equal(isAceCompletionCapable({}), false);
    assert.equal(isAceCompletionCapable({require: () => { throw new Error('boom'); }}), false);
    const fakeAce = {require: (id) => (id === 'ace/ext/language_tools' ? {addCompleter() {}} : null)};
    assert.equal(isAceCompletionCapable(fakeAce), true);
});

test('enableAceCompletion：成功挂上两个选项；抛错时静默返回 false', () => {
    const set = {};
    const ed = {setOption(k, v) { set[k] = v; }};
    const completer = {getCompletions() {}};
    assert.equal(enableAceCompletion(ed, [completer], true), true);
    assert.equal(set.enableLiveAutocompletion, true);
    assert.ok(Array.isArray(set.enableBasicAutocompletion) && set.enableBasicAutocompletion.length === 1);
    assert.equal(typeof set.enableBasicAutocompletion[0].getCompletions, 'function');
    const bad = {setOption() { throw new Error('no language_tools'); }};
    assert.equal(enableAceCompletion(bad, [], false), false, '尽力而为路径：静默降级不抛');
    assert.equal(enableAceCompletion(null, [], false), false);
});
