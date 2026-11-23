// test/core/json-safe.test.mjs：core/json-safe.js 的兜底语义。
// 迁移点原写法是 `try { JSON.parse(x || '[]') } catch { fallback }`：这里钉住
// 「空输入 / 坏文本 → fallback」与「合法 null 字面量不当成失败」两条边界。
import test from 'node:test';
import assert from 'node:assert/strict';

import {parseJson} from '../../src/core/json-safe.js';

test('parseJson：合法 JSON 原样返回', () => {
    assert.deepEqual(parseJson('[1,2]', []), [1, 2]);
    assert.deepEqual(parseJson('{"a":1}', {}), {a: 1});
    assert.equal(parseJson('"x"', null), 'x');
    assert.equal(parseJson('0', null), 0);
    assert.equal(parseJson('false', null), false);
});

test('parseJson：空输入（null / undefined / 空串）直接给 fallback', () => {
    const arr = [];
    assert.equal(parseJson(null, arr), arr);
    assert.equal(parseJson(undefined, arr), arr);
    assert.equal(parseJson('', arr), arr);
    assert.equal(parseJson(undefined, null), null);
});

test('parseJson：坏文本给 fallback，不抛错', () => {
    const arr = [];
    assert.equal(parseJson('{oops', arr), arr);
    assert.equal(parseJson('undefined', arr), arr);
    assert.equal(parseJson('{"a":1,}', arr), arr);
});

test('parseJson：合法 null 字面量按解析成功处理（≠ fallback）', () => {
    // 原写法 JSON.parse('null') 同样得到 null；调用方若需要 {} 必须自己 `|| {}`
    assert.equal(parseJson('null', {}), null);
});

test('parseJson：非字符串输入先转字符串（旧写法 resp.body 可能给数字/布尔）', () => {
    assert.equal(parseJson(0, null), 0);
    assert.equal(parseJson(true, null), true);
});

test('parseJson：fallback 可以是任意类型（数组 / 对象 / null / 函数）', () => {
    const fn = () => 1;
    assert.equal(parseJson('x', fn), fn);
    assert.deepEqual(parseJson('', {}), {});
});
