// test/core/id.test.mjs：core/id.js 的短 id 形状（形状即契约——id 会落进 JSONL / 设置，
// 迁移时只允许等价改写，位数与分隔符由这里钉住）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {newId, randomIdSuffix} from '../../src/core/id.js';

const BASE36 = /^[0-9a-z]*$/;

test('randomIdSuffix：只产出 base36 字符，长度不超过请求位数', () => {
    for (const len of [0, 1, 4, 6, 8]) {
        for (let i = 0; i < 50; i++) {
            const s = randomIdSuffix(len);
            assert.ok(BASE36.test(s), `非 base36 字符：${JSON.stringify(s)}`);
            assert.ok(s.length <= len, `长度 ${s.length} 超过 ${len}`);
        }
    }
});

test('randomIdSuffix：len 不合法（负数 / 非数字）时退化为空串或忽略', () => {
    assert.equal(randomIdSuffix(0), '');
    assert.equal(randomIdSuffix(-3), '');
    assert.equal(randomIdSuffix('abc'), '');
});

test('newId：前缀 + 36 进制时间戳，默认 6 位随机后缀、无分隔符', () => {
    const id = newId('datalens-');
    assert.match(id, /^datalens-[0-9a-z]{7,}([0-9a-z])?$/);
    assert.ok(id.startsWith('datalens-'), id);
    const rest = id.slice('datalens-'.length);
    // 时间戳是固定长度的 base36（当前时间 8 位），随机后缀最多 6 位
    assert.ok(rest.length >= 7 && rest.length <= 14, `长度异常：${rest.length} (${rest})`);
});

test('newId：sep / suffixLength 保持旧生成点的形状（等价改写，不许漂移）', () => {
    // 旧：'rp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    const runProfile = newId('rp-', {sep: '-', suffixLength: 4});
    assert.match(runProfile, /^rp-[0-9a-z]+-[0-9a-z]{0,4}$/);
    // 旧：prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    const aiId = newId('genjob-', {suffixLength: 5});
    assert.match(aiId, /^genjob-[0-9a-z]+[0-9a-z]{0,5}$/);
    // 旧：'----CaDtDataLensBoundary' + ts + slice(2, 10)（无分隔符，8 位后缀）
    const boundary = newId('----CaDtDataLensBoundary', {suffixLength: 8});
    assert.ok(boundary.startsWith('----CaDtDataLensBoundary'));
    assert.equal(boundary.endsWith('-'), false);
});

test('newId：suffixLength 为 0 时只有前缀与时间戳', () => {
    const id = newId('x-', {suffixLength: 0});
    assert.match(id, /^x-[0-9a-z]+$/);
});

test('newId：连续生成的 id 不重复，且空前缀可用', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(newId());
    assert.equal(seen.size, 500);
});

test('newId：缺省参数不抛错（prefix 省略）', () => {
    const id = newId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    assert.ok(BASE36.test(id), id);
});
