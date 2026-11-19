import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    HEATMAP_WEEKS,
    buildHeatmapModel,
    buildHeatmapWeeks,
    buildTrendModel,
    dayKeyOf,
    emptySnapshot,
    filledRows,
    formatChatDuration,
    formatHitRate,
    formatRequestSpeed,
    formatRequestTime,
    formatSharePercent,
    formatStatusCode,
    formatTokenCount,
    formatTokenExact,
    formatTtft,
    heatmapLevel,
    monthLabels,
    parseDayKey,
    requestCacheHitRate,
    requestNewInputTokens,
    sliceDailyModels,
    splitModelSlices,
} from '../../src/settings/usage-stats-model.js';

test('formatTokenCount 紧凑单位', () => {
    assert.equal(formatTokenCount(0), '0');
    assert.equal(formatTokenCount(999), '999');
    assert.equal(formatTokenCount(1000), '1K');
    assert.equal(formatTokenCount(1234), '1.2K');
    assert.equal(formatTokenCount(1_500_000), '1.5M');
    assert.equal(formatTokenCount(999_000), '999K');
    assert.equal(formatTokenCount(999_999), '1M'); // 别显示 1000K
    assert.equal(formatTokenCount(150_000_000), '1.5亿');
    assert.equal(formatTokenCount(2_400_000_000), '24亿');
    assert.equal(formatTokenCount(-5), '0');
    assert.equal(formatTokenCount('x'), '0');
});

test('formatTokenExact 千分位', () => {
    assert.equal(formatTokenExact(0), '0');
    assert.equal(formatTokenExact(1234567), '1,234,567');
    assert.equal(formatTokenExact(-1), '0');
});

test('formatChatDuration 两单位口径', () => {
    assert.equal(formatChatDuration(0), '—');
    assert.equal(formatChatDuration(500), '<1s');
    assert.equal(formatChatDuration(30_000), '30s');
    assert.equal(formatChatDuration(45 * 60_000), '45m');
    assert.equal(formatChatDuration((2 * 60 + 13) * 60_000), '2h13m');
    assert.equal(formatChatDuration(3 * 60 * 60_000), '3h');
    assert.equal(formatChatDuration((3 * 24 + 2) * 60 * 60_000), '3d2h');
});

test('formatSharePercent', () => {
    assert.equal(formatSharePercent(0), '0%');
    assert.equal(formatSharePercent(0.004), '<1%');
    assert.equal(formatSharePercent(0.123), '12%');
    assert.equal(formatSharePercent(0.1234), '12%');
    assert.equal(formatSharePercent(0.0123), '1.2%');
    assert.equal(formatSharePercent(1), '100%');
});

test('parseDayKey 按本地日历解析（不偏移一天）', () => {
    const date = parseDayKey('2026-11-19');
    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 10);
    assert.equal(date.getDate(), 19);
    assert.equal(dayKeyOf(date), '2026-11-19');
    assert.equal(parseDayKey('bad'), null);
});

test('heatmapLevel 四档阈值', () => {
    assert.equal(heatmapLevel(0, 100), 0);
    assert.equal(heatmapLevel(10, 100), 1);
    assert.equal(heatmapLevel(30, 100), 2);
    assert.equal(heatmapLevel(60, 100), 3);
    assert.equal(heatmapLevel(80, 100), 4);
    assert.equal(heatmapLevel(10, 0), 1);
});

test('filledRows 按比例填格', () => {
    assert.equal(filledRows(0, 100), 0);
    assert.equal(filledRows(1, 100), 1);
    assert.equal(filledRows(50, 100), 4);
    assert.equal(filledRows(100, 100), 7);
    assert.equal(filledRows(100, 0), 0);
});

test('buildHeatmapWeeks 53 周、周日开头、按日期取数', () => {
    const weeks = buildHeatmapWeeks(
        [{date: '2026-11-19', tokens: 123, requests: 2}, {date: '2026-11-18', tokens: 50, requests: 1}],
        '2026-11-19',
    );
    assert.equal(weeks.length, HEATMAP_WEEKS);
    const last = weeks[weeks.length - 1];
    assert.equal(last.days.length, 7);
    assert.equal(last.days[0].date, '2026-11-15'); // 2026-11-15 是周日
    assert.equal(last.days[4].date, '2026-11-19');
    assert.equal(last.days[4].tokens, 123);
    assert.equal(last.days[4].requests, 2);
    assert.equal(last.days[3].tokens, 50);
    assert.equal(last.days[6].date, '2026-11-21');
    // 第一周与最后一周相差 52 周
    assert.equal(weeks[0].days[0].date, '2025-11-16');
});

