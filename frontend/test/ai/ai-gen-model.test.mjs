// ai-gen-model.test.mjs：生图/视频模型数据层护栏（归一化、模板渲染、提取路径、预设表形状）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultGenModelOf,
    extractGenPath,
    genExtFor,
    genModelByRef,
    GEN_MODEL_PRESETS,
    GEN_PLACEHOLDERS,
    isAsyncGenModel,
    mergeGenModelEntry,
    moveGenModelWithinKind,
    normalizeGenHeaders,
    normalizeGenModel,
    normalizeGenModels,
    renderGenJson,
    renderGenText,
} from '../../src/ai/ai-gen-model.js';

test('normalizeGenModel：缺省值与 clamp，kind 非法回落 image', () => {
    const entry = normalizeGenModel({id: 'g1', name: '  测试  '}, () => 'gen-x');
    assert.equal(entry.id, 'g1');
    assert.equal(entry.name, '测试');
    assert.equal(entry.kind, 'image');
    assert.equal(entry.enabled, true);
    assert.equal(entry.proxy, 'system');
    assert.equal(entry.timeoutSec, 120);
    assert.equal(entry.resultType, 'b64');
    assert.equal(entry.defaultN, 1);
    assert.deepEqual(entry.headers, []);
    const weird = normalizeGenModel({kind: 'audio', timeoutSec: 1, defaultN: 99, resultType: 'blob', pollIntervalSec: 0, maxPolls: 9999});
    assert.equal(weird.kind, 'image', '非法 kind 回落 image');
    assert.equal(weird.timeoutSec, 30);
    assert.equal(weird.defaultN, 4);
    assert.equal(weird.resultType, 'b64');
    assert.equal(weird.pollIntervalSec, 2);
    assert.equal(weird.maxPolls, 240);
    assert.equal(normalizeGenModel(null, () => 'gen-y').id, 'gen-y', '空输入用 idGen 兜底');
});

test('normalizeGenHeaders：数组 / 对象 / 行文本三种形态，去重去空键剥换行', () => {
    assert.deepEqual(normalizeGenHeaders([{key: 'Authorization', value: 'Bearer {{apiKey}}'}]),
        [{key: 'Authorization', value: 'Bearer {{apiKey}}'}]);
    assert.deepEqual(normalizeGenHeaders({'X-A': '1', 'X-B': '2'}),
        [{key: 'X-A', value: '1'}, {key: 'X-B', value: '2'}]);
    assert.deepEqual(normalizeGenHeaders('X-A: 1\nX-B : 2\nX-A: 3\n: bad'),
        [{key: 'X-A', value: '1'}, {key: 'X-B', value: '2'}], '行文本解析，重名去重，空键丢弃');
    assert.equal(normalizeGenHeaders([{key: 'X-C\r\nX-D', value: 'a\nb'}])[0].key, 'X-CX-D', '键值剥换行（防头注入）');
});

test('normalizeGenModels：按 id 去重、过滤无效项、空输入给空数组', () => {
    assert.deepEqual(normalizeGenModels(null), []);
    assert.deepEqual(normalizeGenModels('x'), []);
    const list = normalizeGenModels([
        {id: 'a', name: '甲'},
        'junk',
        {id: 'a', name: '乙'},
        {id: 'b', kind: 'video'},
    ], () => 'gen-1');
    assert.equal(list.length, 2);
    assert.equal(list[0].name, '甲', '重复 id 后到者让位');
    assert.equal(list[1].kind, 'video');
});

test('defaultGenModelOf / genModelByRef：id 或名称精确匹配、类型与启用过滤、空 ref 回缺省', () => {
    const list = [
        {id: 'g1', name: 'Kolors', kind: 'image', enabled: true},
        {id: 'g2', name: 'Wan', kind: 'video', enabled: true},
        {id: 'g3', name: '停用', kind: 'image', enabled: false},
    ];
    assert.equal(defaultGenModelOf(list, 'image').id, 'g1');
    assert.equal(defaultGenModelOf(list, 'video').id, 'g2');
    assert.equal(defaultGenModelOf([{id: 'g3', kind: 'image', enabled: false}], 'image'), null, '全停用给 null');
    assert.equal(genModelByRef(list, 'image', 'kolors').id, 'g1', '名称大小写不敏感');
    assert.equal(genModelByRef(list, 'image', 'g1').id, 'g1');
    assert.equal(genModelByRef(list, 'video', 'Kolors'), null, '类型不匹配不命中');
    assert.equal(genModelByRef(list, 'image', '不存在'), null, 'ref 没命中返回 null（调用方报错，不静默回落）');
    assert.equal(genModelByRef(list, 'image', '停用'), null, '停用条目不命中，也不回落');
    assert.equal(genModelByRef(list, 'image', '').id, 'g1', '空 ref 回缺省');
});

