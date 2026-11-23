// test/core/clipboard.test.mjs：core/clipboard.js 的降级顺序（先 Go 绑定，再 Web API）。
// 顺序是契约：WebView2 里 Web API 在窗口失焦时会被拒，只走 Web API = 用户点了复制没反应。
import test from 'node:test';
import assert from 'node:assert/strict';

const {copyTextToClipboard} = await import('../../src/core/clipboard.js');

function installClipboard(impl) {
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {clipboard: {writeText: impl}},
    });
}

test('优先走 Go 绑定：成功时不再碰 Web API', async () => {
    let webCalls = 0;
    installClipboard(async () => {
        webCalls++;
    });
    const calls = [];
    const ok = await copyTextToClipboard('文本', {goCopy: (value) => calls.push(value)});
    assert.equal(ok, true);
    assert.deepEqual(calls, ['文本']);
    assert.equal(webCalls, 0);
});

test('Go 绑定抛错（老版本 / IPC 失败）时退 Web API', async () => {
    const written = [];
    installClipboard(async (value) => written.push(value));
    const ok = await copyTextToClipboard('x', {
        goCopy: () => {
            throw new Error('no binding');
        },
    });
    assert.equal(ok, true);
    assert.deepEqual(written, ['x']);
});

test('没有 Go 绑定时直接走 Web API', async () => {
    const written = [];
    installClipboard(async (value) => written.push(value));
    assert.equal(await copyTextToClipboard('y'), true);
    assert.deepEqual(written, ['y']);
});

test('Web API 拒绝（未聚焦 / 无权限）时返回 false，不抛错', async () => {
    installClipboard(async () => {
        throw new Error('NotAllowedError');
    });
    assert.equal(await copyTextToClipboard('z'), false);
});

test('Web API 缺失（老 WebView）时返回 false', async () => {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {}});
    assert.equal(await copyTextToClipboard('z'), false);
});

test('文本全部失败返回 false；空文本直接 false（不清用户剪贴板）', async () => {
    installClipboard(async () => {
        throw new Error('denied');
    });
    assert.equal(await copyTextToClipboard('', {goCopy: () => {}}), false);
    assert.equal(await copyTextToClipboard(null), false);
    assert.equal(await copyTextToClipboard(0), false); // 0 也按「空」处理，与调用方旧判断一致
});

test('非字符串入参按字符串写入', async () => {
    const written = [];
    installClipboard(async (value) => written.push(value));
    assert.equal(await copyTextToClipboard(42), true);
    assert.deepEqual(written, ['42']);
});
