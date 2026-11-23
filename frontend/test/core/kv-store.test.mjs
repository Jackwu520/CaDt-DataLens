// test/core/kv-store.test.mjs：core/kv-store.js 的降级语义。
// 真实 WebView 里会遇到三种失败：隐私模式（访问 localStorage 就抛）、配额满（setItem 抛）、
// 浏览器里没有 localStorage（Node）。这里用可切换的假存储把三条路径都钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

const {kvGet, kvSet, kvRemove, kvGetJson, kvSetJson} = await import('../../src/core/kv-store.js');

function installFakeStorage(overrides = {}) {
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        ...overrides,
    };
    return map;
}

test('kvGet / kvSet / kvRemove：基本读写往返', () => {
    installFakeStorage();
    assert.equal(kvGet('a'), null);
    assert.equal(kvSet('a', 'x'), true);
    assert.equal(kvGet('a'), 'x');
    assert.equal(kvSet('a', 42), true); // 非字符串按 String 存
    assert.equal(kvGet('a'), '42');
    assert.equal(kvRemove('a'), true);
    assert.equal(kvGet('a'), null);
});

test('kvSet：配额满（setItem 抛）降级为 false，不抛错', () => {
    installFakeStorage({
        setItem() {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
        },
    });
    assert.equal(kvSet('a', 'x'), false);
});

test('kvGet：隐私模式下 getItem 抛错时给 null', () => {
    installFakeStorage({
        getItem() {
            throw new Error('SecurityError');
        },
    });
    assert.equal(kvGet('a'), null);
    assert.deepEqual(kvGetJson('a', []), []);
});

test('访问 localStorage 本身抛错（策略禁用）时不炸：读 null、写 false', () => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
            throw new Error('Access denied');
        },
    });
    assert.equal(kvGet('a'), null);
    assert.equal(kvSet('a', 'x'), false);
    assert.equal(kvRemove('a'), false);
    assert.equal(kvGetJson('a', {x: 1}).x, 1);
    delete globalThis.localStorage;
});

test('kvGetJson：空值 / 损坏值给 fallback', () => {
    installFakeStorage();
    assert.deepEqual(kvGetJson('missing', []), []);
    kvSet('bad', '{oops');
    assert.deepEqual(kvGetJson('bad', []), []);
    assert.equal(kvGetJson('bad', null), null);
});

test('kvSetJson：序列化后写入，读回结构一致', () => {
    installFakeStorage();
    assert.equal(kvSetJson('obj', {a: 1, b: [2]}), true);
    assert.deepEqual(kvGetJson('obj', null), {a: 1, b: [2]});
});

test('kvSetJson：循环引用（序列化失败）不写、返回 false', () => {
    installFakeStorage();
    const cyc = {};
    cyc.self = cyc;
    assert.equal(kvSetJson('cyc', cyc), false);
    assert.equal(kvGet('cyc'), null);
});

test('kvSetJson：undefined 没有 JSON 表示，返回 false 而不是写 "undefined" 脏值', () => {
    installFakeStorage();
    assert.equal(kvSetJson('u', undefined), false);
    assert.equal(kvGet('u'), null);
});
