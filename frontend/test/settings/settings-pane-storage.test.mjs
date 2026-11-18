// settings-pane-storage 纯函数测试：分组排序、勾选收敛、体积文案、确认与回执文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    barSegments,
    autoCleanScope,
    cacheConfirmText,
    cacheIDs,
    clearConfirmText,
    clearReportText,
    dangerPicked,
    formatBytes,
    groupStorageItems,
    itemMetaText,
    prunePicked,
    selectedBytes,
    shouldAutoClean,
    tileText,
} from '../../src/settings/settings-pane-storage.js';

const ITEMS = [
    {id: 'run-temp', label: '运行临时副本', kind: 'cache', scope: 'app', inCache: true, bytes: 3 * 1024, files: 42, entries: 6, exists: true},
    {id: 'browser-profiles', label: '内嵌浏览器实例数据', kind: 'cache', scope: 'app', inCache: true, bytes: 1128 * 1024 * 1024, entries: 44, blocked: 1, exists: true},
    {id: 'webview-cache', label: '界面浏览器缓存', kind: 'cache', scope: 'webview', inCache: true, bytes: 152 * 1024 * 1024, entries: 6, pending: true, exists: true},
    {id: 'ws-gen', label: '生图与视频产物', kind: 'data', scope: 'workspace', inCache: false, bytes: 2200 * 1024, files: 24, exists: true},
    {id: 'ai-sessions', label: 'AI 会话记录', kind: 'danger', scope: 'app', inCache: false, bytes: 60 * 1024 * 1024, files: 1204, exists: true},
    {id: 'app-config', label: '全部配置', kind: 'danger', scope: 'app', inCache: false, bytes: 32 * 1024, files: 4, exists: true},
    {id: 'ws-memory', label: '工作区 AI 记忆', kind: 'danger', scope: 'workspace', inCache: false, bytes: 0, exists: false},
];

test('formatBytes：B/KB/MB/GB 逐级，大数不留两位小数', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(2200 * 1024), '2.1 MB');
    assert.equal(formatBytes(1128 * 1024 * 1024), '1.1 GB');
    assert.equal(formatBytes(4 * 1024 * 1024 * 1024 * 1024), '4.0 TB');
    assert.equal(formatBytes('bad'), '0 B');
});

test('groupStorageItems：缓存与数据分开，各自按体积从大到小', () => {
    const {cache, data} = groupStorageItems(ITEMS);
    assert.deepEqual(cache.map((item) => item.id), ['browser-profiles', 'webview-cache', 'run-temp']);
    assert.deepEqual(data.map((item) => item.id), ['ai-sessions', 'ws-gen', 'app-config', 'ws-memory']);
    assert.deepEqual(groupStorageItems(null), {cache: [], data: []});
});

test('cacheIDs：一键范围只取后端标记的条目', () => {
    // 顺序按体积排（与界面列表一致），这里只关心集合本身
    assert.deepEqual([...cacheIDs(ITEMS)].sort(), ['browser-profiles', 'run-temp', 'webview-cache'].sort());
    assert.deepEqual(cacheIDs(undefined), []);
});

test('prunePicked：未登记、已清空与工作区外的勾选都掉出去', () => {
    const kept = prunePicked(ITEMS, ['ai-sessions', 'ws-memory', 'webview-cache', 'nope']);
    // ws-memory 无内容、webview-cache 属缓存段、nope 不在表里
    assert.deepEqual(kept, ['ai-sessions']);
    assert.deepEqual(prunePicked(null, ['ai-sessions']), []);
    assert.deepEqual(prunePicked(ITEMS, null), []);
});

test('prunePicked：已排下次启动的条目仍算可清', () => {
    const items = [{id: 'ui-state', inCache: false, exists: false, pending: true}];
    assert.deepEqual(prunePicked(items, ['ui-state']), ['ui-state']);
});

test('selectedBytes / dangerPicked 按勾选集合取数', () => {
    const picked = ['ws-gen', 'app-config'];
    assert.equal(selectedBytes(ITEMS, picked), 2200 * 1024 + 32 * 1024);
    assert.deepEqual(dangerPicked(ITEMS, picked).map((item) => item.id), ['app-config']);
    assert.equal(selectedBytes(ITEMS, []), 0);
});

test('clearConfirmText：逐项列大小，危险项点名，webview 说明延后执行', () => {
    const text = clearConfirmText(ITEMS, ['ai-sessions', 'webview-cache', 'ws-gen']);
    assert.match(text, /将清除 3 项/);
    assert.match(text, /AI 会话记录/);
    assert.match(text, /生图与视频产物/);
    assert.match(text, /排到下次启动前执行/);
    assert.match(text, /拿不回来：AI 会话记录/);
});

test('clearConfirmText：无危险项时不提「拿不回来」', () => {
    const text = clearConfirmText(ITEMS, ['ws-gen']);
    assert.doesNotMatch(text, /拿不回来/);
    assert.match(text, /误删可以取回/);
});

test('cacheConfirmText：列缓存范围并点明登录态与延后执行', () => {
    const ids = cacheIDs(ITEMS);
    const text = cacheConfirmText(ITEMS, ids);
    assert.match(text, /内嵌浏览器实例数据/);
    assert.match(text, /网页登录态/);
    assert.match(text, /排到下次启动前执行/);
    assert.match(text, /不影响会话、记忆与设置/);
    // 无内容的条目不进文案，避免「将清除 N 项」与实际对不上
    assert.doesNotMatch(cacheConfirmText(ITEMS, ['run-temp']), /界面浏览器缓存/);
});

