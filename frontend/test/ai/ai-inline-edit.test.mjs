// ai-inline-edit 纯数据层：用户消息附件快照归一 + 保存载荷组装。
// 方案见 docs/finished-plans/inline-message-edit.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeMessageAttachments,
    inlineEditPayload,
    snapshotFromAttachments,
    INLINE_EDIT_MAX_ITEMS,
    INLINE_EDIT_LABEL_MAX,
} from '../../src/ai/ai-inline-edit.js';
import {AI_QUOTE_KIND} from '../../src/ai/ai-quote.js';

test('normalizeMessageAttachments：非数组 / null / 脏项安全', () => {
    assert.deepEqual(normalizeMessageAttachments(null), []);
    assert.deepEqual(normalizeMessageAttachments(undefined), []);
    assert.deepEqual(normalizeMessageAttachments('x'), []);
    assert.deepEqual(normalizeMessageAttachments({kind: 'file'}), []);
    assert.deepEqual(normalizeMessageAttachments([null, 0, 'a', {}]), []);
});

test('normalizeMessageAttachments：只收文本类附件（媒体与引用走既有字段）', () => {
    const kept = normalizeMessageAttachments([
        {kind: 'file', label: 'a.js', path: '/w/a.js', content: 'x'},
        {kind: 'skill', label: 'code-review', content: 'y'},
        {kind: 'selection', label: '选区', path: '/w/b.js', content: 'z'},
        {kind: 'reference', label: '引用', path: '/w/c.js'},
        // 下面三项不进快照：图片走 images、视频走 videos、引用走 content 前缀
        {kind: 'image', label: '图', data: 'AAA'},
        {kind: 'video', label: '视频', data: 'BBB'},
        {kind: AI_QUOTE_KIND, label: '引用', content: 'q'},
    ]);
    assert.deepEqual(kept.map((item) => item.kind), ['file', 'skill', 'selection', 'reference']);
    assert.equal(kept[0].path, '/w/a.js');
    assert.equal(kept[1].content, 'y');
});

test('normalizeMessageAttachments：label / content 截断，数量封顶', () => {
    const long = normalizeMessageAttachments([
        {kind: 'file', label: 'x'.repeat(1000), content: 'y'.repeat(200000)},
    ]);
    assert.equal(long[0].label.length, INLINE_EDIT_LABEL_MAX);
    assert.ok(long[0].content.length <= 64 * 1024);

    const many = normalizeMessageAttachments(
        Array.from({length: INLINE_EDIT_MAX_ITEMS + 20}, (_, i) => ({kind: 'file', label: 'f' + i})),
    );
    assert.equal(many.length, INLINE_EDIT_MAX_ITEMS);
});

test('normalizeMessageAttachments：选区行列范围随消息保留', () => {
    const [item] = normalizeMessageAttachments([{
        kind: 'selection',
        label: '选中',
        content: 'x',
        range: {start: {line: 10, column: 2}, end: {line: 20, column: 5}},
    }]);
    assert.deepEqual(item.range, {start: {line: 10, column: 2}, end: {line: 20, column: 5}});
    // 脏 range 归一为 0，不抛错
    const [dirty] = normalizeMessageAttachments([{kind: 'selection', content: 'x', range: {start: 'no'}}]);
    assert.deepEqual(dirty.range.start, {line: 0, column: 0});
});

test('inlineEditPayload：引用 chip 拼回正文前缀（不进文本附件）', () => {
    const payload = inlineEditPayload([
        {kind: AI_QUOTE_KIND, source: 'assistant', index: 3, scope: 'message', content: '被引用的原话'},
        {kind: 'file', label: 'a.js', content: 'code'},
        {kind: 'image', data: 'AAA'},
        {kind: 'video', mime: 'video/mp4', data: 'BBB'},
    ], '补充说明');
    assert.match(payload.value, /<quote/);
    assert.match(payload.value, /被引用的原话/);
    assert.match(payload.value, /补充说明$/);
    assert.deepEqual(payload.images.map((item) => item.kind), ['image']);
    assert.deepEqual(payload.videos.map((item) => item.kind), ['video']);
    assert.deepEqual(payload.texts.map((item) => item.kind), ['file'], '引用与媒体都不进文本附件');
});

test('inlineEditPayload：只有引用没有正文时 value 仍可用；全空时为空', () => {
    const quoteOnly = inlineEditPayload([
        {kind: AI_QUOTE_KIND, source: 'user', index: 1, scope: 'message', content: '原话'},
    ], '');
    assert.match(quoteOnly.value, /<quote/);
    assert.equal(quoteOnly.texts.length, 0);

    const empty = inlineEditPayload([], '   ');
    assert.equal(empty.value, '');
    assert.equal(empty.images.length + empty.videos.length + empty.texts.length, 0);
    assert.deepEqual(inlineEditPayload(null, null).value, '');
});

test('snapshotFromAttachments：只固化白名单种类，媒体与引用不重复落盘', () => {
    const snapshot = snapshotFromAttachments([
        {kind: 'file', label: 'a.js', path: '/w/a.js', content: 'code', id: 'att-1'},
        {kind: 'skill', label: 'code-review', content: 'skill'},
        {kind: 'image', data: 'AAA'},
        {kind: 'video', data: 'BBB'},
        {kind: AI_QUOTE_KIND, content: 'quote'},
        null,
    ]);
    assert.deepEqual(snapshot.map((item) => item.kind), ['file', 'skill']);
    // 输入区的临时 id 不落盘（快照只留重启后仍能还原的字段）
    assert.equal('id' in snapshot[0], false);
    assert.equal(snapshot[0].path, '/w/a.js');
});

test('snapshotFromAttachments 与 normalizeMessageAttachments 往返稳定', () => {
    const source = [
        {kind: 'file', label: 'a.js', path: '/w/a.js', content: 'code'},
        {kind: 'selection', label: '选中', path: '/w/b.js', content: 'sel', range: {start: {line: 1, column: 1}, end: {line: 2, column: 2}}},
    ];
    const once = normalizeMessageAttachments(snapshotFromAttachments(source));
    const twice = normalizeMessageAttachments(once);
    assert.deepEqual(twice, once);
});
