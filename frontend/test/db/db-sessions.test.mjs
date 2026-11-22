// db-sessions.test.mjs：会话管理器——幂等连接共享 pending、断开世代释放、订阅通知。
// db-sessions 的依赖链（db-plugin → plugin-db-drivers）不含 DOM，可在 Node 直测；
// 用注入的假 backend 驱动连接行为（sqlite/mariadb 两个 kind 路径 + 插件路径不覆盖，
// 插件门面行为归 db-plugin 的既有语义）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    configureDbSessions, ensureSession, disconnectSession, reconnectSession,
    getSessionState, subscribeSession, isSessionMissing, _resetDbSessionsForTests,
} from '../../src/db/db-sessions.js';

// 模块级单例跨用例隔离：每个用例开头 reset()
function reset() {
    _resetDbSessionsForTests();
}

// 可编排的假 backend：connect 可延迟/可失败；close 记录调用
function fakeBackend() {
    const calls = {open: 0, connect: 0, close: []};
    let gate = null; // {resolve, reject} 存在时 open/connect 挂起
    let failWith = null;
    const backend = {
        async DBOpen(path, allowEdit) {
            calls.open++;
            if (failWith) { const e = failWith; failWith = null; throw e; }
            if (gate) await new Promise((res, rej) => gate.push({res, rej}));
            return {id: 's-sqlite-' + calls.open, kind: 'sqlite', name: 'a.db', editable: !!allowEdit};
        },
        async DBConnect(connectionId) {
            calls.connect++;
            if (failWith) { const e = failWith; failWith = null; throw e; }
            if (gate) await new Promise((res, rej) => gate.push({res, rej}));
            return {id: 's-mysql-' + calls.connect, kind: 'mysql', name: 'c', server: 'h:3306'};
        },
        async DBClose(id) {
            calls.close.push(id);
        },
    };
    return {backend, calls,
        hold() { gate = []; return gate; },
        release(gate, value) { for (const p of gate.splice(0)) p.res(value); },
        failNext(err) { failWith = err; },
    };
}

const sqliteEntry = () => ({id: 'wsdb-1', kind: 'sqlite', path: 'D:/t/a.db', allowEdit: true});
const mysqlEntry = () => ({id: 'wsdb-2', kind: 'mysql', connectionId: 'conn-9'});

test('幂等连接：并发 ensureSession 共享同一 pending，只发起一次连接', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    const g = fx.hold();
    const p1 = ensureSession(sqliteEntry());
    const p2 = ensureSession(sqliteEntry());
    fx.release(g);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(fx.calls.open, 1);
    assert.equal(r1.info.id, r2.info.id);
    assert.equal(getSessionState('wsdb-1').status, 'connected');
});

test('已连接的 ensureSession 直接复用会话，不再发起连接', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    const r1 = await ensureSession(sqliteEntry());
    const r2 = await ensureSession(sqliteEntry());
    assert.equal(fx.calls.open, 1);
    assert.equal(r1.info.id, r2.info.id);
});

test('连接失败：状态置 error 且错误可读，后续 ensure 可重试', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    fx.failNext(new Error('连不上'));
    await assert.rejects(() => ensureSession(mysqlEntry()), /连不上/);
    const st = getSessionState('wsdb-2');
    assert.equal(st.status, 'error');
    assert.match(st.error, /连不上/);
    // 重试成功路径（首次失败已消耗一次 connect 计数，第二次拿到新 id）
    const r = await ensureSession(mysqlEntry());
    assert.ok(r.info.id.startsWith('s-mysql-'));
    assert.equal(getSessionState('wsdb-2').status, 'connected');
});

test('断开：状态清空且后端 DBClose 被调用', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    await ensureSession(sqliteEntry());
    await disconnectSession('wsdb-1');
    assert.deepEqual(fx.calls.close, ['s-sqlite-1']);
    assert.equal(getSessionState('wsdb-1').status, 'closed');
    assert.equal(getSessionState('wsdb-1').info, null);
});

test('在飞连接被断开超越：resolve 后自释放刚拿到的会话（epoch 防线）', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    const g = fx.hold();
    const p = ensureSession(sqliteEntry());
    const pDisc = disconnectSession('wsdb-1'); // 连接还在飞时就断开
    fx.release(g);
    await Promise.all([p, pDisc]).catch(() => {});
    // 给自释放的 DBClose 一拍落地
    await new Promise((res) => setTimeout(res, 0));
    assert.deepEqual(fx.calls.close, ['s-sqlite-1']);
    assert.equal(getSessionState('wsdb-1').status, 'closed');
});

test('订阅：连接成功/失败/断开都会通知，退订后不再收', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    const seen = [];
    const unsub = subscribeSession('wsdb-1', (st) => seen.push(st.status));
    await ensureSession(sqliteEntry());
    await disconnectSession('wsdb-1');
    unsub();
    await ensureSession(sqliteEntry()); // 已退订，不应再进 seen
    assert.ok(seen.includes('connecting'));
    assert.ok(seen.includes('connected'));
    assert.ok(seen.includes('closed'));
    const after = seen.filter((s) => s === 'connected').length;
    assert.equal(after, 1);
});

test('重连：断开旧会话后以最新条目参数新建连接', async () => {
    reset();
    const fx = fakeBackend();
    configureDbSessions({backend: fx.backend});
    const r1 = await ensureSession(sqliteEntry());
    const changed = {...sqliteEntry(), allowEdit: false}; // 条目参数变更（如关闭允许编辑）
    const r2 = await reconnectSession(changed);
    assert.notEqual(r1.info.id, r2.info.id);
    assert.equal(fx.calls.close.length, 1);
    assert.equal(r2.info.editable, false);
    assert.equal(getSessionState('wsdb-1').info.editable, false);
});

test('isSessionMissing 识别会话不存在类错误（空闲回收/手动断开后调用）', () => {
    assert.equal(isSessionMissing(new Error('会话不存在：s-1')), true);
    assert.equal(isSessionMissing(new Error('session not found')), true);
    assert.equal(isSessionMissing(new Error('连接超时')), false);
});
