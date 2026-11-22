// db-completion.test.mjs —— SQL 控制台补全（frontend/src/db/db-completion.js）。
// 覆盖：点号上下文解析、别名解析、方言关键词、元数据懒聚合缓存（单飞/命中/失效/noCache
// 只带一轮）、失败静默降级、reset。backend 全部用假实现，不发任何真实请求。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SQL_KEYWORDS, keywordsForKind,
    parseSqlContext, resolveAliasMap, tablesInSql, isDdlSql,
    createSqlCompletion,
} from '../../src/db/db-completion.js';

// ── 纯函数 ──

test('keywordsForKind：sqlite 基表、mysql 为超集且含 information_schema', () => {
    assert.ok(SQL_KEYWORDS.sqlite.length > 30);
    assert.ok(SQL_KEYWORDS.mysql.length >= SQL_KEYWORDS.sqlite.length);
    assert.ok(SQL_KEYWORDS.mysql.includes('information_schema'));
    assert.equal(keywordsForKind('sqlite'), SQL_KEYWORDS.sqlite);
    assert.equal(keywordsForKind('mysql'), SQL_KEYWORDS.mysql);
    assert.equal(keywordsForKind('未知方言'), SQL_KEYWORDS.sqlite, '未知方言回 sqlite 基表');
});

test('parseSqlContext：词首 / 点号尾 / 库.表. / 空尾', () => {
    assert.deepEqual(parseSqlContext('SELECT * FROM us'), {chain: [], endsWithDot: false, prefix: 'us'});
    assert.deepEqual(parseSqlContext('SELECT * FROM '), {chain: [], endsWithDot: false, prefix: ''}, '空尾无前缀');
    assert.deepEqual(parseSqlContext('SELECT p.'), {chain: ['p'], endsWithDot: true, prefix: ''});
    assert.deepEqual(parseSqlContext('SELECT mydb.users.'), {chain: ['mydb', 'users'], endsWithDot: true, prefix: ''});
    assert.deepEqual(parseSqlContext('SELECT mydb.users.na'), {chain: ['mydb', 'users'], endsWithDot: false, prefix: 'na'});
    assert.deepEqual(parseSqlContext(''), {chain: [], endsWithDot: false, prefix: ''});
    assert.deepEqual(parseSqlContext(null), {chain: [], endsWithDot: false, prefix: ''});
});

test('resolveAliasMap：AS 别名 / 裸别名 / 关键词不算别名 / 点号引用 / 表自映射', () => {
    const map = resolveAliasMap('SELECT * FROM users u, JOIN orders AS o ON o.uid = u.id WHERE u.age > 1');
    assert.equal(map.get('u'), 'users');
    assert.equal(map.get('o'), 'orders');
    assert.equal(map.get('users'), 'users');
    assert.equal(map.get('orders'), 'orders');
    assert.equal(map.has('on'), false, 'ON 不是别名');
    assert.equal(map.has('where'), false, 'WHERE 不是别名');
    const dotted = resolveAliasMap('SELECT * FROM main.users t');
    assert.equal(dotted.get('t'), 'main.users');
    assert.equal(dotted.get('users'), 'main.users');
    assert.equal(tablesInSql(dotted).length, 1, '自映射去重');
    assert.deepEqual(tablesInSql(dotted)[0], {db: 'main', table: 'users'});
    assert.deepEqual(tablesInSql(resolveAliasMap('')), []);
});

test('isDdlSql：CREATE/ALTER/DROP/TRUNCATE 命中，DML 不算', () => {
    assert.equal(isDdlSql('CREATE TABLE t(a int)'), true);
    assert.equal(isDdlSql('alter table t add c int'), true);
    assert.equal(isDdlSql('DROP TABLE t'), true);
    assert.equal(isDdlSql('truncate table t'), true);
    assert.equal(isDdlSql('SELECT 1'), false);
    assert.equal(isDdlSql(''), false);
    assert.equal(isDdlSql(null), false);
});

// ── completer（假 backend）──

