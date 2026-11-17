// ai-agent-model.test.mjs：智能体数据层护栏——名字校验（空白/@/保留词/重名）、归一化
// 去重与上限、增删改 roundtrip、modelRef 失效、能力快照与 slowTier 超时档。
// 方案 docs/unfinished-plans/ai-group-chat.md §6.1 / §16.12。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AGENT_MAX_COUNT,
    AGENT_RESERVED_NAMES,
    agentById,
    agentCapability,
    agentNameError,
    agentThinkingTier,
    agentsRemove,
    agentsUpsert,
    listModelOptions,
    normalizeAgentName,
    normalizeAgents,
    resolveAgentModel,
    resolveModelByKeyword,
} from '../../src/ai/ai-agent-model.js';

const profiles = [
    {
        id: 'p1', name: '账号一', provider: 'openai', baseURL: '', apiKey: '',
        models: [
            {id: 'm1', model: 'gpt-x', contextWindow: 1048576, outputWindow: 8192, reasoningEffort: '', thinking: false, thinkingBudget: 8000, rpm: 0},
            {id: 'm2', model: 'o-x', contextWindow: 262144, outputWindow: 4096, reasoningEffort: 'medium', thinking: false, thinkingBudget: 8000, rpm: 0},
        ],
    },
    {
        id: 'p2', name: '账号二', provider: 'anthropic', models: [
            {id: 'm1', model: 'claude-x', contextWindow: 200000, outputWindow: 8192, reasoningEffort: '', thinking: true, thinkingBudget: 8000, rpm: 0},
        ],
    },
];

function baseList() {
    return normalizeAgents([
        {id: 'a1', name: '架构师', modelRef: 'p1|m1'},
        {id: 'a2', name: '审查员', modelRef: 'p2|m1', chair: true},
    ], () => 'gen-id');
}

test('名字校验：空/超长/空白/@/保留词/重名', () => {
    const agents = baseList();
    assert.equal(agentNameError('', agents, ''), '名字不能为空');
    assert.equal(agentNameError('x'.repeat(33), agents, ''), '名字不能超过 32 字符');
    assert.match(agentNameError('有 空格', agents, ''), /空白/);
    assert.match(agentNameError('tab\t名', agents, ''), /空白/);
    assert.match(agentNameError('@某人', agents, ''), /@/);
    for (const word of AGENT_RESERVED_NAMES) {
        assert.match(agentNameError(word, agents, ''), /保留名/);
    }
    assert.match(agentNameError('ALL', agents, ''), /保留名/);
    assert.match(agentNameError('架构师', agents, ''), /重名/);
    assert.match(agentNameError('jiagoushi', agents, ''), /^$/);
    // 排除自己后不算重名（编辑不改名场景）
    assert.equal(agentNameError('架构师', agents, 'a1'), '');
});

test('名字归一：NFC 与小写折叠', () => {
    assert.equal(normalizeAgentName('  ＡＢ  '), 'ＡＢ'); // trim 但保留全角
    const agents = baseList();
    assert.equal(agentNameError('架构师', agents, ''), '名字与现有智能体重名');
});

test('normalizeAgents：丢弃无效项、去重 id 与名字、数量截断', () => {
    const list = normalizeAgents([
        null,
        {name: '甲', modelRef: 'p1|m1'},
        {name: '乙', id: 'same', modelRef: 'p1|m1'},
        {name: '丙', id: 'same', modelRef: 'p1|m1'},
        {name: '甲', modelRef: 'p1|m1'},
        {role: '无名字但含 role'},
    ], () => 'gen-x');
    assert.equal(list.length, 4);
    assert.equal(list[0].name, '甲');
    assert.notEqual(list[1].id, list[2].id); // id 冲突加后缀（乙/丙同为 'same'）
    assert.equal(list[3].name, '甲-2'); // 名字冲突加后缀
    assert.equal(list[0].color, 'violet'); // index 兜底色（raw 下标从 0 计）
    // 上限截断
    const many = normalizeAgents(Array.from({length: AGENT_MAX_COUNT + 5}, (_, i) => ({name: 'n' + i})), () => 'g');
    assert.equal(many.length, AGENT_MAX_COUNT);
});

