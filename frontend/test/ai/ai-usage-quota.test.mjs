// ai-usage-quota.test.mjs —— 额度查询管线的纯函数护栏（沙箱脚本本体在 node 无 Worker，
// 只锁字符串形态与禁用表；result 归一化 / 节流 / 展示格式化 / 快照层全量覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildUsageSpec,
    buildUsageWorkerScript,
    createAIUsageQuota,
    formatUsageAge,
    formatUsageAmount,
    formatUsageHeadline,
    normalizeUsageResult,
    officialSnapshotFromResult,
    usageItemText,
    usageStale,
} from '../../src/ai/ai-usage-quota.js';
import {normalizeUsageConfig} from '../../src/ai/ai-config-model.js';

// node 没有 Worker：注入假件走同一消息协议（run → request / response → result），
// 在测试进程里 new Function 解析脚本——只验管线编排，沙箱隔离本身在 WebView 里人工验收。
function fakeWorkerFactory() {
    return () => {
        let cfg = null;
        const listeners = new Set();
        const emit = (data) => {
            for (const fn of [...listeners]) fn({data});
        };
        return {
            addEventListener(type, fn) {
                if (type === 'message') listeners.add(fn);
            },
            removeEventListener(type, fn) {
                listeners.delete(fn);
            },
            postMessage(msg) {
                queueMicrotask(() => {
                    try {
                        if (msg.type === 'run') {
                            cfg = new Function('return (' + msg.code + ')')();
                            const req = cfg.request;
                            emit({type: 'request', request: {
                                url: String(req.url), method: String(req.method || 'GET'),
                                headers: req.headers || {}, body: '',
                            }});
                        } else if (msg.type === 'response') {
                            let parsed;
                            try { parsed = JSON.parse(msg.response.body); } catch (_) { parsed = msg.response.body; }
                            emit({type: 'result', raw: cfg.extractor(parsed)});
                        }
                    } catch (err) {
                        emit({type: 'error', error: String((err && err.message) || err)});
                    }
                });
            },
            terminate() {},
        };
    };
}

test('normalizeUsageResult：对象折成单条、数组多套餐、缺数值判失败', () => {
    const single = normalizeUsageResult({remaining: 12.5, unit: 'USD'});
    assert.equal(single.error, '');
    assert.equal(single.items.length, 1);
    assert.equal(single.items[0].remaining, 12.5);
    assert.equal(single.items[0].isValid, true);

    const multi = normalizeUsageResult([
        {remaining: 1, unit: 'USD', planName: 'a'},
        {used: 30, unit: '%', planName: 'b'},
        {isValid: false, invalidMessage: '已过期', unit: 'USD'},
    ]);
    assert.equal(multi.items.length, 3);
    assert.equal(multi.items[2].isValid, false);
    assert.equal(multi.items[2].invalidMessage, '已过期');
    // isValid=false 时允许没有数值
    assert.equal(multi.error, '');

    const bad = normalizeUsageResult({foo: 1});
    assert.equal(bad.items.length, 0);
    assert.match(bad.error, /remaining\/total\/used/);

    assert.match(normalizeUsageResult([]).error, /没有返回结果/);
    assert.match(normalizeUsageResult('str').error, /必须是对象/);
    // 非数值 NaN 被剔除后等于缺字段
    assert.match(normalizeUsageResult({remaining: 'abc'}).error, /remaining\/total\/used/);
    // 字符串字段限长 200：恶意 extractor 的超长串不进快照
    const capped = normalizeUsageResult({remaining: 1, unit: 'x'.repeat(500), extra: 'y'.repeat(500)});
    assert.equal(capped.items[0].unit.length, 200);
    assert.equal(capped.items[0].extra.length, 200);
});

test('normalizeUsageResult：截断超量条目', () => {
    const many = [];
    for (let i = 0; i < 20; i++) many.push({remaining: i, unit: 'USD'});
    const out = normalizeUsageResult(many);
    assert.ok(out.items.length <= 10);
});

test('officialSnapshotFromResult：引擎三态折成 snapshot', () => {
    const ok = officialSnapshotFromResult({
        supported: true,
        items: [{label: '总额余额（CNY）', value: '49.05'}],
    });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.items[0].label, '总额余额（CNY）');
    assert.equal(ok.items[0].value, '49.05');

    const unsupported = officialSnapshotFromResult({supported: false});
    assert.equal(unsupported.state, 'error');
    assert.match(unsupported.error, /白名单/);

    const errored = officialSnapshotFromResult({supported: true, error: 'HTTP 401'});
    assert.equal(errored.error, 'HTTP 401');

    assert.equal(officialSnapshotFromResult(null).state, 'error');
});