function makeBackend(opts = {}) {
    const calls = {databases: 0, objects: 0, describe: 0, lastNoCache: null, lastDb: null};
    return {
        calls,
        async DBListDatabases() {
            calls.databases++;
            return opts.databases || ['main'];
        },
        async DBListObjects(sid, db) {
            calls.objects++;
            calls.lastDb = db;
            if (opts.failObjects) throw new Error('boom');
            return [{name: 'products', kind: 'table'}, {name: 'v_summary', kind: 'view'}];
        },
        async DBDescribe(sid, db, table, noCache) {
            calls.describe++;
            calls.lastNoCache = !!noCache;
            calls.lastDb = db;
            if (opts.failDescribe) throw new Error('boom');
            return {columns: [
                {name: 'id', type: 'INTEGER', pk: true, notNull: true},
                {name: 'name', type: 'TEXT'},
                {name: 'price', type: 'REAL'},
            ]};
        },
    };
}

function makeSession(sqlText) {
    return {getValue: () => sqlText};
}

function completerItems(comp, session, pos) {
    return new Promise((resolve) => {
        comp.completer.getCompletions(null, session, pos, '', (err, items) => resolve(items || []));
    });
}

test('无会话：只给关键词，不打任何元数据请求', async () => {
    const backend = makeBackend();
    const comp = createSqlCompletion({backend, getSession: () => null});
    const items = await completerItems(comp, makeSession('SELECT * FROM '), {row: 0, column: 15});
    assert.ok(items.some((i) => i.caption === 'select' && i.meta === 'SQL'));
    assert.equal(backend.calls.databases, 0);
    assert.equal(backend.calls.describe, 0);
});

test('词首触发：对象 + 引用表的列 + 关键词；元数据缓存命中后不再发请求', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'mysql'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM p';
    const items = await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(items.some((i) => i.caption === 'products' && i.meta === '表'), '对象清单候选');
    assert.ok(items.some((i) => i.caption === 'price'), 'products 的列候选（前缀命中）');
    assert.ok(items.some((i) => i.caption === 'pragma' && i.meta === 'SQL'), '关键词层');
    assert.equal(backend.calls.objects, 1);
    assert.equal(backend.calls.describe, 1, '单表只描述一次');
    // 二次触发：全部走缓存
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.equal(backend.calls.objects, 1);
    assert.equal(backend.calls.describe, 1);
});

test('方言关键词参与前缀过滤', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'mysql'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT info';
    const items = await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(items.some((i) => i.caption === 'information_schema' && i.meta === 'SQL'));
});

test('并发单飞：同一张表并发触发只发一次 DBDescribe', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM products WHERE id = 1';
    await Promise.all([
        completerItems(comp, makeSession(sql), {row: 0, column: sql.length}),
        completerItems(comp, makeSession(sql), {row: 0, column: sql.length}),
        completerItems(comp, makeSession(sql), {row: 0, column: sql.length}),
    ]);
    assert.equal(backend.calls.describe, 1);
});

test('点号上下文：别名解析 → 只给列候选，不给关键词', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT p. FROM products p WHERE p.id = 1';
    const items = await completerItems(comp, makeSession(sql), {row: 0, column: 9}); // 光标停在 "SELECT p."
    assert.ok(items.some((i) => i.caption === 'price' && i.meta === 'REAL'), '列候选带类型 meta');
    assert.equal(items.some((i) => i.meta === 'SQL'), false, '点号尾不给关键词');
});

test('点号上下文：库.表 跨库描述', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'mysql'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT mydb.products.';
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.equal(backend.calls.lastDb, 'mydb');
});

test('quick doc：列候选直接携带 docText（bundle 的 tooltip 兜底渲染自带 docText 的候选）', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT p. FROM products p';
    const items = await completerItems(comp, makeSession(sql), {row: 0, column: 9});
    const id = items.find((i) => i.caption === 'id');
    assert.match(id.docText, /INTEGER/);
    assert.match(id.docText, /主键/);
    assert.match(id.docText, /NOT NULL/);
    const name = items.find((i) => i.caption === 'name');
    assert.ok(name.docText.includes('TEXT') && !name.docText.includes('主键'), '非主键列不带主键标注');
});

test('DDL 执行后：缓存失效 + 下次描述带 noCache（只带一轮）', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM products WHERE id = 1';
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.equal(backend.calls.lastNoCache, false);
    comp.noteQueryOutcome({status: 'ok', writes: 0}, 'CREATE TABLE t2(a int)');
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.equal(backend.calls.lastNoCache, true, 'DDL 后第一轮绕过 Go 缓存');
    // 第二轮恢复正常缓存路径（换一张表，避免 products 缓存命中导致根本不发请求）
    const sql2 = 'SELECT * FROM orders WHERE id = 1';
    await completerItems(comp, makeSession(sql2), {row: 0, column: sql2.length});
    assert.equal(backend.calls.lastNoCache, false, '第二轮恢复正常缓存路径');
});

