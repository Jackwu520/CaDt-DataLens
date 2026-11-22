// db-model.test.mjs —— 数据库连接页纯函数（frontend/src/db/db-model.js）。
// 覆盖：行键编解码、主键定位、筛选算子、状态文案、修改摘要、可编辑判定。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    kindLabel, encodeRowKey, decodeRowKey, rowKeyOf, rowKeysMap,
    FILTER_OPS, filterOpNeedsValue, formatElapsed, rowEstimateLabel,
    dirtySummary, tableEditable, confirmReasonLabel, buildDDL,
} from '../../src/db/db-model.js';

const META = {
    pk: ['id'],
    columns: [
        {name: 'id', type: 'INTEGER', pk: true},
        {name: 'name', type: 'TEXT', pk: false},
    ],
};

test('行键编解码往返', () => {
    const key = encodeRowKey(['1', 'ab']);
    assert.deepEqual(decodeRowKey(key), ['1', 'ab']);
    assert.deepEqual(encodeRowKey([null, '']), '\x1f');
    assert.deepEqual(decodeRowKey(''), ['']);
    // \x1f 是分隔符本身：值里不该出现（主键值不含单元分隔符）
    assert.notEqual(encodeRowKey(['1', 'ab']).indexOf('\x1f'), -1);
});

test('rowKeyOf / rowKeysMap 按元数据主键对位', () => {
    const row = ['7', 'alpha'];
    const columns = ['id', 'name'];
    assert.equal(rowKeyOf(META, row, columns), '7');
    assert.deepEqual(rowKeysMap(META, row, columns), {id: '7'});
    // 主键列不在行里时占位空串（不抛错）
    assert.equal(rowKeyOf(META, row, ['x', 'y']), '');
});

test('筛选算子：null/notNull 不需要值', () => {
    for (const op of FILTER_OPS) {
        assert.equal(filterOpNeedsValue(op.value), !(op.value === 'null' || op.value === 'notNull'));
    }
});

test('耗时与行数估算文案', () => {
    assert.equal(formatElapsed(12), '12 ms');
    assert.equal(formatElapsed(1500), '1.50 s');
    assert.equal(rowEstimateLabel(0), '');
    assert.equal(rowEstimateLabel(500), '约 500 行');
    assert.equal(rowEstimateLabel(4200), '约 4.2K 行');
    assert.equal(rowEstimateLabel(2500000), '约 2.5M 行');
});

test('待提交修改摘要', () => {
    assert.equal(dirtySummary({}), '');
    assert.equal(dirtySummary({updates: new Map([['a', 1]]), deletes: new Set(['b']), inserts: [{}]}),
        '1 处修改 · 1 行待删 · 1 行待插');
    assert.equal(dirtySummary({updates: new Map(), deletes: new Set(), inserts: []}), '');
});

test('表可编辑判定：主键 + 会话允许 + 非全局锁 + 非视图', () => {
    const editableMeta = {editable: true, pk: ['id'], kind: 'table'};
    assert.equal(tableEditable(editableMeta, true, false), true);
    assert.equal(tableEditable({...editableMeta, editable: false}, true, false), false);
    assert.equal(tableEditable(editableMeta, false, false), false);
    assert.equal(tableEditable(editableMeta, true, true), false);
    assert.equal(tableEditable({...editableMeta, kind: 'view'}, true, false), false);
    assert.equal(tableEditable({...editableMeta, pk: []}, true, false), false);
});

test('确认原因文案与 Go guard 对应', () => {
    assert.equal(confirmReasonLabel('danger'), '危险操作');
    assert.equal(confirmReasonLabel('missingWhere'), '缺 WHERE（全表生效）');
    assert.equal(confirmReasonLabel(''), '');
});

test('会话类型文案', () => {
    assert.equal(kindLabel('sqlite'), 'SQLite');
    assert.equal(kindLabel('mysql'), 'MySQL');
    assert.equal(kindLabel(''), '');
});

// ---- buildDDL：从表元数据生成建表语句（复制/导出 DDL）----

test('buildDDL：SQLite 单主键落列内 + 唯一索引还原 + autoindex 跳过', () => {
    const meta = {
        table: 'products',
        columns: [
            {name: 'id', type: 'INTEGER', notNull: true},
            {name: 'name', type: 'TEXT', notNull: true},
            {name: 'note', type: 'TEXT', default: null},
        ],
        pk: ['id'],
        indexes: [
            {name: 'sqlite_autoindex_products_1', unique: true, columns: ['id']},
            {name: 'idx_products_name', unique: false, columns: ['name']},
        ],
    };
    const sql = buildDDL('sqlite', meta);
    assert.match(sql, /CREATE TABLE "products" \(/);
    assert.match(sql, /"id" INTEGER NOT NULL PRIMARY KEY/);
    assert.match(sql, /"note" TEXT/);
    assert.match(sql, /CREATE INDEX "idx_products_name" ON "products" \("name"\)/);
    assert.ok(!sql.includes('autoindex'));
});

test('buildDDL：MySQL 反引号 + DEFAULT 字面量 + 复合主键表级声明', () => {
    const meta = {
        table: 'rel',
        columns: [
            {name: 'a', type: 'INT', notNull: true},
            {name: 'b', type: 'INT', notNull: true},
            {name: 'label', type: 'VARCHAR(64)', default: 'x'},
        ],
        pk: ['a', 'b'],
        indexes: [],
    };
    const sql = buildDDL('mysql', meta);
    assert.match(sql, /CREATE TABLE `rel` \(/);
    assert.match(sql, /`label` VARCHAR\(64\) DEFAULT 'x'/);
    assert.match(sql, /PRIMARY KEY \(`a`, `b`\)/);
});

test('buildDDL：无 meta / 视图元数据兜底', () => {
    assert.equal(buildDDL('sqlite', null), '');
    const viewMeta = {table: 'v', kind: 'view', columns: [{name: 'x', type: 'INT'}], pk: [], indexes: []};
    assert.match(buildDDL('sqlite', viewMeta), /CREATE TABLE "v"/);
});