test('clearReportText：释放量、排期、使用中与失败都要说出来', () => {
    assert.equal(clearReportText(null), '清理完成');
    assert.equal(clearReportText({freed: 2200 * 1024}), '已释放 2.1 MB');
    assert.equal(clearReportText({freed: 0}), '没有可清除的内容');
    const text = clearReportText({
        freed: 1024,
        scheduled: ['界面浏览器缓存'],
        results: [{blocked: 2}],
        skipped: ['运行日志'],
        failed: ['全部配置'],
    });
    assert.match(text, /已释放 1\.0 KB/);
    assert.match(text, /1 项排到下次启动前清理/);
    assert.match(text, /2 项使用中已跳过/);
    assert.match(text, /部分条目没清干净：运行日志/);
    assert.match(text, /失败：全部配置/);
});

test('itemMetaText：子项数、文件数与估算各自成句（使用中交给徽标）', () => {
    assert.equal(itemMetaText(ITEMS[1]), '44 项');
    assert.equal(itemMetaText(ITEMS[5]), '4 个文件');
    assert.equal(itemMetaText(ITEMS[6]), '无内容');
    assert.equal(itemMetaText({id: 'x', files: 3, approx: true, exists: true}), '3 个文件 · 文件过多，数字为估算');
    assert.equal(itemMetaText(null), '—');
});

test('tileText：文件数与「其他」并列，空目录写空', () => {
    assert.equal(tileText({path: '/x', files: 12, otherBytes: 4096}), '12 个文件 · 其他 4.0 KB');
    assert.equal(tileText({path: '/x', files: 0, otherBytes: 0}), '空');
    assert.equal(tileText({path: '', files: 0}), '位置不可用');
    assert.equal(tileText(null), '位置不可用');
});

test('barSegments：缓存 / 数据 / 其他三段，其他取自各格的未登记容量', () => {
    const report = {
        cacheBytes: 100,
        dataBytes: 200,
        tiles: [{otherBytes: 10}, {otherBytes: 5}, {otherBytes: 0}],
    };
    assert.deepEqual(barSegments(report), [
        {key: 'cache', label: '可释放缓存', bytes: 100},
        {key: 'data', label: '用户数据', bytes: 200},
        {key: 'other', label: '其他', bytes: 15},
    ]);
    assert.equal(barSegments(null)[0].bytes, 0);
});

test('autoCleanScope：inCache 安全子集，排除浏览器登录态与不存在条目', () => {
    // ITEMS：run-temp / browser-profiles / webview-cache 是缓存；ws-gen / ai-sessions 等是数据
    // 顺序随 cacheIDs 按体积降序，这里只关心集合本身
    assert.deepEqual([...autoCleanScope(ITEMS)].sort(), ['run-temp', 'webview-cache'].sort());
    // 不存在的缓存条目（无东西可删）不进范围
    const items = [{id: 'run-temp', inCache: true, exists: true}, {id: 'app-logs', inCache: true, exists: false}];
    assert.deepEqual(autoCleanScope(items), ['run-temp']);
    assert.deepEqual(autoCleanScope(null), []);
    // 防线：自动清理永不送出 data/danger 条目
    const scope = autoCleanScope(ITEMS);
    for (const item of ITEMS) {
        if (scope.includes(item.id)) assert.equal(item.kind, 'cache', item.id + ' 必须是缓存');
    }
});

test('shouldAutoClean：时间 / 大小任一满足即清，0 关闭对应条件', () => {
    const now = 1000 * 86400000;
    const day = 86400000;
    // 时间触发：距上次清理超过间隔
    assert.equal(shouldAutoClean({now, lastAt: now - 7 * day, intervalDays: 7, cacheBytes: 0, thresholdBytes: 500 * 1024 * 1024}), 'interval');
    // 未到间隔、未超阈值 → 不清
    assert.equal(shouldAutoClean({now, lastAt: now - 6 * day, intervalDays: 7, cacheBytes: 100, thresholdBytes: 500 * 1024 * 1024}), '');
    // 大小触发：恰好等于阈值就算超
    assert.equal(shouldAutoClean({now, lastAt: now, intervalDays: 7, cacheBytes: 500 * 1024 * 1024, thresholdBytes: 500 * 1024 * 1024}), 'size');
    // 从未清理过（lastAt=0）视为时间已到期
    assert.equal(shouldAutoClean({now, lastAt: 0, intervalDays: 7, cacheBytes: 0, thresholdBytes: 0}), 'interval');
    // 关闭时间条件（0）后只剩大小条件
    assert.equal(shouldAutoClean({now, lastAt: 0, intervalDays: 0, cacheBytes: 0, thresholdBytes: 0}), '');
    assert.equal(shouldAutoClean({now, lastAt: 0, intervalDays: 0, cacheBytes: 600 * 1024 * 1024, thresholdBytes: 500 * 1024 * 1024}), 'size');
    // 关闭大小条件（0）后只剩时间条件
    assert.equal(shouldAutoClean({now, lastAt: now - 30 * day, intervalDays: 30, cacheBytes: 999 * 1024 * 1024, thresholdBytes: 0}), 'interval');
    // 非法输入兜底：负数间隔按 0（关闭）处理
    assert.equal(shouldAutoClean({now, lastAt: 0, intervalDays: -1, cacheBytes: 0, thresholdBytes: 0}), '');
});
