// ai-session-scope.test.mjs：AI 面板「当前会话属于哪个工作区」的判定。
// 回归场景：多窗口共享 ai-config.json 的 activeSessionId，新窗口打开另一个工作区时
// 面板会直接恢复成上一个工作区的对话（见 ai-session-scope.js 头注释）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decideSessionForWorkspace, normalizePath, pickWorkspaceSession, workspaceKey} from '../../src/ai/ai-session-scope.js';

const MINE = 'd:/work/other'; // 本窗口打开的工作区
const OTHER = 'd:/code/cadt-datalens'; // 上一个窗口（当前会话属于这里）
const OWN_KEY = MINE;

function keyOf(session) {
    return String((session && session.workspace) || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function sess(id, workspace, extra = {}) {
    return {id, workspace, updatedAt: 1, ...extra};
}

test('当前会话属于别的工作区：切到本工作区最近的会话', () => {
    const current = sess('s-other', 'D:\\code\\CaDt-DataLens');
    const list = [
        current,
        sess('s-mine-old', MINE, {updatedAt: 10}),
        sess('s-mine-new', 'D:\\Work\\Other', {updatedAt: 50}),
    ];
    const d = decideSessionForWorkspace(current, OWN_KEY, list, keyOf);
    assert.equal(d.action, 'switch');
    assert.equal(d.session.id, 's-mine-new');
});

test('本工作区还没有会话：新建空会话，不沿用别人的对话', () => {
    const current = sess('s-other', OTHER);
    const d = decideSessionForWorkspace(current, OWN_KEY, [current], keyOf);
    assert.equal(d.action, 'create');
    assert.equal(d.session, undefined);
});

test('当前会话已属本工作区：不动（大小写/斜杠归一后一致）', () => {
    const current = sess('s-mine', 'D:\\Work\\Other\\');
    const d = decideSessionForWorkspace(current, OWN_KEY, [current], keyOf);
    assert.equal(d.action, 'keep');
});

test('老会话没有工作区归属：绑定到当前工作区，不换会话', () => {
    const current = sess('s-legacy', '');
    const d = decideSessionForWorkspace(current, OWN_KEY, [current], keyOf);
    assert.equal(d.action, 'bind');
});

test('当前窗口没有工作区（欢迎页）：不做任何切换', () => {
    const current = sess('s-other', OTHER);
    const d = decideSessionForWorkspace(current, '', [current], keyOf);
    assert.equal(d.action, 'keep');
});

test('有回合在跑（busy）：不改看别的会话', () => {
    const current = sess('s-other', OTHER);
    const list = [current, sess('s-mine', MINE, {updatedAt: 10})];
    const d = decideSessionForWorkspace(current, OWN_KEY, list, keyOf, {busy: true});
    assert.equal(d.action, 'keep');
});

test('候选排除归档会话、支线会话与当前会话自身', () => {
    const list = [
        sess('archived', MINE, {updatedAt: 90, archivedAt: 1}),
        sess('side', MINE, {updatedAt: 80, sideOf: 's-parent'}),
        sess('ok', MINE, {updatedAt: 5}),
    ];
    assert.equal(pickWorkspaceSession(list, OWN_KEY, keyOf), list[2]);
    assert.equal(pickWorkspaceSession(list, OWN_KEY, keyOf, 'ok'), null);
    assert.equal(pickWorkspaceSession(list, '', keyOf), null);
});

// ---- 工作区归一 key 与分桶哈希向量（与 Go 侧 sessionstore_test.go 的
// TestWorkspaceBucketKeyVectors 互为镜像，改任一侧必须同步另一侧）----
// 磁盘分桶由 Go 侧 WorkspaceBucketKey 计算（sha256(key) 前 8 hex），前端只把 key
// 用于 UI 分组对账；这里用 node:crypto 复算同一哈希，锁死两端归一语义不漂移。
function bucketKeyOf(workspace) {
    const key = workspaceKey(workspace);
    return key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : '_unbound';
}

test('workspaceKey 归一：反斜杠/尾斜杠/大小写/叠斜杠/点段/协议前缀', () => {
    assert.equal(workspaceKey('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(workspaceKey('D:/OraSkyC/Project/CandySweet/CaDt-DataLens'), 'd:/oraskyc/project/candysweet/cadt-datalens');
    assert.equal(workspaceKey('D:/Foo/Bar/'), 'd:/foo/bar');
    assert.equal(workspaceKey('d:\\Foo\\BAR'), 'd:/foo/bar');
    assert.equal(workspaceKey('D:/mixed//slashes/'), 'd:/mixed/slashes');
    assert.equal(workspaceKey('a/./b/../c'), 'a/c');
    assert.equal(workspaceKey('file://D:/x/y'), 'file://d:/x/y');
    assert.equal(workspaceKey(''), '');
    assert.equal(workspaceKey('   '), '');
    assert.equal(workspaceKey('/'), '');
    assert.equal(normalizePath('a/../../b'), 'b'); // 顶层 .. 无处弹出时被丢弃
});

test('分桶哈希向量与 Go 侧 WorkspaceBucketKey 一致', () => {
    assert.equal(bucketKeyOf('D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens'), '35dc7bd8');
    assert.equal(bucketKeyOf('D:/OraSkyC/Project/CandySweet/CaDt-DataLens'), '35dc7bd8');
    assert.equal(bucketKeyOf('D:/Foo/Bar/'), '335d5c8a');
    assert.equal(bucketKeyOf('d:\\Foo\\BAR'), '335d5c8a');
    assert.equal(bucketKeyOf('D:/mixed//slashes/'), '02f5a654');
    assert.equal(bucketKeyOf('a/./b/../c'), '24586ae9');
    assert.equal(bucketKeyOf('file://D:/x/y'), 'd3934be2');
    assert.equal(bucketKeyOf(''), '_unbound');
    assert.equal(bucketKeyOf('   '), '_unbound');
    assert.equal(bucketKeyOf('/'), '_unbound');
});
