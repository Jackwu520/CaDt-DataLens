// 插件后台服务注册表护栏（cadt.registerService）：注册 → 规范化 → buildServiceSpecs →
// 插件重载清空 → 非法注册报错 → 服务操作转发 backend。进程真正启停在 Go 侧，
// 本模块只管声明与转发，测试锁住这层契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bindServiceBackend, buildServiceSpecs, clearPluginServices, getPluginServices,
    registerPluginService, serviceLogs, serviceStatus, startService, stopService,
} from '../../src/shell/plugin-services.js';

const backend = (calls) => ({
    AppServiceStart: async (id) => calls.push(['start', id]),
    AppServiceStop: async (id) => calls.push(['stop', id]),
    AppServiceStatus: async (id) => ({id, state: 'running', pid: 1}),
    AppServiceLogs: async (id) => ['log-' + id],
});

test('服务注册：规范化 cwd/默认值 + 全局 id 拼接', () => {
    clearPluginServices();
    const rec = registerPluginService('myplugin', 'D:/plugins/myplugin', {
        id: 'server', exe: 'python', args: ['main.py', 'serve'],
    });
    assert.equal(rec.fullId, 'myplugin-server');
    assert.equal(rec.spec.cwd, 'D:/plugins/myplugin', 'cwd 为空回退插件目录');
    assert.equal(rec.spec.autoStart, false);
    assert.equal(rec.spec.pollIntervalMs, 3000);
    assert.equal(rec.spec.logCapBytes, 262144);
    assert.equal(rec.spec.healthURL, '');
    assert.equal(getPluginServices().length, 1);
});

test('服务注册：相对 cwd 以插件目录为基准', () => {
    clearPluginServices();
    const rec = registerPluginService('p', 'D:/plugins/p', {id: 's', exe: 'python', cwd: 'server'});
    assert.equal(rec.spec.cwd, 'D:/plugins/p/server');
});

test('服务注册：非法声明报错', () => {
    clearPluginServices();
    assert.throws(() => registerPluginService('p', 'd', {id: 'BAD', exe: 'x'}), /id 无效/);
    assert.throws(() => registerPluginService('p', 'd', {id: 's'}), /缺少 exe/);
    assert.throws(() => registerPluginService('p', 'd', {id: 's', exe: 'x', healthURL: 'ftp://x'}), /healthURL/);
    assert.equal(getPluginServices().length, 0);
});

test('服务注册：重复 id 报错 + 重载清空', () => {
    clearPluginServices();
    registerPluginService('p', 'd', {id: 's', exe: 'x'});
    assert.throws(() => registerPluginService('p', 'd', {id: 's', exe: 'y'}), /已注册/);
    clearPluginServices();
    assert.equal(getPluginServices().length, 0);
});

test('buildServiceSpecs：id 换成全局 id，字段透传', () => {
    clearPluginServices();
    registerPluginService('p', 'D:/p', {id: 's', exe: 'python', args: ['a'], autoStart: true, healthURL: 'http://x'});
    const specs = buildServiceSpecs();
    assert.equal(specs.length, 1);
    assert.equal(specs[0].id, 'p-s');
    assert.equal(specs[0].autoStart, true);
    assert.equal(specs[0].healthURL, 'http://x');
    assert.deepEqual(specs[0].args, ['a']);
});

test('服务操作：按插件内短 id 转发到 backend 全局 id', async () => {
    clearPluginServices();
    const calls = [];
    bindServiceBackend(backend(calls));
    registerPluginService('p', 'd', {id: 's', exe: 'x'});
    await startService('p', 's');
    await stopService('p', 's');
    assert.deepEqual(calls, [['start', 'p-s'], ['stop', 'p-s']]);
    const st = await serviceStatus('p', 's');
    assert.equal(st.id, 'p-s');
    assert.equal(st.state, 'running');
    assert.deepEqual(await serviceLogs('p', 's'), ['log-p-s']);
    // 未注册的短 id 应 reject
    await assert.rejects(() => startService('p', 'missing'), /未注册/);
});

test('服务操作：未绑定 backend 时 reject', async () => {
    clearPluginServices();
    bindServiceBackend(null);
    registerPluginService('p', 'd', {id: 's', exe: 'x'});
    await assert.rejects(() => startService('p', 's'), /不支持/);
});
