import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeReadRoot,
    normalizeReadRoots,
    readRootCovers,
    readRootCoversAny,
    addReadRoot,
    userNamedPath,
    sensitiveReadDenyReason,
} from './ai-read-roots.js';

// ---------- normalizeReadRoot / normalizeReadRoots ----------

test('normalizeReadRoot 归一反斜杠与尾分隔符', () => {
    assert.equal(normalizeReadRoot('D:\\Novel\\日记星辰\\'), 'D:/Novel/日记星辰');
    assert.equal(normalizeReadRoot('  D:/Novel//  '), 'D:/Novel');
    assert.equal(normalizeReadRoot(''), '');
    assert.equal(normalizeReadRoot(null), '');
});

test('normalizeReadRoots 去重（大小写不敏感）、去空、上限 200', () => {
    assert.deepEqual(
        normalizeReadRoots(['D:/Novel', 'd:\\novel\\', 'E:/Books', '', null, 'D:/Novel/']),
        ['D:/Novel', 'E:/Books'],
    );
    const many = Array.from({length: 250}, (_, i) => 'D:/r' + i);
    assert.equal(normalizeReadRoots(many).length, 200);
});

// ---------- readRootCovers / readRootCoversAny ----------

test('readRootCovers：相等与子树覆盖，大小写与分隔符不敏感', () => {
    assert.equal(readRootCovers('D:/Novel', 'D:/Novel'), true);
    assert.equal(readRootCovers('D:/Novel', 'D:/Novel/日记星辰/正文/番外0007.md'), true);
    assert.equal(readRootCovers('d:\\novel\\', 'D:/Novel/a.md'), true);
    assert.equal(readRootCovers('D:/Novel', 'D:/Novels/a.md'), false);
    assert.equal(readRootCovers('D:/Novel', 'E:/Novel/a.md'), false);
    assert.equal(readRootCovers('', 'D:/a.md'), false);
    assert.equal(readRootCovers('D:', 'D:/a.md'), true);
});

test('readRootCoversAny 任一命中即真', () => {
    assert.equal(readRootCoversAny(['D:/A', 'D:/B'], 'D:/B/x.md'), true);
    assert.equal(readRootCoversAny(['D:/A'], 'D:/B/x.md'), false);
    assert.equal(readRootCoversAny(null, 'D:/B/x.md'), false);
});

// ---------- addReadRoot ----------

test('addReadRoot：已覆盖不重复加，新根替换被包含旧根', () => {
    assert.deepEqual(addReadRoot(['D:/Novel'], 'D:/Novel/日记星辰'), ['D:/Novel']);
    assert.deepEqual(addReadRoot(['D:/Novel/日记星辰'], 'D:/Novel'), ['D:/Novel']);
    assert.deepEqual(addReadRoot(['D:/A'], 'D:/B'), ['D:/A', 'D:/B']);
    assert.deepEqual(addReadRoot([], ''), []);
    // 不改入参
    const input = ['D:/A'];
    addReadRoot(input, 'D:/B');
    assert.deepEqual(input, ['D:/A']);
});

// ---------- userNamedPath ----------

const msg = (content, extra) => ({role: 'user', content, ...extra});

test('真用户消息点名文件 → 目标文件与点名的目录子树放行', () => {
    const session = {messages: [
        msg('请总结 D:\\OraSkyC\\Novel\\日记星辰\\正文\\番外0007-最轻松的时光.md'),
        {role: 'assistant', content: '好的'},
    ]};
    assert.equal(userNamedPath(session, 'D:/OraSkyC/Novel/日记星辰/正文/番外0007-最轻松的时光.md'), true);
    // 大小写与分隔符差异不影响判定
    assert.equal(userNamedPath(session, 'd:/oraskyc/novel/日记星辰/正文/番外0007-最轻松的时光.md'), true);
});

test('点名目录 → 该目录下任意文件放行，目录外不放行', () => {
    const session = {messages: [msg('读一下 D:/Novel 目录下的所有 md')]};
    assert.equal(userNamedPath(session, 'D:/Novel/日记星辰/正文/a.md'), true);
    assert.equal(userNamedPath(session, 'D:/Novels/a.md'), false);
    assert.equal(userNamedPath(session, 'E:/Novel/a.md'), false);
});

test('app 卡片 / notice / 模型派单 task 不算点名', () => {
    const session = {messages: [
        msg('读取 D:/secret/key.md', {app: {kind: 'subagent'}}),
        msg('读取 D:/secret/key.md', {notice: true}),
        msg('读取 D:/secret/key.md', {from: 'agent'}),
        {role: 'assistant', content: 'D:/secret/key.md'},
    ]};
    assert.equal(userNamedPath(session, 'D:/secret/key.md'), false);
});

test('无消息或无路径字面量 → false', () => {
    assert.equal(userNamedPath(null, 'D:/a.md'), false);
    assert.equal(userNamedPath({messages: []}, 'D:/a.md'), false);
    assert.equal(userNamedPath({messages: [msg('没有路径的一句话')]}, 'D:/a.md'), false);
    assert.equal(userNamedPath({messages: [msg('总结 D:/Novel')]}, ''), false);
});

// ---------- sensitiveReadDenyReason ----------

test('应用数据目录下的路径硬拒，目录外与空 appDir 放过', () => {
    const appDir = 'C:/Users/admin/AppData/Roaming/CaDt-DataLens';
    const reason = sensitiveReadDenyReason('C:\\Users\\admin\\AppData\\Roaming\\CaDt-DataLens\\ai-config.json', appDir);
    assert.ok(reason && reason.includes('应用数据目录'));
    assert.equal(sensitiveReadDenyReason('C:/Users/admin/AppData/Roaming/CaDt-DataLensX/a.md', appDir), null);
    assert.equal(sensitiveReadDenyReason('D:/Novel/a.md', appDir), null);
    assert.equal(sensitiveReadDenyReason('D:/Novel/a.md', ''), null);
});
