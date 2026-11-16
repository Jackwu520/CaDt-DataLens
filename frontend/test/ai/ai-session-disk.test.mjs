// ai-session-disk.test.mjs：懒加载会话的不变量。
// 这一层的错误是「不可逆」的（用空正文重写 3MB 历史），所以护栏必须有测试盯着：
//   1. 占位会话（只有 meta）写盘只能写 meta，绝不触发日志 append / rewrite；
//   2. 占位的 messageCount / turnTs 必须沿用 meta 缓存值，否则会把 0 写回 meta.json；
//   3. 归档 / 清空 / 整份重写三个入口拒绝占位；
//   4. hydrateSession 就地补正文，引用不变、占位标记清干净、条数回到现算。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createSessionDiskStore} from '../../src/ai/ai-session-disk.js';
import {
    buildSessionMeta,
    encodeMessageEvent,
    encodeSessionHeader,
    encodeSessionLines,
    metaSignature,
} from '../../src/ai/ai-session-store.js';

// 正文与 meta 必须同源：logOf 写的消息形状，meta 的 messageCount / turnTs 就得算出同一个值，
// 否则「补水后签名不该误判成 meta 变了」这条不变量会被假数据自己打破。
function msgsOf(count) {
    return new Array(count).fill(0).map((unused, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'msg' + i,
        ts: 2000 + i,
    }));
}

function logOf(id, count) {
    const events = [encodeSessionHeader({id, title: 'T-' + id, workspace: 'D:/w', createdAt: 1000})];
    msgsOf(count).forEach((message, i) => {
        events.push(encodeMessageEvent(message, 'm-' + id + '-' + i, false));
    });
    return encodeSessionLines(events);
}

function makeStore(counts) {
    const metas = Object.entries(counts).map(([id, count]) => buildSessionMeta({
        id,
        title: 'T-' + id,
        workspace: 'D:/w',
        createdAt: 1000,
        updatedAt: 3000,
        messages: msgsOf(count),
    }));
    const calls = {meta: [], append: 0, rewrite: 0, read: 0};
    const backend = {
        AISessionList: async () => metas.map((meta) => JSON.stringify(meta)),
        AISessionRead: async (id) => {
            calls.read++;
            return logOf(id, counts[id]);
        },
        AISessionWriteMeta: async (id, text) => { calls.meta.push({id, meta: JSON.parse(text)}); },
        AISessionAppend: async () => { calls.append++; },
        AISessionRewrite: async () => { calls.rewrite++; },
        AISessionDelete: async () => {},
    };
    const normalizeMessage = (raw) => (raw && raw.role
        ? {role: raw.role, content: String(raw.content || ''), ts: Number(raw.ts) || 0, _mid: raw._mid}
        : null);
    const store = createSessionDiskStore({backend, normalizeMessage});
    const normalizeSession = (raw) => ({...raw, messages: [], archived: []});
    return {store, calls, normalizeSession};
}

test('toStubs 只产占位、不读正文，条数来自 meta', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3, b: 5});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    assert.equal(stubs.length, 2);
    assert.ok(stubs.every((session) => session._stub === true));
    assert.deepEqual(stubs.map((session) => session._msgCount), [3, 5]);
    // 排序键缓存：占位没有正文，列表的时间与顺序只能靠 meta 里的轮次起点
    assert.deepEqual(stubs.map((session) => session._turnTs), [2002, 2004]);
    assert.equal(calls.read, 0, '列表阶段不应该读任何正文');
});

test('占位写盘只写 meta：未改不写，改 unread 只写一次且条数不能变 0', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);

    await store.persistSession(stubs[0]);
    assert.equal(calls.meta.length, 0, '没改过的占位不该写 meta');

    stubs[0].unread = 'done';
    await store.persistSession(stubs[0]);
    assert.equal(calls.meta.length, 1);
    assert.equal(calls.meta[0].meta.unread, 'done');
    assert.equal(calls.meta[0].meta.messageCount, 3, '条数必须沿用占位缓存，不能写成 0');
    assert.equal(calls.meta[0].meta.turnTs, 2002, '轮次起点同理，不能写成 0');
    assert.equal(calls.append, 0, '占位绝不能追加日志');
    assert.equal(calls.rewrite, 0, '占位绝不能整份重写日志');
});

test('归档 / 清空 / 整份重写拒绝占位会话', async () => {
    const {store, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    for (const call of [
        () => store.archiveSession(stubs[0], 1, null),
        () => store.resetSession(stubs[0]),
        () => store.rewriteSession(stubs[0]),
    ]) {
        assert.throws(call, /尚未加载/);
    }
});

test('hydrateSession 就地补正文：引用不变、标记清干净、条数回到现算', async () => {
    const {store, calls, normalizeSession} = makeStore({a: 3});
    const stubs = store.toStubs(await store.loadMetas(), normalizeSession);
    const stub = stubs[0];
    const ok = await store.hydrateSession(stub);
    assert.equal(ok, true);
    assert.equal(calls.read, 1);
    assert.equal(stub._stub, undefined, '补完不能还留着占位标记');
    assert.equal(stub.messages.length, 3);
    assert.equal(buildSessionMeta(stub).messageCount, 3);
    // 补完的指纹签名要按真实正文重算，否则下一次 persist 会误判「meta 变了」再写一遍
    assert.equal(stub._metaSig, metaSignature(buildSessionMeta(stub)));
    // 占位已清除 → 再 hydrate 是 no-op
    assert.equal(await store.hydrateSession(stub), true);
    assert.equal(calls.read, 1);
});

test('hydrateSession 读失败：清占位 + 打 _loadError（等于禁止写盘）', async () => {
    const writes = {meta: 0, append: 0, rewrite: 0};
    const store = createSessionDiskStore({
        backend: {
            AISessionList: async () => [],
            AISessionRead: async () => { throw new Error('boom'); },
            AISessionWriteMeta: async () => { writes.meta++; },
            AISessionAppend: async () => { writes.append++; },
            AISessionRewrite: async () => { writes.rewrite++; },
            AISessionDelete: async () => {},
        },
    });
    const stub = {id: 'x', title: 'x', messages: [], archived: [], _stub: true, _msgCount: 4};
    const ok = await store.hydrateSession(stub);
    assert.equal(ok, false);
    assert.equal(stub._stub, undefined, '不能永远停在「正在载入」');
    assert.match(stub._loadError, /boom/);
    // 带 _loadError 的会话被 persistSession 直接跳过：读不出来就绝不写（避免覆盖磁盘历史）
    await store.persistSession(stub);
    assert.equal(writes.meta, 0);
    assert.equal(writes.append, 0);
    assert.equal(writes.rewrite, 0);
});