test('Worker 沙箱脚本：禁用表覆盖实例与原型链两层，消息协议齐备', () => {
    const script = buildUsageWorkerScript();
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'open', 'caches', 'sendBeacon']) {
        assert.ok(script.includes("'" + name + "'"), '禁用表缺 ' + name);
    }
    // 只在 globalThis 遮挡会被 Object.getPrototypeOf(self).fetch 绕过（WebIDL 属性
    // 定义在 WorkerGlobalScope.prototype 上）——必须对原型链 delete（2026-11-19 审查实锤）
    assert.ok(script.includes('delete proto[name]'), 'prelude 缺原型链删除');
    assert.ok(script.includes('Object.getPrototypeOf(self)'), 'prelude 缺原型链处理');
    assert.ok(script.includes('Object.getPrototypeOf(navigator)'), 'prelude 缺 navigator.sendBeacon 原型链清理');
    assert.ok(script.includes("data.type === 'run'"));
    assert.ok(script.includes("data.type === 'response'"));
    assert.ok(script.includes("type: 'request'"));
    assert.ok(script.includes("type: 'result'"));
    assert.ok(script.includes('http(s)://'), '缺 URL scheme 校验');
    // 结果经 JSON 序列化过滤，函数/循环引用进不了主线程
    assert.ok(script.includes('JSON.parse(JSON.stringify(raw))'));
});

test('buildUsageSpec：字段名对齐 aigen.HTTPSpec，超时钳位', () => {
    const spec = buildUsageSpec(
        {url: 'https://x/y', method: 'get', headers: {a: '1'}, body: 'b'},
        {proxy: 'socks5://1.2.3.4'},
        {timeoutSec: 999},
    );
    assert.equal(spec.url, 'https://x/y');
    assert.equal(spec.method, 'get');
    assert.equal(spec.proxy, 'socks5://1.2.3.4');
    assert.equal(spec.maxBytes, 262144);
    assert.ok(spec.timeoutSec >= 3 && spec.timeoutSec <= 60);
});

test('usageStale：0 间隔只认无缓存，有间隔按时间窗', () => {
    const fresh = {state: 'ok', items: [], at: Date.now() - 1000};
    assert.equal(usageStale(null, 0), true);
    assert.equal(usageStale(fresh, 0), false);
    assert.equal(usageStale(fresh, 5), false);
    assert.equal(usageStale({state: 'ok', items: [], at: Date.now() - 3600000}, 5), true);
});

test('展示格式化：∞ / 两位小数 / 主句 / 多套餐报数 / 失败态', () => {
    assert.equal(formatUsageAmount(-1, 'USD'), '∞');
    assert.equal(formatUsageAmount(3, 'USD'), '3.00 USD');
    assert.equal(formatUsageAmount(34.5555, '%'), '34.56%');

    assert.equal(usageItemText({remaining: 12.5, unit: 'CNY'}), '余额 12.50 CNY');
    assert.equal(usageItemText({planName: '5 小时', used: 30, unit: '%'}), '5 小时 已用 30.00%');
    assert.equal(usageItemText({isValid: false, invalidMessage: 'Key 无效'}), 'Key 无效');
    assert.equal(usageItemText({label: '剩余', value: '$3.20'}), '剩余 $3.20');

    const head = formatUsageHeadline({
        state: 'ok',
        items: [
            {label: '总额余额（CNY）', value: '49.05', isValid: true},
            {label: '账户可用', value: '是', isValid: true},
        ],
    });
    assert.equal(head, '总额余额（CNY） 49.05');

    assert.equal(formatUsageHeadline({state: 'ok', items: [{planName: '每周', used: 40, unit: '%'}]}), '每周 已用 40.00%');
    assert.match(formatUsageHeadline({state: 'ok', items: [{remaining: 1, unit: 'USD'}, {remaining: 2, unit: 'USD'}]}), /2 个套餐/);
    assert.equal(formatUsageHeadline({state: 'error', error: 'HTTP 401'}), 'HTTP 401');
    assert.equal(formatUsageHeadline(null), '');
    // 只剩「账户可用」一行时照常显示（没有更有信息量的行可挑）
    assert.equal(
        formatUsageHeadline({state: 'ok', items: [{label: '账户可用', value: '是', isValid: true}]}),
        '账户可用 是',
    );
});

test('formatUsageAge：分钟/小时分档', () => {
    const now = Date.now();
    assert.equal(formatUsageAge(now - 30000, now), '刚刚查询');
    assert.equal(formatUsageAge(now - 120000, now), '2 分钟前查询');
    assert.equal(formatUsageAge(now - 7200000, now), '2 小时前查询');
    assert.equal(formatUsageAge(now - 172800000, now), '2 天前查询');
    assert.equal(formatUsageAge(0), '');
});

