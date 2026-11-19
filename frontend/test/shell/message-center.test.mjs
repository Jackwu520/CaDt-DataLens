// message-center.test.mjs —— 消息中心历史迁移纯函数：
// 审批 / 待填写曾被标成 error（红叉图标），读取时统一改成 info（ⓘ），不动真正的错误消息。

import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateApprovalKind} from '../../src/shell/message-center.js';

test('审批 / 待填写的 error 消息改判为 info', () => {
    for (const title of ['AI 待审批', 'AI 待填写']) {
        const m = {kind: 'error', title};
        assert.equal(migrateApprovalKind(m), true);
        assert.equal(m.kind, 'info');
    }
});

test('60 秒催办的「（仍在等待）」后缀同样迁移', () => {
    const m = {kind: 'error', title: 'AI 待审批（仍在等待）'};
    assert.equal(migrateApprovalKind(m), true);
    assert.equal(m.kind, 'info');
});

test('真正的错误消息与已是 info 的消息不动', () => {
    const failed = {kind: 'error', title: 'AI 任务失败'};
    assert.equal(migrateApprovalKind(failed), false);
    assert.equal(failed.kind, 'error');
    const ok = {kind: 'info', title: 'AI 待审批'};
    assert.equal(migrateApprovalKind(ok), false);
    assert.equal(ok.kind, 'info');
    const other = {kind: 'error', title: '工作区防护提示'};
    assert.equal(migrateApprovalKind(other), false);
    assert.equal(other.kind, 'error');
});

test('空值与脏输入安全返回 false', () => {
    assert.equal(migrateApprovalKind(null), false);
    assert.equal(migrateApprovalKind(undefined), false);
    assert.equal(migrateApprovalKind({}), false);
    assert.equal(migrateApprovalKind({kind: 'error'}), false);
});
