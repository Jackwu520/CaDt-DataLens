// settings-pane-wipeguard.test.mjs：工作区防护设置区的纯函数护栏（分组 / 校验 / 格式化）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    groupBackupEntries,
    formatBackupTime,
    humanBytes,
    normalizePathKey,
    validateBackupRoot,
    wipeGuardDefaults,
} from '../../src/settings/settings-pane-wipeguard.js';

// ---- groupBackupEntries ----

test('groupBackupEntries：按文件分组、latest 取最新、按时间倒序', () => {
    const rows = [
        {id: '1', rel: 'a.js', blob: 'x', at: 100, tool: 'edit_file'},
        {id: '2', rel: 'a.js', blob: 'y', at: 300, tool: 'write_file'},
        {id: '3', rel: 'b.js', blob: '', at: 200, tool: 'write_file'},
        {id: '4', rel: '', at: 400}, // 无 rel：跳过
    ];
    const groups = groupBackupEntries(rows);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].rel, 'a.js'); // 300 > 200
    assert.equal(groups[0].latest.id, '2');
    assert.equal(groups[0].count, 2);
    assert.equal(groups[1].rel, 'b.js');
});

test('groupBackupEntries：空入参返回空数组', () => {
    assert.deepEqual(groupBackupEntries([]), []);
    assert.deepEqual(groupBackupEntries(null), []);
});

// ---- formatBackupTime / humanBytes ----

test('formatBackupTime：当年 MM-DD HH:mm，往年带年份，无效给占位', () => {
    const now = new Date(2026, 10, 19).getTime(); // 2026-11-19
    assert.equal(formatBackupTime(new Date(2026, 10, 19, 9, 5).getTime(), now), '11-19 09:05');
    assert.equal(formatBackupTime(new Date(2025, 0, 2).getTime(), now), '2025-01-02');
    assert.equal(formatBackupTime(0, now), '—');
});

test('humanBytes：与 storage pane 同口径', () => {
    assert.equal(humanBytes(0), '0 B');
    assert.equal(humanBytes(1024), '1.0 KB');
    assert.equal(humanBytes(200 * 1024 * 1024), '200 MB');
});

// ---- validateBackupRoot（方案 §4.1 校验）----

test('validateBackupRoot：空 = 默认 appdata', () => {
    assert.deepEqual(validateBackupRoot('', 'D:/ws'), {ok: true, severity: '', reason: ''});
});

test('validateBackupRoot：非绝对路径拒绝', () => {
    const verdict = validateBackupRoot('backups', 'D:/ws');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.severity, 'error');
});

test('validateBackupRoot：工作区内部拒绝（放进去 = 白放）', () => {
    for (const p of ['D:\\ws\\backups', 'D:/ws', 'D:/ws/sub/deep']) {
        const verdict = validateBackupRoot(p, 'D:/ws');
        assert.equal(verdict.ok, false, p);
        assert.equal(verdict.severity, 'error');
    }
});

test('validateBackupRoot：工作区祖先目录给 warn（不挡但提示）', () => {
    const verdict = validateBackupRoot('D:\\', 'D:/ws');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.severity, 'warn');
});

test('validateBackupRoot：无关联路径通过', () => {
    const verdict = validateBackupRoot('E:\\backups', 'D:/ws');
    assert.deepEqual(verdict, {ok: true, severity: '', reason: ''});
});

// ---- normalizePathKey / defaults ----

test('normalizePathKey：反斜杠归一 + 去尾斜杠 + 小写', () => {
    assert.equal(normalizePathKey('D:\\Ws\\Sub\\'), 'd:/ws/sub');
});

test('wipeGuardDefaults：全部默认开启（方案 §3.4）', () => {
    assert.deepEqual(wipeGuardDefaults(), {enabled: true, snapshots: true, backupRoot: ''});
});
