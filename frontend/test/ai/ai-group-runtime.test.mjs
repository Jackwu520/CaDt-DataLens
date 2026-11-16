// ai-group-runtime.test.mjs：发言路径端到端（假后端）——上下文组装、流事件认领、
// 落盘、超时跳过、上下文门禁、串行互斥、用户插话。
// 真 AI 传输（SSE / 看门狗 / 重试）不在单测面内，靠 G2/G3 手工验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIGroupRuntime} from '../../src/ai/ai-group-runtime.js';

function makeBackend() {
    const groups = new Map();
    const sent = [];
    const stops = [];
    return {
        groups,
        sent,
        stops,
        AIGroupList: async () => [],
        AIGroupRead: async (id) => (groups.get(id) ? groups.get(id).log : ''),
        AIGroupAppend: async (id, lines) => {
            const item = groups.get(id) || {meta: '{}', log: '', priv: {}};
            item.log += lines.endsWith('\n') ? lines : lines + '\n';
            groups.set(id, item);
        },
        AIGroupRewrite: async () => {},
        AIGroupWriteMeta: async (id, data) => {
            const item = groups.get(id) || {meta: '{}', log: '', priv: {}};
            item.meta = data;
            groups.set(id, item);
        },
        AIGroupDelete: async () => {},
        AIGroupDeleteAll: async () => {},
        AIGroupPrivateRead: async (id, agent) => {
            const item = groups.get(id);
            return item && item.priv[agent] ? item.priv[agent] : '';
        },
        AIGroupPrivateAppend: async (id, agent, lines) => {
            const item = groups.get(id) || {meta: '{}', log: '', priv: {}};
            item.priv[agent] = (item.priv[agent] || '') + lines;
            groups.set(id, item);
        },
        AIGroupPrivateRewrite: async () => {},
        AISendChat: async (roundId, cfg, messages, tools, retryMax) => {
            sent.push({roundId, cfg, messages, tools, retryMax});
        },
        AIStop: (id) => stops.push(id),
    };
}

function makeRuntime(backend, overrides = {}) {
    const agents = overrides.agents || [
        {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
        {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p1|m2', personaText: '谨慎', chair: false, enabled: true, slowTier: true},
    ];
    const runtime = createAIGroupRuntime({
        backend,
        getAIConfig: () => ({
            agents,
            profiles: overrides.profiles || [
                {id: 'p1', name: '账号', provider: 'openai', models: [
                    {id: 'm1', model: 'big', contextWindow: overrides.window || 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                    {id: 'm2', model: 'big2', contextWindow: overrides.window || 100000, outputWindow: 4096, reasoningEffort: '', thinking: false},
                ]},
            ],
            retryMax: 2,
            outputLanguage: 'zh',
        }),
        resolveModel: (ref) => {
            const entry = ref.endsWith('m1')
                ? {id: 'm1', model: 'big', contextWindow: overrides.window || 100000, outputWindow: 4096}
                : {id: 'm2', model: 'big2', contextWindow: overrides.window || 100000, outputWindow: 4096};
            return {account: {}, entry, profileCfg: {provider: 'openai', model: entry.model, baseURL: '', apiKey: '', temperature: 0, maxTokens: 4096, proxy: '', extraHeaders: {}, thinking: false, thinkingBudget: 8000, reasoningEffort: '', rpmLimit: 0}, label: entry.model};
        },
        flash: () => {},
        getWorkspace: () => '',
    });
    return {runtime, agents};
}

async function makeGroup(runtime, overrides = {}) {
    const result = await runtime.createGroup({
        title: '评审',
        topic: '存储方案',
        goal: 'decide',
        memberIds: ['a1', 'a2'],
        chair: {kind: 'user'},
        maxRounds: 2,
        timeoutPreset: 'standard',
        ...overrides,
    });
    assert.equal(result.ok, true, '群创建失败：' + (result.error || ''));
    return result.id;
}

// 落盘是异步链（persistSpeech → store.append → saveMeta）；断言前等微任务+定时器排空
async function settle(ms = 40) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

test('创建 → 用户插话 → 指定成员发言（流式）→ 落盘', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend);
    const groupId = await makeGroup(runtime);

    const userResult = await runtime.sendUserMessage(groupId, '讨论一下拆库的利弊');
    assert.equal(userResult.ok, true);
    let g = runtime.groupById(groupId);
    assert.equal(g.messages.length, 1);
    assert.equal(g.messages[0].role, 'user');

    const speak = await runtime.speak(groupId, 'a1', {focus: '回应拆库成本'});
    assert.equal(speak.ok, true, speak.error);
    assert.ok(speak.roundId.startsWith(groupId + '#'));
    // 请求形状：system 在首、user 尾巴收尾；tools 空；焦点进了系统段
    assert.equal(backend.sent.length, 1);
    const req = backend.sent[0];
    assert.equal(req.messages[0].role, 'system');
    assert.match(req.messages[0].content, /<chair_focus>/);
    assert.match(req.messages[0].content, /回应拆库成本/);
    assert.match(req.messages[0].content, /<participants>/);
    assert.equal(req.messages[req.messages.length - 1].role, 'user');
    assert.match(req.messages[req.messages.length - 1].content, /轮到你（架构师）发言/);
    assert.equal(req.tools.length, 0);
    assert.equal(req.retryMax, 2);
    // 用户消息以 [用户] 前缀进对话
    const userTurn = req.messages.find((m) => m.role === 'user' && m.content.includes('拆库的利弊'));
    assert.ok(userTurn);
    assert.match(userTurn.content, /^\[用户\]/);

    // 流事件：chunk → done
    runtime.handleEvent('ai-chunk', {id: speak.roundId, delta: '我'});
    runtime.handleEvent('ai-chunk', {id: speak.roundId, delta: '同意拆库'});
    runtime.handleEvent('ai-think', {id: speak.roundId, delta: '思考'});
    runtime.handleEvent('ai-done', {id: speak.roundId, finishReason: 'stop', usage: {promptTokens: 100, completionTokens: 10, totalTokens: 110}});
    await settle();

    g = runtime.groupById(groupId);
    assert.equal(g.messages.length, 2);
    const msg = g.messages[1];
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.agentName, '架构师');
    assert.equal(msg.content, '我同意拆库');
    assert.equal(msg.status, 'done');
    assert.equal(msg.hasPrivate, true);
    assert.ok(msg.timing.ttftMs >= 0);
    assert.equal(msg.usage.totalTokens, 110);
    // 私有日志落了 thinking
    const priv = await runtime.store.privateRead(groupId, 'a1');
    assert.match(priv, /"kind":"thinking"/);
    // 流结束
    assert.equal(runtime.activeStreamOf(groupId), null);
});

