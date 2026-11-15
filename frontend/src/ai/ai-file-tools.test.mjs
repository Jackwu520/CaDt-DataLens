// ai-file-tools.test.mjs：read_file 窗口切片 / edit_file 定位 / list_dir 大小 / search_text 通配 的纯函数测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_READ_MAX_CHARS,
    globMatchPath,
    humanSizeBytes,
    locateEditTarget,
    normalizeReadWindow,
    readWindowOf,
} from './ai-file-tools.js';

// —— normalizeReadWindow ——

test('normalizeReadWindow: 字符模式默认值与钳制', () => {
    assert.deepEqual(normalizeReadWindow({}), {mode: 'chars', offset: 0, limit: AI_READ_MAX_CHARS});
    assert.deepEqual(normalizeReadWindow({offset: -5}), {mode: 'chars', offset: 0, limit: AI_READ_MAX_CHARS});
    assert.deepEqual(normalizeReadWindow({offset: 10, limit: 50}), {mode: 'chars', offset: 10, limit: 50});
    // limit 超上限钳到 64KB
    assert.equal(normalizeReadWindow({limit: 999999}).limit, AI_READ_MAX_CHARS);
});

test('normalizeReadWindow: 行号模式与互斥校验', () => {
    assert.deepEqual(normalizeReadWindow({startLine: 5}), {mode: 'lines', startLine: 5, endLine: null});
    assert.deepEqual(normalizeReadWindow({startLine: 3, endLine: 9}), {mode: 'lines', startLine: 3, endLine: 9});
    assert.throws(() => normalizeReadWindow({offset: 1, startLine: 1}), /不能混用/);
    assert.throws(() => normalizeReadWindow({limit: 10, endLine: 2}), /不能混用/);
    assert.throws(() => normalizeReadWindow({startLine: 9, endLine: 2}), /不能小于/);
    assert.throws(() => normalizeReadWindow({limit: 0}), /limit 至少为 1/);
});

// —— readWindowOf ——

test('readWindowOf: 字符模式切片、截断与续读提示', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
    const view = readWindowOf(text, {mode: 'chars', offset: 0, limit: 50});
    assert.equal(view.text, 'a'.repeat(50));
    assert.equal(view.truncated, true);
    assert.match(view.hint, /offset=50/);
    assert.equal(view.targetLine, 1);
    // 从第二行中间开始：targetLine 落在 2
    const view2 = readWindowOf(text, {mode: 'chars', offset: 120, limit: 10});
    assert.equal(view2.targetLine, 2);
    // offset 到末尾之外
    const view3 = readWindowOf(text, {mode: 'chars', offset: 9999, limit: 10});
    assert.equal(view3.text, '');
    assert.match(view3.hint, /文件末尾/);
});

test('readWindowOf: 行号模式带行号前缀、与编辑器行号一致', () => {
    const text = 'alpha\nbeta\ngamma\n';
    const view = readWindowOf(text, {mode: 'lines', startLine: 2, endLine: 3});
    // 末尾换行不算一行：共 3 行；前缀右对齐 + tab
    assert.equal(view.totalLines, 3);
    assert.equal(view.text, '2\tbeta\n3\tgamma\n');
    assert.equal(view.truncated, false);
    assert.equal(view.targetLine, 2);
});

test('readWindowOf: 行号模式 64KB 截断给续读 startLine', () => {
    const text = Array.from({length: 100}, (_, i) => 'x'.repeat(1000)).join('\n');
    const view = readWindowOf(text, {mode: 'lines', startLine: 1, endLine: null});
    assert.equal(view.truncated, true);
    assert.ok(view.nextStartLine > 1);
    assert.match(view.hint, /startLine=/);
    assert.equal(view.text.length + 'x'.repeat(0).length <= AI_READ_MAX_CHARS + view.text.split('\n').length, true);
});

test('readWindowOf: 行号超界给出总行数提示；CRLF 行尾去 \\r', () => {
    const view = readWindowOf('a\nb', {mode: 'lines', startLine: 99, endLine: null});
    assert.equal(view.text, '');
    assert.match(view.hint, /共 2 行/);
    const crlf = readWindowOf('a\r\nbeta\r\ngamma\r\n', {mode: 'lines', startLine: 1, endLine: 2});
    assert.equal(crlf.text, '1\ta\n2\tbeta\n');
    assert.equal(crlf.totalLines, 3);
});

// —— locateEditTarget ——

test('locateEditTarget: 唯一命中替换；多处命中报错或 replaceAll 全替换', () => {
    const text = 'foo bar foo';
    const one = locateEditTarget(text, 'bar', 'BAZ', false);
    assert.equal(one.next, 'foo BAZ foo');
    assert.equal(one.count, 1);
    const multi = locateEditTarget(text, 'foo', 'qux', false);
    assert.match(multi.error, /多处命中（2 处）/);
    assert.match(multi.error, /replaceAll/);
    const all = locateEditTarget(text, 'foo', 'qux', true);
    assert.equal(all.next, 'qux bar qux');
    assert.equal(all.count, 2);
});

test('locateEditTarget: CRLF 文件 LF 模式兜底重试', () => {
    const text = 'a\r\n  hello world\r\nb';
    const r = locateEditTarget(text, '\n  hello world\n', '\n  hi\n', false);
    assert.equal(r.next, 'a\r\n  hi\r\nb');
    assert.match(r.error || '', /^$/);
});

test('locateEditTarget: 未命中报错', () => {
    const r = locateEditTarget('abc', 'xyz', 'q', false);
    assert.match(r.error, /未找到 oldString/);
});

// —— humanSizeBytes ——

test('humanSizeBytes: 分级与尾零去除', () => {
    assert.equal(humanSizeBytes(0), '0B');
    assert.equal(humanSizeBytes(512), '512B');
    assert.equal(humanSizeBytes(1024), '1KB');
    assert.equal(humanSizeBytes(12.3 * 1024), '12.3KB');
    assert.equal(humanSizeBytes(5 * 1024 * 1024), '5MB');
});

// —— globMatchPath ——

test('globMatchPath: 文件名模式与路径模式', () => {
    assert.equal(globMatchPath('*.go', 'src/server.go', 'server.go'), true);
    assert.equal(globMatchPath('*.go', 'src/server.js', 'server.js'), false);
    assert.equal(globMatchPath('src/**/*.ts', 'src/a/b/c.ts', 'c.ts'), true);
    assert.equal(globMatchPath('src/**/*.ts', 'lib/a/b/c.ts', 'c.ts'), false);
    assert.equal(globMatchPath('src/*.ts', 'src/a/b/c.ts', 'c.ts'), false);
    assert.equal(globMatchPath('server?.go', 'src/server1.go', 'server1.go'), true);
    assert.equal(globMatchPath('SERVER.GO', 'src/server.go', 'server.go'), true);
    assert.equal(globMatchPath('', 'a/b.txt', 'b.txt'), true);
});
