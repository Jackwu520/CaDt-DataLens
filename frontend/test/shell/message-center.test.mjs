// message-center.test.mjs —— 消息中心：
// 1) 历史迁移纯函数：审批 / 待填写曾被标成 error（红叉图标），读取时统一改成 info（ⓘ），不动真正的错误消息。
// 2) 工厂初始化回归：createMessageCenter 里 let messages = load() 早于 load 依赖的 const，
//    曾因 TDZ 直接抛「Cannot access before initialization」，整个消息中心初始化失败（2026-11-23 运行日志）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateApprovalKind, createMessageCenter} from '../../src/shell/message-center.js';

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

test('初始化不抛错，并在读取时剔除旧的「AI 任务完成」流水', () => {
    const prevDoc = globalThis.document;
    const prevStore = globalThis.localStorage;
    globalThis.document = {getElementById: () => null};
    globalThis.localStorage = {
        data: Object.create(null),
        getItem(k) {
            return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null;
        },
        setItem(k, v) {
            this.data[k] = String(v);
        },
        removeItem(k) {
            delete this.data[k];
        },
    };
    try {
        localStorage.setItem('datalens-message-center', JSON.stringify([
            {id: 'm1', ts: 1, kind: 'success', title: 'AI 任务完成', body: ''},
            {id: 'm2', ts: 2, kind: 'info', title: '保留我', body: ''},
        ]));
        // 这一步曾在 load() 里引用尚未初始化的 const 而抛 ReferenceError
        const center = createMessageCenter({});
        assert.deepEqual(Object.keys(center).sort(), ['add', 'clearAll', 'refreshBadge', 'togglePanel']);
        const kept = JSON.parse(localStorage.getItem('datalens-message-center'));
        assert.equal(kept.length, 1);
        assert.equal(kept[0].title, '保留我');
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
        if (prevStore === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = prevStore;
    }
});