test('超时：等待期内无输出 → AIStop → stopped 归一 timeout', async () => {
    const backend = makeBackend();
    // 极小超时便于单测触发真实计时器
    const {runtime} = makeRuntime(backend);
    const groupId = await makeGroup(runtime, {timeoutPreset: undefined});
    // 手写 meta 超时：绕过 preset（直接改 meta 落盘值）
    const g = runtime.groupById(groupId);
    g.meta.timeouts = {...g.meta.timeouts, memberFirstActivityMs: 30, memberTotalMs: 60, memberThinkingTotalMs: 60};
    const speak = await runtime.speak(groupId, 'a1', {});
    assert.equal(speak.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.ok(backend.stops.includes(speak.roundId), '超时未触发 AIStop');
    runtime.handleEvent('ai-done', {id: speak.roundId, finishReason: 'stopped'});
    await settle();
    const msg = runtime.groupById(groupId).messages.find((m) => m.role === 'assistant');
    assert.equal(msg.status, 'timeout');
    assert.equal(msg.timeout, true);
    assert.equal(runtime.activeStreamOf(groupId), null);
});

test('上下文门禁：共享对话装不下 → 不发请求 + 系统事件', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend, {window: 4096}); // 输出预留后预算极小
    const groupId = await makeGroup(runtime);
    for (let i = 0; i < 5; i++) {
        await runtime.sendUserMessage(groupId, '长'.repeat(2000));
    }
    const speak = await runtime.speak(groupId, 'a1', {});
    assert.equal(speak.ok, false);
    assert.match(speak.error, /上下文不足/);
    assert.equal(backend.sent.length, 0);
    const g = runtime.groupById(groupId);
    const overflowEvent = g.events.find((e) => e.type === 'context-overflow');
    assert.ok(overflowEvent);
});

test('串行互斥：发言中不能再次发言；停止走群级前缀', async () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend);
    const groupId = await makeGroup(runtime);
    const speak = await runtime.speak(groupId, 'a1', {});
    assert.equal(speak.ok, true);
    const second = await runtime.speak(groupId, 'a2', {});
    assert.equal(second.ok, false);
    assert.match(second.error, /正在发言/);
    runtime.stopAll(groupId);
    assert.ok(backend.stops.includes(groupId), '群级停止应使用裸 groupId（前缀匹配）');
    runtime.handleEvent('ai-error', {id: speak.roundId, message: '网络中断'});
    await settle();
    const msg = runtime.groupById(groupId).messages.find((m) => m.role === 'assistant');
    assert.equal(msg.status, 'error');
    assert.match(msg.error, /网络中断/);
});

test('未知 roundId 的事件被忽略（不污染面板路由）', () => {
    const backend = makeBackend();
    const {runtime} = makeRuntime(backend);
    runtime.handleEvent('ai-chunk', {id: 'session-other#round-1', delta: 'x'});
    assert.equal(backend.sent.length, 0);
});

