// notify-throttle.test.mjs —— 通知节流纯逻辑：同 key 窗口内抑制、窗口后放行、不同 key 独立。

import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotifyThrottle} from '../../src/core/notify-throttle.js';

test('同 key 在窗口内只放行第一次', () => {
    let t = 1000;
    const allow = createNotifyThrottle({windowMs: 30000, now: () => t});
    assert.equal(allow('save'), true);
    assert.equal(allow('save'), false);
    t += 10000;
    assert.equal(allow('save'), false);
});

test('窗口过后重新放行', () => {
    let t = 1000;
    const allow = createNotifyThrottle({windowMs: 30000, now: () => t});
    assert.equal(allow('save'), true);
    t += 30000;
    assert.equal(allow('save'), true);
});

test('不同 key 互不干扰', () => {
    let t = 1000;
    const allow = createNotifyThrottle({windowMs: 30000, now: () => t});
    assert.equal(allow('save'), true);
    assert.equal(allow('disk'), true);
    assert.equal(allow('save'), false);
    assert.equal(allow('disk'), false);
});

test('可显式传时间戳，忽略注入时钟', () => {
    const allow = createNotifyThrottle({windowMs: 100, now: () => 0});
    assert.equal(allow('x', 500), true);
    assert.equal(allow('x', 550), false);
    assert.equal(allow('x', 600), true);
});

test('缺省窗口为 30s，空 key 归一为空串', () => {
    let t = 0;
    const allow = createNotifyThrottle({now: () => t});
    assert.equal(allow(null), true);
    assert.equal(allow(''), false);
    t += 30000;
    assert.equal(allow(undefined), true);
});