test('normalizeAgent 字段 clamp：温度/人设长度/非法风格回退', () => {
    const list = normalizeAgents([{name: '甲', temperature: 9, personaText: '长'.repeat(5000), replyStyle: 'nope', enabled: false}], () => 'g');
    const agent = list[0];
    assert.equal(agent.temperature, 2);
    assert.equal(agent.personaText.length, 4096);
    assert.equal(agent.replyStyle, 'default');
    assert.equal(agent.enabled, false);
    const nullTemp = normalizeAgents([{name: '乙', temperature: ''}], () => 'g')[0];
    assert.equal(nullTemp.temperature, null);
});

test('agentsUpsert：新建/编辑/重名/上限/不存在', () => {
    const agents = baseList();
    const created = agentsUpsert(agents, {name: '新人', modelRef: 'p1|m2'}, () => 'new-id');
    assert.equal(created.ok, true);
    assert.equal(agents.length, 3);
    assert.equal(agents[2].id, 'new-id');
    assert.match(agentsUpsert(agents, {name: '新人'}, () => 'x').error, /重名/);
    assert.match(agentsUpsert(agents, {id: 'ghost', name: '鬼影'}, () => 'x').error, /不存在/);
    // 编辑：改名重名被拒；改自己名 OK；id/createdAt 保持
    const a1 = agentById(agents, 'a1');
    assert.match(agentsUpsert(agents, {id: 'a1', name: '审查员'}, () => 'x').error, /重名/);
    const before = a1.createdAt;
    const edited = agentsUpsert(agents, {id: 'a1', name: '架构师2', modelRef: 'p1|m1', role: '拍板'}, () => 'x');
    assert.equal(edited.ok, true);
    assert.equal(agentById(agents, 'a1').name, '架构师2');
    assert.equal(agentById(agents, 'a1').createdAt, before);
    // 上限
    const full = normalizeAgents(Array.from({length: AGENT_MAX_COUNT}, (_, i) => ({name: 'n' + i})), () => 'g');
    assert.match(agentsUpsert(full, {name: '超员'}, () => 'x').error, /最多/);
});

test('agentsRemove / agentById', () => {
    const agents = baseList();
    const removed = agentsRemove(agents, 'a1');
    assert.equal(removed.name, '架构师');
    assert.equal(agents.length, 1);
    assert.equal(agentsRemove(agents, 'ghost'), null);
    assert.equal(agentById(agents, 'a2').chair, true);
    assert.equal(agentById(agents, 'ghost'), null);
});

test('resolveAgentModel / agentCapability：有效、失效、空 ref', () => {
    const agents = baseList();
    const resolved = resolveAgentModel(agents[0], profiles);
    assert.equal(resolved.entry.model, 'gpt-x');
    assert.equal(resolved.account.id, 'p1');
    assert.equal(resolveAgentModel({id: 'x', name: 'X', modelRef: 'p1|ghost'}, profiles), null);
    assert.equal(resolveAgentModel({id: 'x', name: 'X', modelRef: 'ghost|m1'}, profiles), null);
    assert.equal(resolveAgentModel({id: 'x', name: 'X', modelRef: ''}, profiles), null);

    const ok = agentCapability(agents[0], profiles);
    assert.equal(ok.available, true);
    assert.equal(ok.contextWindow, 1048576);
    assert.equal(ok.tier, 'standard');

    const broken = agentCapability({id: 'x', name: 'X', modelRef: 'ghost|m1'}, profiles);
    assert.equal(broken.available, false);
    assert.equal(broken.label, '模型不可用');
});