test('写语句执行后：缓存同样失效', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM products WHERE id = 1';
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    const before = backend.calls.describe;
    comp.noteQueryOutcome({status: 'ok', writes: 2}, 'UPDATE products SET price = 9');
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(backend.calls.describe > before, '缓存被清，重新描述');
});

test('DDL 与在途描述竞态：旧结果不写缓存，下一轮 noCache 重新描述', async () => {
    let resolveDescribe;
    const calls = [];
    const backend = {
        async DBListDatabases() { return ['main']; },
        async DBListObjects() { return [{name: 'products', kind: 'table'}]; },
        async DBDescribe(sid, db, table, noCache) {
            calls.push(!!noCache);
            if (calls.length === 1) await new Promise((res) => { resolveDescribe = res; });
            return {columns: [{name: calls.length === 1 ? 'stale_col' : 'fresh_col', type: 'TEXT'}]};
        },
    };
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM products WHERE '; // 空前缀（词尾空白）：候选不被前缀过滤
    const first = completerItems(comp, makeSession(sql), {row: 0, column: sql.length}); // 描述在途
    await new Promise((r) => setTimeout(r, 20)); // 等 loadObjects 完成、describe#1 真正进入等待
    comp.noteQueryOutcome({status: 'ok', writes: 0}, 'CREATE TABLE t2(a int)'); // 在途期间 DDL
    resolveDescribe();
    const items1 = await first;
    assert.ok(items1.some((i) => i.caption === 'stale_col'), '旧结果只给当轮调用方（stale 一轮可接受）');
    const items2 = await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.equal(calls[1], true, '下一轮描述带 noCache（竞态轮不能吞掉失效）');
    assert.ok(items2.some((i) => i.caption === 'fresh_col'), '新结果进入候选');
    assert.ok(!items2.some((i) => i.caption === 'stale_col'), '旧结果未写入缓存');
});

test('元数据失败：静默降级，不抛错', async () => {
    const backend = makeBackend({failDescribe: true, failObjects: true});
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    // 词首：对象/列全失败，关键词仍在
    const sql = 'SELECT * FROM products WHERE id = 1';
    const items = await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(items.some((i) => i.caption === 'select'));
    // 点号尾：列拉不到 → 空候选，不抛
    const items2 = await completerItems(comp, makeSession('SELECT p. FROM products p'), {row: 0, column: 9});
    assert.deepEqual(items2, []);
});

test('reset：清空全部会话缓存', async () => {
    const backend = makeBackend();
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM products WHERE id = 1';
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    const before = backend.calls.describe;
    comp.reset();
    await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(backend.calls.describe > before);
});

test('getSession 抛异常：callback 恰好调用一次（纯关键词降级），不抛 unhandledRejection', async () => {
    const backend = makeBackend();
    const comp = createSqlCompletion({backend, getSession: () => { throw new Error('boom'); }});
    let calls = 0;
    await new Promise((resolve) => {
        comp.completer.getCompletions(null, makeSession('SELECT * FROM p'), {row: 0, column: 16}, '', (err, items) => {
            calls++;
            resolve(items || []);
        });
    });
    assert.equal(calls, 1);
});

test('空库/瞬时失败不缓存：下次触发重试（DBListDatabases 两次都发）', async () => {
    const opts = {databases: []};
    const backend = makeBackend(opts);
    const session = {id: 's1', kind: 'sqlite'};
    const comp = createSqlCompletion({backend, getSession: () => session});
    const sql = 'SELECT * FROM p';
    const items1 = await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(!items1.some((i) => i.meta === '表'), '空库无对象候选');
    assert.equal(backend.calls.objects, 0, '空库名不发 DBListObjects');
    opts.databases = ['main']; // 连接就绪
    const items2 = await completerItems(comp, makeSession(sql), {row: 0, column: sql.length});
    assert.ok(items2.some((i) => i.caption === 'products' && i.meta === '表'), '重试后拿到对象清单');
    assert.equal(backend.calls.databases, 2, '空结果不缓存，第二次真实重试');
});
