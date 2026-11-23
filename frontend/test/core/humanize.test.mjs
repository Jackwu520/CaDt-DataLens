// humanize.test.mjs：core/humanize.js 的纯逻辑测试（node:test，无 DOM）。
// 覆盖 formatBytes（默认/紧凑两种口径）、formatFullTime、relativeTime（各时间档与边界）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatBytes, formatFullTime, relativeTime} from '../../src/core/humanize.js';

test('formatBytes 默认口径：B/KB/MB/GB/TB，≥100 取整、其余 1 位', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(2200 * 1024), '2.1 MB');
    assert.equal(formatBytes(1128 * 1024 * 1024), '1.1 GB');
    assert.equal(formatBytes(4 * 1024 * 1024 * 1024 * 1024), '4.0 TB');
    assert.equal(formatBytes('bad'), '0 B');
    assert.equal(formatBytes(-5), '0 B');
});

test('formatBytes 紧凑口径：无空格、去尾零', () => {
    assert.equal(formatBytes(0, {compact: true}), '0B');
    assert.equal(formatBytes(512, {compact: true}), '512B');
    assert.equal(formatBytes(1024, {compact: true}), '1KB');
    assert.equal(formatBytes(12.3 * 1024, {compact: true}), '12.3KB');
    assert.equal(formatBytes(5 * 1024 * 1024, {compact: true}), '5MB');
});

test('formatFullTime：YYYY-MM-DD HH:mm:ss，非法 Date 回退「—」', () => {
    assert.equal(formatFullTime(new Date(2020, 0, 2, 3, 4, 5)), '2020-01-02 03:04:05');
    assert.equal(formatFullTime(new Date('nope')), '—');
});

test('relativeTime：刚刚 / 分钟 / 小时 / 天 / 回退完整时间', () => {
    const now = Date.now();
    assert.equal(relativeTime(now - 30_000), '刚刚');
    assert.equal(relativeTime(now - 5 * 60_000), '5 分钟前');
    assert.equal(relativeTime(now - 2 * 3_600_000), '2 小时前');
    assert.equal(relativeTime(now - 3 * 86_400_000), '3 天前');
    // 超过 7 天回退完整时间（不再出现「400 天前」）
    assert.match(relativeTime(now - 30 * 86_400_000), /^\d{4}-\d{2}-\d{2} /);
    // 未来时间也回退完整时间，而不是「刚刚」
    assert.match(relativeTime(now + 3_600_000), /^\d{4}-\d{2}-\d{2} /);
    assert.equal(relativeTime(0), '—');
});