test('agentThinkingTier：reasoningEffort / anthropic thinking / slowTier 覆盖', () => {
    const agents = baseList();
    const withReasoning = {id: 'r', name: 'R', modelRef: 'p1|m2'};
    assert.equal(agentThinkingTier(withReasoning, profiles), 'thinking');
    const anthropic = {id: 't', name: 'T', modelRef: 'p2|m1'};
    assert.equal(agentThinkingTier(anthropic, profiles), 'thinking');
    assert.equal(agentThinkingTier(agents[0], profiles), 'standard');
    const slowMarked = {id: 's', name: 'S', modelRef: 'p1|m1', slowTier: true};
    assert.equal(agentThinkingTier(slowMarked, profiles), 'thinking');
    // 模型失效时手动标注仍生效（兼容端点探测不到能力）
    const brokenSlow = {id: 'b', name: 'B', modelRef: 'ghost|m1', slowTier: true};
    assert.equal(agentThinkingTier(brokenSlow, profiles), 'thinking');
});

test('配置 roundtrip：normalizeAgents 自反稳定（id/名字/字段不变）', () => {
    const list = normalizeAgents([
        {id: 'a1', name: '架构师', modelRef: 'p1|m1', personaText: '人设', chair: false, temperature: 0.7, slowTier: true, createdAt: 123, updatedAt: 456},
        {id: 'a2', name: '审查员', modelRef: 'p2|m1', chair: true, enabled: false},
    ], () => 'g');
    const again = normalizeAgents(JSON.parse(JSON.stringify(list)), () => 'g');
    assert.deepEqual(again.map((a) => ({...a})), list.map((a) => ({...a})));
});

// ==================== app_control 代建智能体：模型清单与关键词解析 ====================

test('listModelOptions：全部账号×模型条目，ref/label/account 齐全', () => {
    const options = listModelOptions(profiles);
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.ref), ['p1|m1', 'p1|m2', 'p2|m1']);
    assert.equal(options[0].model, 'gpt-x');
    assert.equal(options[0].account, '账号一');
    assert.ok(options[0].label.includes('gpt-x'));
});

test('resolveModelByKeyword：ref 精确 / 账号名/模型名 / 模型名精确 / 唯一子串', () => {
    // 精确 ref
    let hit = resolveModelByKeyword(profiles, 'p1|m2');
    assert.equal(hit.ok, true);
    assert.equal(hit.option.model, 'o-x');
    // 账号名/模型名（全角与半角分隔符都支持）
    hit = resolveModelByKeyword(profiles, '账号二/claude-x');
    assert.equal(hit.ok, true);
    assert.equal(hit.option.ref, 'p2|m1');
    hit = resolveModelByKeyword(profiles, '账号一：o-x');
    assert.equal(hit.ok, true);
    assert.equal(hit.option.ref, 'p1|m2');
    // 模型名精确
    hit = resolveModelByKeyword(profiles, 'claude-x');
    assert.equal(hit.ok, true);
    assert.equal(hit.option.ref, 'p2|m1');
    // 唯一子串 + 大小写不敏感
    hit = resolveModelByKeyword(profiles, 'CLAUDE');
    assert.equal(hit.ok, true);
});

test('resolveModelByKeyword：多命中报 ambiguous 并给候选；未命中/空报原因', () => {
    // 两个账号都有模型名含 "小窗" 的情况：构造一个同名模型
    const dupProfiles = [
        {id: 'a', name: '甲账号', models: [{id: 'm1', model: 'shared-model'}]},
        {id: 'b', name: '乙账号', models: [{id: 'm1', model: 'shared-model'}]},
    ];
    const ambiguous = resolveModelByKeyword(dupProfiles, 'shared-model');
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.reason, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);
    // 账号名消歧后唯一
    const disambiguated = resolveModelByKeyword(dupProfiles, '乙账号/shared-model');
    assert.equal(disambiguated.ok, true);
    assert.equal(disambiguated.option.ref, 'b|m1');
    // 未命中 / 空
    assert.equal(resolveModelByKeyword(profiles, 'no-such-model').reason, 'not_found');
    assert.equal(resolveModelByKeyword(profiles, '  ').reason, 'empty');
});
