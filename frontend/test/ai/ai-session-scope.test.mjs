// ai-session-scope.test.mjs：AI 面板「当前会话属于哪个工作区」的判定。
// 回归场景：多窗口共享 ai-config.json 的 activeSessionId，新窗口打开另一个工作区时
// 面板会直接恢复成上一个工作区的对话（见 ai-session-scope.js 头注释）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {decideSessionForWorkspace, pickWorkspaceSession} from '../../src/ai/ai-session-scope.js';

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