test('buildHeatmapModel daily/weekly/cumulative', () => {
    const days = [
        {date: '2026-11-16', tokens: 10, requests: 1},
        {date: '2026-11-17', tokens: 0, requests: 0},
        {date: '2026-11-18', tokens: 20, requests: 1},
        {date: '2026-11-19', tokens: 40, requests: 2},
    ];
    const daily = buildHeatmapModel(days, '2026-11-19', 'daily');
    assert.equal(daily.mode, 'daily');
    const lastDaily = daily.weeks[daily.weeks.length - 1];
    assert.equal(lastDaily.cells[1].level, 1); // 11-16：10 / max40 = 25% → 1
    assert.equal(lastDaily.cells[3].level, 2); // 11-18：20/40 = 50%，严格大于 0.5 才到 3
    assert.equal(lastDaily.cells[4].level, 4); // 11-19 峰值
    assert.equal(lastDaily.cells[2].level, 0);

    const weekly = buildHeatmapModel(days, '2026-11-19', 'weekly');
    assert.equal(weekly.mode, 'weekly');
    const lastWeek = weekly.weeks[weekly.weeks.length - 1];
    assert.equal(lastWeek.value, 70);
    assert.equal(lastWeek.cells.filter((cell) => cell.level > 0).length, 7);
    // 前面的周全是 0
    assert.equal(weekly.weeks[0].value, 0);
    assert.ok(weekly.weeks[0].cells.every((cell) => cell.level === 0));

    const cumulative = buildHeatmapModel(days, '2026-11-19', 'cumulative');
    const lastCum = cumulative.weeks[cumulative.weeks.length - 1];
    assert.equal(lastCum.value, 70);
    const firstNonZero = cumulative.weeks.findIndex((week) => week.value > 0);
    assert.equal(cumulative.weeks[firstNonZero].value, 70);
});

test('monthLabels 月份变化与抽稀', () => {
    const weeks = buildHeatmapWeeks([], '2026-11-19');
    const labels = monthLabels(weeks);
    assert.ok(labels.length > 0);
    let lastIndex = -1;
    for (const label of labels) {
        assert.ok(/^\d{1,2}月$/.test(label.label));
        assert.ok(label.weekIndex > lastIndex);
        lastIndex = label.weekIndex;
        const first = parseDayKey(weeks[label.weekIndex].days[0].date);
        assert.equal(Number(label.label.replace('月', '')) - 1, first.getMonth());
    }
});

test('monthLabels 跳过后补月：起始周在月末不丢下个月标签', () => {
    const week = (index, date) => ({weekIndex: index, days: [{date, tokens: 0, requests: 0}]});
    const labels = monthLabels([
        week(0, '2024-12-29'), // 12 月最后一周
        week(1, '2025-01-05'), // 1 月，距上一标签 1 周：跳过但不吞月份
        week(2, '2025-01-12'), // 1 月，距上一标签 2 周：补上
        week(3, '2025-02-02'), // 2 月，距上一标签 1 周：本轮跳过
        week(4, '2025-02-09'), // 2 月，距上一标签 2 周：补上
    ]);
    assert.deepEqual(labels.map((item) => item.label), ['12月', '1月', '2月']);
});

test('sliceDailyModels 取最近 N 天', () => {
    const daily = Array.from({length: 30}, (_, i) => ({date: '2026-11-' + String(i + 1).padStart(2, '0'), models: []}));
    const seven = sliceDailyModels(daily, 7);
    assert.equal(seven.length, 7);
    assert.equal(seven[0].date, '2026-11-24');
    assert.equal(seven[6].date, '2026-11-30');
});

test('buildTrendModel 多模型折线与缺失补 0', () => {
    const daily = [
        {date: '2026-11-18', models: [{model: 'a', tokens: 10}]},
        {date: '2026-11-19', models: [{model: 'b', tokens: 20}, {model: 'a', tokens: 5}]},
    ];
    const trend = buildTrendModel(daily, ['a', 'b', 'c']);
    assert.deepEqual(trend.dates, ['2026-11-18', '2026-11-19']);
    assert.deepEqual(trend.series[0], {name: 'a', data: [10, 5]});
    assert.deepEqual(trend.series[1], {name: 'b', data: [0, 20]});
    assert.deepEqual(trend.series[2], {name: 'c', data: [0, 0]});
    // 只取前 limit 个
    assert.equal(buildTrendModel(daily, ['a', 'b', 'c'], 2).series.length, 2);
});

