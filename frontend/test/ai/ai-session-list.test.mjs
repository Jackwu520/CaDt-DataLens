// ai-session-list：会话右键菜单组装（buildSessionMenuItems）纯函数测试。
// 规则：不适用的项直接不出现——支线才有「提升为独立会话」、信箱有积压才有「清空信箱」、
// 磁盘存储才有「复制会话路径」；普通对话不再出现一排灰掉的无关项。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionMenuItems, buildWorkspaceMenuItems, aggregateSessionBadge, planPendingNeedsAttention} from '../../src/ai/ai-session-list.js';

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

// 工作区分组头「⋯」菜单：有路径给完整工作区操作、无路径只给打开类、关闭仅当前工作区出现。
const wsEnv = (recent = []) => ({recent, baseName: (p) => String(p || '').split('/').pop()});

test('工作区菜单（有路径，非当前）：资源管理器/复制路径/新窗口/新建会话，无关闭', () => {
    const items = buildWorkspaceMenuItems({path: 'D:/repos/foo', current: false}, wsEnv());
    const labels = labelsOf(items);
    assert.ok(labels.includes('在文件资源管理器中显示'));
    assert.ok(labels.includes('复制工作区路径'));
    assert.ok(labels.includes('在新窗口打开此工作区'));
    assert.ok(labels.includes('在此工作区新建会话'));
    assert.ok(labels.includes('打开文件夹…'));
    assert.ok(!labels.includes('关闭当前工作区'));
    // 每个非分隔、非子菜单项都要有 act
    for (const item of items) {
        if (!item.sep && !item.submenu) assert.ok(item.act, '缺少 act: ' + JSON.stringify(item));
    }
});

test('工作区菜单（当前工作区）：新窗口项禁用，出现关闭当前工作区', () => {
    const items = buildWorkspaceMenuItems({path: 'D:/repos/foo', current: true}, wsEnv());
    const labels = labelsOf(items);
    assert.ok(labels.includes('关闭当前工作区'));
    assert.equal(items.find((it) => it.act === 'openNewWindow').disabled, true);
});

test('工作区菜单（未关联工作区）：只给打开类，无路径相关项与关闭', () => {
    const items = buildWorkspaceMenuItems({path: '', current: false}, wsEnv());
    const labels = labelsOf(items);
    assert.ok(labels.includes('打开文件夹…'));
    assert.ok(!labels.includes('复制工作区路径'));
    assert.ok(!labels.includes('关闭当前工作区'));
});

test('工作区菜单：最近打开以子菜单给出，act=openRecent 带路径', () => {
    const items = buildWorkspaceMenuItems(
        {path: 'D:/repos/foo', current: true},
        wsEnv([{path: 'D:/repos/bar', name: 'bar'}, {path: 'D:/repos/baz'}]),
    );
    const recentItem = items.find((it) => it.submenu);
    assert.ok(recentItem, '应有最近打开子菜单');
    assert.equal(recentItem.submenu.length, 2);
    assert.equal(recentItem.submenu[0].label, 'bar');
    assert.equal(recentItem.submenu[0].act, 'openRecent');
    assert.equal(recentItem.submenu[0].arg, 'D:/repos/bar');
    assert.equal(recentItem.submenu[1].label, 'baz', '无 name 时回退 baseName');
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

// 计划待批准的 pending/info 角标：AI 正在为该计划工作时（流挂着）不该报「待用户动手」。
const planSession = (over = {}) => ({
    id: 's1', planMode: true, activePlan: {status: 'pending', markdown: '# 计划'}, messages: [], ...over,
});

test('planPendingNeedsAttention：待批准且无流 → 需要用户注意', () => {
    assert.equal(planPendingNeedsAttention(planSession(), false), true);
});

test('planPendingNeedsAttention：AI 正在为该计划工作（有流）→ 不需要注意', () => {
    assert.equal(planPendingNeedsAttention(planSession(), true), false,
        '继续规划后新一轮在跑，列表应显示 running 而非 pending(info)');
});

test('planPendingNeedsAttention：非 pending / 非计划模式 / 无计划 → 不需要注意', () => {
    assert.equal(planPendingNeedsAttention(planSession({activePlan: {status: 'approved'}}), false), false);
    assert.equal(planPendingNeedsAttention(planSession({planMode: false}), false), false);
    assert.equal(planPendingNeedsAttention(planSession({activePlan: null}), false), false);
    assert.equal(planPendingNeedsAttention(null, false), false);
});
