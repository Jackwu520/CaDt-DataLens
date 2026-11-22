// db-create-table.test.mjs：结构化建表的 SQL 生成纯函数（标识符校验 / 主键语义 / 类型白名单）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCreateTableSQL, isValidIdent, COLUMN_TYPES} from '../../src/db/db-create-table.js';

test('isValidIdent：字母数字下划线、不以数字开头、非空', () => {
    assert.equal(isValidIdent('gen_table'), true);
    assert.equal(isValidIdent('_x'), true);
    assert.equal(isValidIdent('9tab'), false);
    assert.equal(isValidIdent('a b'), false);
    assert.equal(isValidIdent('t-1'), false);
    assert.equal(isValidIdent(''), false);
    assert.equal(isValidIdent(null), false);
});

test('单主键：列内 PRIMARY KEY，INTEGER 主键保持 rowid 别名形态', () => {
    const sql = buildCreateTableSQL('t', [
        {name: 'id', type: 'INTEGER', pk: true},
        {name: 'name', type: 'TEXT'},
    ]);
    assert.equal(sql, 'CREATE TABLE "t" ("id" INTEGER NOT NULL PRIMARY KEY, "name" TEXT)');
});

test('无主键 + 必填：NOT NULL 落列内', () => {
    const sql = buildCreateTableSQL('logs', [
        {name: 'ts', type: 'TEXT', notNull: true},
        {name: 'msg', type: 'TEXT'},
    ]);
    assert.equal(sql, 'CREATE TABLE "logs" ("ts" TEXT NOT NULL, "msg" TEXT)');
});

test('复合主键：统一表级 PRIMARY KEY 声明，主键列隐含 NOT NULL', () => {
    const sql = buildCreateTableSQL('rel', [
        {name: 'a', type: 'INTEGER', pk: true},
        {name: 'b', type: 'INTEGER', pk: true},
        {name: 'note', type: 'TEXT'},
    ]);
    assert.equal(sql, 'CREATE TABLE "rel" ("a" INTEGER NOT NULL, "b" INTEGER NOT NULL, "note" TEXT, PRIMARY KEY ("a", "b"))');
});

test('拒绝：坏表名 / 坏列名 / 重复列名 / 空列 / 类型不在白名单', () => {
    const ok = {name: 'a', type: 'TEXT'};
    assert.throws(() => buildCreateTableSQL('9t', [ok]), /表名/);
    assert.throws(() => buildCreateTableSQL('t', [{...ok, name: 'a b'}]), /列名/);
    assert.throws(() => buildCreateTableSQL('t', [ok, {...ok}]), /列名重复/);
    assert.throws(() => buildCreateTableSQL('t', []), /至少要有一列/);
    assert.throws(() => buildCreateTableSQL('t', [{name: 'a', type: 'JSONB'}]), /列类型/);
});

test('类型白名单齐全', () => {
    assert.deepEqual(COLUMN_TYPES, ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC']);
});