test('splitModelSlices 前 N + 其他', () => {
    const models = [
        {model: 'a', tokens: 10, share: 0.1, inputTokens: 6, outputTokens: 4, requests: 1},
        {model: 'b', tokens: 90, share: 0.9, inputTokens: 50, outputTokens: 40, requests: 2},
    ];
    const small = splitModelSlices(models);
    assert.equal(small.items.length, 2);
    assert.equal(small.items[0].model, 'b');
    assert.equal(small.other, null);

    const many = Array.from({length: 8}, (_, i) => ({
        model: 'm' + i, tokens: (8 - i) * 10, share: 0.1, inputTokens: 1, outputTokens: 1, requests: 1,
    }));
    const split = splitModelSlices(many);
    assert.equal(split.items.length, 5);
    assert.equal(split.items[0].model, 'm0');
    assert.equal(split.other.merged, 3);
    assert.equal(split.other.tokens, 30 + 20 + 10);
    assert.equal(split.other.model, '其他');
    // 0 token 的切片不画
    assert.deepEqual(splitModelSlices([{model: 'z', tokens: 0}]).items, []);
});

test('emptySnapshot 结构完整', () => {
    const snap = emptySnapshot('7d');
    assert.equal(snap.range, '7d');
    assert.equal(snap.summary.totalTokens, 0);
    assert.deepEqual(snap.heatmap.days, []);
    assert.deepEqual(snap.dailyModelUsage, []);
    assert.deepEqual(snap.models, []);
});

test('请求日志：新增输入与缓存命中率', () => {
    const row = {promptTokens: 1000, completionTokens: 50, cachedTokens: 800, cacheWriteTokens: 100};
    assert.equal(requestNewInputTokens(row), 100);
    assert.equal(formatHitRate(row), '80.0%');
    assert.equal(requestCacheHitRate(row), 0.8);
    assert.equal(formatHitRate({promptTokens: 100, completionTokens: 5}), '0.0%');
    assert.equal(formatHitRate({promptTokens: 0, completionTokens: 0}), '—');
    // prompt 小于缓存字段时新增输入不能为负
    assert.equal(requestNewInputTokens({promptTokens: 10, cachedTokens: 8, cacheWriteTokens: 5}), 0);
    assert.equal(formatHitRate({promptTokens: 10, cachedTokens: 10}), '100%');
});

test('请求日志：速度只算输出 ≥100 且窗口 ≥200ms', () => {
    assert.equal(formatRequestSpeed({completionTokens: 500, modelMs: 5000, ttftMs: 1000}), '125 tok/s');
    assert.equal(formatRequestSpeed({completionTokens: 500, modelMs: 5000, ttftMs: 0}), '—');
    assert.equal(formatRequestSpeed({completionTokens: 99, modelMs: 5000, ttftMs: 1000}), '—');
    assert.equal(formatRequestSpeed({completionTokens: 500, modelMs: 1100, ttftMs: 1000}), '—');
    assert.equal(formatRequestSpeed({completionTokens: 169, modelMs: 5000, ttftMs: 1000}), '42.3 tok/s');
    assert.equal(formatRequestSpeed({completionTokens: 500, modelMs: 0, ttftMs: 0}), '—');
});

test('请求日志：首字/时间/状态码格式化', () => {
    assert.equal(formatTtft(0), '—');
    assert.equal(formatTtft(450), '450ms');
    assert.equal(formatTtft(1250), '1.3s');
    assert.equal(formatTtft(12500), '13s');
    const ts = new Date(2026, 10, 19, 21, 58, 24).getTime();
    assert.equal(formatRequestTime(ts, new Date(2026, 10, 20).getTime()), '11-19 21:58:24');
    const lastYear = new Date(2025, 0, 2, 3, 4, 5).getTime();
    assert.equal(formatRequestTime(lastYear, ts), '2025-01-02 03:04:05');
    assert.equal(formatRequestTime(0), '—');
    assert.equal(formatStatusCode(200), '200');
    assert.equal(formatStatusCode(0), '—');
    assert.equal(formatStatusCode(42), '—');
});
