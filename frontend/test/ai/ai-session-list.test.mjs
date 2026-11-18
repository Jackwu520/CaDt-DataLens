// ai-session-list：会话右键菜单组装（buildSessionMenuItems）纯函数测试。
// 规则：不适用的项直接不出现——支线才有「提升为独立会话」、信箱有积压才有「清空信箱」、
// 磁盘存储才有「复制会话路径」；普通对话不再出现一排灰掉的无关项。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionMenuItems, aggregateSessionBadge} from '../../src/ai/ai-session-list.js';

const baseEnv = {pendingNoticeCount: () => 0, diskStorage: true};
const labelsOf = (items) => items.filter((item) => item.label).map((item) => item.label);

test('普通会话：不出现「提升为独立会话」「清空信箱」，出现两个复制项', () => {
    const session = {id: 's1', pinned: false};
    const items = buildSessionMenuItems(session, baseEnv);
    const labels = labelsOf(items);
    assert.ok(!labels.includes('提升为独立会话'), '非支线不应有提升项');
    assert.ok(!labels.some((l) => l.startsWith('清空信箱')), '无积压不应有清空信箱');
    assert.ok(labels.includes('复制会话ID'));
    assert.ok(labels.includes('复制会话路径'));
    // act 键齐全：每个非 sep 项都能映射到真实动作
    for (const item of items) {
        if (!item.sep) assert.ok(item.act, '菜单项缺少 act 键: ' + JSON.stringify(item));
    }
});

test('支线会话：出现「提升为独立会话」', () => {
    const items = buildSessionMenuItems({id: 's2', sideOf: 's1'}, baseEnv);
    const item = items.find((it) => it.act === 'promote');
    assert.ok(item, '支线应有提升项');
    assert.equal(item.label, '提升为独立会话');
});

test('信箱积压：N 条才出现「清空信箱（N 条）」，0 条不出现', () => {
    const withPending = buildSessionMenuItems(
        {id: 's3'},
        {pendingNoticeCount: () => 2, diskStorage: false},
    );
    const item = withPending.find((it) => it.act === 'clearMailbox');
    assert.ok(item, '有积压应有清空信箱');
    assert.equal(item.label, '清空信箱（2 条）');
    const empty = buildSessionMenuItems({id: 's3'}, baseEnv);
    assert.ok(!empty.some((it) => it.act === 'clearMailbox'), '无积压不应有清空信箱');
});

test('内存/legacy 模式：不出现「复制会话路径」，保留「复制会话ID」', () => {
    const items = buildSessionMenuItems({id: 's4'}, {pendingNoticeCount: () => 0, diskStorage: false});
    const labels = labelsOf(items);
    assert.ok(!labels.includes('复制会话路径'));
    assert.ok(labels.includes('复制会话ID'));
});

test('置顶与归档：标签切换、归档会话的置顶项禁用', () => {
    const pinned = buildSessionMenuItems({id: 's5', pinned: true}, baseEnv);
    assert.ok(labelsOf(pinned).includes('取消置顶'));
    const archived = buildSessionMenuItems({id: 's5', archivedAt: 123}, baseEnv);
    const labels = labelsOf(archived);
    assert.ok(labels.includes('取消归档'));
    assert.ok(labels.includes('归档会话') === false);
    assert.equal(archived.find((it) => it.act === 'togglePin').disabled, true);
    const normal = buildSessionMenuItems({id: 's5'}, baseEnv);
    assert.ok(labelsOf(normal).includes('置顶会话'));
    assert.ok(labelsOf(normal).includes('归档会话'));
});

test('结构不变量：删除会话恒在末尾且 danger；分隔线不夹空段', () => {
    const items = buildSessionMenuItems({id: 's6'}, baseEnv);
    const last = items[items.length - 1];
    assert.equal(last.label, '删除会话');
    assert.equal(last.danger, true);
    for (let i = 1; i < items.length; i++) {
        assert.ok(!(items[i].sep && items[i - 1].sep), '连续两条分隔线');
    }
    assert.equal(items[0].label, '新建会话');
});

// 活动栏会话图标状态点：按 error > pending > done 取最高，仅当前工作区，running 忽略。
const badgeEnv = (statusMap, {currentKey = 'ws-a', keyOf = () => 'ws-a'} = {}) => ({
    sessionStatus: (s) => statusMap[s.id] || '',
    workspaceKeyOf: keyOf,
    currentWorkspaceKey: () => currentKey,
});

test('状态点优先级：error > pending > done，全无则空', () => {
    const sessions = [{id: 'e'}, {id: 'p'}, {id: 'd'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error', p: 'pending', d: 'done'})), 'error');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({p: 'pending', d: 'done'})), 'pending');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({d: 'done'})), 'done');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({})), '');
});

test('状态点忽略 running 与空状态', () => {
    const sessions = [{id: 'r'}, {id: 'n'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({r: 'running', n: ''})), '');
    // running 不该压过 done
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({r: 'running', n: 'done'})), 'done');
});

test('状态点仅统计当前工作区；当前键为空一律不显示', () => {
    const sessions = [{id: 'e'}, {id: 'p'}];
    const keyOf = (s) => (s.id === 'e' ? 'ws-b' : 'ws-a');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error', p: 'done'}, {keyOf})), 'done',
        'error 属于别的工作区，不该计入');
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error'}, {currentKey: ''})), '',
        '未打开工作区不显示');
});

test('状态点跳过归档会话', () => {
    const sessions = [{id: 'e', archivedAt: 123}, {id: 'p'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({e: 'error', p: 'pending'})), 'pending',
        '归档的 error 不该计入');
});

test('状态点透传被抑制的状态（正在查看的会话返回空，不产生点）', () => {
    const sessions = [{id: 'viewed'}];
    assert.equal(aggregateSessionBadge(sessions, badgeEnv({viewed: ''})), '');
});