test('moveGenModelWithinKind：只在同类型槽位内换人，跨类型位置不动，边界原样返回', () => {
    const list = [
        {id: 'a', kind: 'image'},
        {id: 'v1', kind: 'video'},
        {id: 'b', kind: 'image'},
        {id: 'v2', kind: 'video'},
        {id: 'c', kind: 'image'},
    ];
    // a 下移：与 b 交换槽位，v1 仍在原位（夹在中间不动）
    const down = moveGenModelWithinKind(list, 'a', 1);
    assert.deepEqual(down.map((e) => e.id), ['b', 'v1', 'a', 'v2', 'c']);
    // c 上移一位：与 b 交换，v2 不动
    assert.deepEqual(moveGenModelWithinKind(list, 'c', -1).map((e) => e.id), ['a', 'v1', 'c', 'v2', 'b']);
    // 视频组内独立排序：v2 上移到 v1 之前，生图条目位置全不变
    assert.deepEqual(moveGenModelWithinKind(list, 'v2', -1).map((e) => e.id), ['a', 'v2', 'b', 'v1', 'c']);
    // 边界 / 无效输入：返回原引用（调用方据此跳过落盘）
    assert.equal(moveGenModelWithinKind(list, 'a', -1), list, '组首上移');
    assert.equal(moveGenModelWithinKind(list, 'c', 1), list, '组尾下移');
    assert.equal(moveGenModelWithinKind(list, 'nope', 1), list, '找不到条目');
    assert.equal(moveGenModelWithinKind(list, 'a', 0), list, 'delta 为 0');
    const empty = [];
    assert.equal(moveGenModelWithinKind(empty, 'a', 1), empty);
    assert.deepEqual(moveGenModelWithinKind(null, 'a', 1), []);
    // 不修改入参
    assert.deepEqual(list.map((e) => e.id), ['a', 'v1', 'b', 'v2', 'c']);
});

test('moveGenModelWithinKind + defaultGenModelOf：组内顺序即缺省优先级', () => {
    const list = [
        {id: 'a', kind: 'image', enabled: false},
        {id: 'b', kind: 'image', enabled: true},
        {id: 'v', kind: 'video', enabled: true},
    ];
    assert.equal(defaultGenModelOf(list, 'image').id, 'b', '停用条目不占优先级，取第一个启用的');
    const moved = moveGenModelWithinKind(list, 'b', -1);
    assert.deepEqual(moved.map((e) => e.id), ['b', 'a', 'v']);
    assert.equal(defaultGenModelOf(moved, 'image').id, 'b');
});

test('isAsyncGenModel：submit/jobId/pollPath 三者齐备才算异步型', () => {
    assert.equal(isAsyncGenModel({submitPath: '/submit', jobIdPath: 'id', pollPath: '/poll?id={{jobId}}'}), true);
    assert.equal(isAsyncGenModel({submitPath: '/submit'}), false);
    assert.equal(isAsyncGenModel({}), false);
    assert.equal(isAsyncGenModel(null), false);
});

test('renderGenJson：占位符渲染为 JSON 字面量，prompt 注入安全，未知占位符抛错', () => {
    assert.equal(renderGenJson('{"model":{{model}},"prompt":{{prompt}},"n":{{n}}}',
        {model: 'Kolors', prompt: '他说"你好"\n第二行', n: 2}),
        '{"model":"Kolors","prompt":"他说\\"你好\\"\\n第二行","n":2}');
    assert.equal(renderGenJson('{"size":{{size}}}', {}), '{"size":null}', '缺参渲染 null');
    assert.equal(renderGenJson('{{prompt}}-{{prompt}}', {prompt: 'x'}), '"x"-"x"', '同占位符可多次出现');
    assert.equal(renderGenJson('{"seed":{{seed}}}', {seed: 0}), '{"seed":0}', '0 是合法字面量');
    assert.throws(() => renderGenJson('{{evil}}', {}), /未知占位符/);
    assert.throws(() => renderGenJson('   ', {}), /模板为空/);
    assert.deepEqual(GEN_PLACEHOLDERS.includes('prompt') && GEN_PLACEHOLDERS.includes('jobId'), true);
});

test('renderGenText：纯文本替换（headers / 轮询 URL），缺参留空', () => {
    assert.equal(renderGenText('Bearer {{apiKey}}', {apiKey: 'sk-1'}), 'Bearer sk-1');
    assert.equal(renderGenText('/poll?id={{jobId}}', {jobId: 't-9'}), '/poll?id=t-9');
    assert.equal(renderGenText('Bearer {{apiKey}}', {}), 'Bearer ', '缺参留空（不带引号）');
    assert.throws(() => renderGenText('{{nope}}', {}), /未知占位符/);
});

