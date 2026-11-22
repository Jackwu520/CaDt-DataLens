// db-registry.test.mjs —— 工作区数据库清单纯函数（frontend/src/db/db-registry.js）。
// 侧栏面板与 AI 的 app_control 动作共用这套语义；覆盖引用同步/移除/隔离。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DB_REGISTRY_KEY,
    syncWorkspaceDbRef,
    removeAllWorkspaceDbRefs,
    workspaceDbEntries,
} from '../../src/db/db-registry.js';

function freshSettings() {
    return {[DB_REGISTRY_KEY]: []};
}

test('syncWorkspaceDbRef：加入 → 移除 → 重复同步不堆叠', () => {
    const settings = freshSettings();
    const spec = {connectionId: 'dbc-1', inWorkspace: true, name: '测试库', protocol: 'mysql'};
    syncWorkspaceDbRef(settings, 'ws1', spec);
    syncWorkspaceDbRef(settings, 'ws1', spec); // 重复同步：仍只有一条
    assert.equal(workspaceDbEntries(settings, 'ws1').length, 1);
    const [entry] = workspaceDbEntries(settings, 'ws1');
    assert.equal(entry.kind, 'mysql');
    assert.equal(entry.name, '测试库');
    assert.equal(entry.connectionId, 'dbc-1');

    syncWorkspaceDbRef(settings, 'ws1', {...spec, inWorkspace: false});
    assert.equal(workspaceDbEntries(settings, 'ws1').length, 0, '移除后清空');
});

test('驱动标签：mariadb 分组独立，协议切换替换旧引用', () => {
    const settings = freshSettings();
    syncWorkspaceDbRef(settings, 'ws', {connectionId: 'dbc-2', inWorkspace: true, name: 'a', protocol: 'mysql'});
    syncWorkspaceDbRef(settings, 'ws', {connectionId: 'dbc-2', inWorkspace: true, name: 'a', protocol: 'mariadb'});
    const entries = workspaceDbEntries(settings, 'ws');
    assert.equal(entries.length, 1, '同连接换协议：旧引用被替换');
    assert.equal(entries[0].kind, 'mariadb');
});

test('工作区隔离：同一连接可分属不同工作区', () => {
    const settings = freshSettings();
    syncWorkspaceDbRef(settings, 'wsA', {connectionId: 'dbc-3', inWorkspace: true, name: 'x', protocol: 'mysql'});
    syncWorkspaceDbRef(settings, 'wsB', {connectionId: 'dbc-3', inWorkspace: true, name: 'x', protocol: 'mysql'});
    assert.equal(workspaceDbEntries(settings, 'wsA').length, 1);
    assert.equal(workspaceDbEntries(settings, 'wsB').length, 1);
});

test('removeAllWorkspaceDbRefs：跨工作区全清，别的连接不受影响', () => {
    const settings = freshSettings();
    for (const ws of ['wsA', 'wsB']) {
        syncWorkspaceDbRef(settings, ws, {connectionId: 'gone', inWorkspace: true, name: 'g', protocol: 'mysql'});
        syncWorkspaceDbRef(settings, ws, {connectionId: 'keep', inWorkspace: true, name: 'k', protocol: 'mysql'});
    }
    removeAllWorkspaceDbRefs(settings, 'gone');
    assert.equal(workspaceDbEntries(settings, 'wsA').length, 1);
    assert.equal(workspaceDbEntries(settings, 'wsB').length, 1);
    assert.equal(workspaceDbEntries(settings, 'wsA')[0].connectionId, 'keep');
});

test('坏形状容忍：settings 无键 / 键不是数组', () => {
    assert.deepEqual(workspaceDbEntries({}, 'ws'), []);
    assert.deepEqual(workspaceDbEntries({[DB_REGISTRY_KEY]: 'garbage'}, 'ws'), []);
    const settings = {};
    assert.doesNotThrow(() => syncWorkspaceDbRef(settings, 'ws', {connectionId: 'c', inWorkspace: true, name: 'n'}));
    assert.equal(workspaceDbEntries(settings, 'ws').length, 1);
});