test('createAIUsageQuota：查询写缓存、失败是快照不抛错、测试通道不写缓存', async () => {
    let httpCalls = 0;
    const quota = createAIUsageQuota({
        workerFactory: fakeWorkerFactory(),
        backend: () => ({
            async AIUsageHTTPRequest(specJSON) {
                httpCalls++;
                return {status: 200, contentType: 'application/json', body: JSON.stringify({balance: 5.5}), bytes: 20};
            },
        }),
    });
    const profile = {
        id: 'p1',
        name: '通用站',
        baseURL: 'https://relay.example.com/v1',
        apiKey: 'sk-x',
        usage: normalizeUsageConfig({enabled: true, template: 'general'}),
    };
    const first = await quota.queryAccountUsage(profile, {force: true});
    assert.equal(first.state, 'ok', first.error);
    assert.equal(first.items[0].remaining, 5.5);
    // 缓存生效：同账号再查（未 force）不打后端
    await quota.queryAccountUsage(profile);
    assert.equal(httpCalls, 1);
    assert.equal(quota.peek('p1').state, 'ok');

    // 测试通道：不写缓存
    const testOut = await quota.testConfig(profile, {enabled: true, template: 'general'});
    assert.equal(testOut.state, 'ok');
    assert.equal(httpCalls, 2);
    assert.equal(quota.peek('p1').at, first.at);

    // 失败也是快照
    const bad = createAIUsageQuota({
        workerFactory: fakeWorkerFactory(),
        backend: () => ({async AIUsageHTTPRequest() { throw new Error('net down'); }}),
    });
    const snap = await bad.queryAccountUsage({...profile, id: 'p2'}, {force: true});
    assert.equal(snap.state, 'error');
    assert.match(snap.error, /net down/);
});

test('createAIUsageQuota：官方模板走 AIUsageQuery，白名单外不自动查询', async () => {
    let officialCalls = 0;
    const quota = createAIUsageQuota({
        backend: () => ({
            async AIUsageQuery() {
                officialCalls++;
                return {supported: true, provider: 'DeepSeek', items: [{label: '总额余额（CNY）', value: '10'}]};
            },
        }),
    });
    const offProfile = {
        id: 'off',
        name: 'DeepSeek',
        baseURL: 'https://api.deepseek.com/v1',
        usage: normalizeUsageConfig({enabled: true, template: 'official'}),
    };
    const snapshot = await quota.queryAccountUsage(offProfile, {force: true});
    assert.equal(snapshot.state, 'ok');
    assert.equal(officialCalls, 1);
    assert.equal(snapshot.items[0].label, '总额余额（CNY）');

    // 白名单外的官方模板：sweep 不触发查询
    const relayProfile = {
        id: 'relay',
        name: '中转',
        baseURL: 'https://relay.example.com',
        usage: normalizeUsageConfig({enabled: true, template: 'official'}),
    };
    let changed = false;
    quota.sweep([relayProfile], () => { changed = true; });
    assert.equal(changed, false);
    assert.equal(officialCalls, 1);
});

test('createAIUsageQuota：invalidate 清内存与快照存储', async () => {
    const quota = createAIUsageQuota({
        workerFactory: fakeWorkerFactory(),
        backend: () => ({async AIUsageHTTPRequest() { return {status: 200, body: '{"balance":1}', bytes: 12}; }}),
    });
    const profile = {
        id: 'p3',
        baseURL: 'https://x.example.com',
        usage: normalizeUsageConfig({enabled: true, template: 'general'}),
    };
    await quota.queryAccountUsage(profile, {force: true});
    assert.ok(quota.peek('p3'));
    quota.invalidate('p3');
    assert.equal(quota.peek('p3'), null);
});

test('normalizeUsageConfig：坏值回落、extraFields 键限标识符、enabled 显式 true', () => {
    const cfg = normalizeUsageConfig({
        enabled: 1, // 非 true 布尔 → 关
        template: 'hacker',
        planProvider: 'nope',
        code: 42,
        extraFields: {'ok-key': 'v', good: 'kept', bad2: 'x', '9x': 'no', toomuch: undefined},
        timeoutSec: -5,
        autoIntervalMin: 99999,
    });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.template, 'official');
    assert.equal(cfg.planProvider, 'kimi');
    assert.equal(cfg.code, '');
    // 合法标识符键保留（bad2 是合法名），带连字符 / 数字开头 / 空值丢弃
    assert.deepEqual(cfg.extraFields, {good: 'kept', bad2: 'x'});
    assert.equal(cfg.timeoutSec, 5);
    assert.equal(cfg.autoIntervalMin, 1440);
    assert.equal(normalizeUsageConfig(null).enabled, false);
    assert.equal(normalizeUsageConfig({enabled: true}).autoIntervalMin, 5);
});