test('extractGenPath：点路径 / 下标 / [*] 多值 / 走不通给空数组 / 语法错抛错', () => {
    const data = {data: [{b64_json: 'AAA', url: 'u1'}, {b64_json: 'BBB', url: 'u2'}], error: {message: 'bad'}};
    assert.deepEqual(extractGenPath(data, 'data[0].b64_json'), ['AAA']);
    assert.deepEqual(extractGenPath(data, 'data[*].url'), ['u1', 'u2']);
    assert.deepEqual(extractGenPath(data, 'error.message'), ['bad']);
    assert.deepEqual(extractGenPath(data, 'data[*].b64_json'), ['AAA', 'BBB']);
    assert.deepEqual(extractGenPath(data, ''), [data], '空路径返回整个值');
    assert.deepEqual(extractGenPath(data, 'data[9].url'), [], '越界给空数组');
    assert.deepEqual(extractGenPath(data, 'nope.deep'), []);
    assert.deepEqual(extractGenPath(data, 'data[*].missing'), []);
    assert.deepEqual(extractGenPath({list: [{v: 1}, {v: 2}]}, 'list[*].v'), [1, 2], '[*] 后继续取字段');
    assert.deepEqual(extractGenPath('plain', 'x'), [], '标量上取字段给空数组');
    assert.throws(() => extractGenPath(data, 'a..b'), /语法无效/);
    assert.throws(() => extractGenPath(data, 'a[x]'), /语法无效/);
});

test('genExtFor：已知 mime 直接映射，未知按产物类型兜底', () => {
    assert.equal(genExtFor('image/png', 'image'), 'png');
    assert.equal(genExtFor('image/jpeg', 'image'), 'jpg');
    assert.equal(genExtFor('video/mp4', 'video'), 'mp4');
    assert.equal(genExtFor('application/octet-stream', 'image'), 'png');
    assert.equal(genExtFor('', 'video'), 'mp4');
});

test('GEN_MODEL_PRESETS：预设条目可归一，模板渲染通过（预设即配置的自检）', () => {
    assert.ok(GEN_MODEL_PRESETS.length >= 3);
    const keys = new Set(GEN_MODEL_PRESETS.map((preset) => preset.key));
    assert.equal(keys.has('openai-b64') && keys.has('openai-url') && keys.has('custom'), true);
    for (const preset of GEN_MODEL_PRESETS) {
        const entry = normalizeGenModel(preset.entry, () => 'gen-p');
        assert.equal(entry.kind, preset.kind);
        // 预设的请求体模板必须能用合法参数渲染出来（占位符拼写自检）
        const body = renderGenJson(entry.bodyTemplate, {
            prompt: '测试', model: entry.defaultModel || 'm', size: entry.defaultSize || '1024x1024', n: 1,
        });
        assert.equal(typeof body, 'string');
        // 预设的提取路径必须能走通语法（用占位响应验证）
        if (entry.resultPath) {
            const sample = entry.resultType === 'b64'
                ? {data: [{b64_json: 'QQ=='}]}
                : {data: [{url: 'https://example.com/a.png'}]};
            assert.equal(extractGenPath(sample, entry.resultPath).length, 1, preset.key + ' 的 resultPath 走得通');
        }
    }
});

test('mergeGenModelEntry：AI 来源合并——字段覆盖，apiKey 只取 existing，命中沿用其 id', () => {
    const existing = {
        id: 'gen-1', name: 'sensenova-u1.5-lite', kind: 'image', enabled: true,
        baseURL: 'https://old.example.com', path: '/v1/images/generations',
        apiKey: 'sk-user-secret', defaultSize: '1024x1024',
    };
    const merged = mergeGenModelEntry(existing, {
        name: 'sensenova-u1.5-lite', kind: 'image',
        baseURL: 'https://token.sensenova.cn', path: '/v1/images/generations',
        defaultSize: '2048x2048',
        // AI 试图塞密钥——必须被丢弃
        apiKey: 'sk-from-ai',
    }, () => 'gen-new');
    assert.equal(merged.id, 'gen-1', '命中已有条目沿用其 id');
    assert.equal(merged.baseURL, 'https://token.sensenova.cn', '其余字段被 incoming 覆盖');
    assert.equal(merged.defaultSize, '2048x2048');
    assert.equal(merged.apiKey, 'sk-user-secret', '密钥只取 existing：AI 写不进也冲不掉');
    // 新建：密钥留空，id 由 idGen 生成
    const fresh = mergeGenModelEntry(null, {name: 'new-entry', kind: 'video'}, () => 'gen-new2');
    assert.equal(fresh.id, 'gen-new2');
    assert.equal(fresh.apiKey, '', '新建条目密钥留空给用户');
    assert.equal(fresh.kind, 'video');
    // incoming 非对象的兜底
    const junk = mergeGenModelEntry(existing, 'junk', () => 'gen-new3');
    assert.equal(junk.apiKey, 'sk-user-secret');
    assert.equal(junk.baseURL, 'https://old.example.com', '坏 incoming 不冲掉已有配置');
});
