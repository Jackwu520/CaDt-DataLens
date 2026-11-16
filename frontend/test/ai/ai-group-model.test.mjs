// ai-group-model.test.mjs：群 meta 归一化（§6.2）、调用估算（§3.4）、创建前预检（§3.16）
// 与内置主持人模板护栏。方案 docs/unfinished-plans/ai-group-chat.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BUILTIN_CHAIR,
    GROUP_MEMBER_MAX,
    TIMEOUT_PRESETS,
    estimateDiscussionCalls,
    normalizeGroupMeta,
    preflightGroup,
    resolveChairModel,
} from '../../src/ai/ai-group-model.js';
import {agentsUpsert} from '../../src/ai/ai-agent-model.js';

const profiles = [
    {
        id: 'p1', name: '大窗账号', provider: 'openai', models: [
            {id: 'm1', model: 'big-1m', contextWindow: 1048576, outputWindow: 8192, reasoningEffort: '', thinking: false},
        ],
    },
    {
        id: 'p2', name: '小窗账号', provider: 'openai', models: [
            {id: 'm1', model: 'small-32k', contextWindow: 32768, outputWindow: 4096, reasoningEffort: '', thinking: false},
        ],
    },
];

const agents = [
    {id: 'a1', name: '架构师', color: 'blue', role: '设计', modelRef: 'p1|m1', personaText: '', chair: false, enabled: true},
    {id: 'a2', name: '审查员', color: 'red', role: '审查', modelRef: 'p2|m1', personaText: '人'.repeat(2000), chair: false, enabled: true},
    {id: 'a3', name: '主持人', color: 'violet', role: '主持', modelRef: 'p1|m1', personaText: '', chair: true, enabled: true},
];

test('normalizeGroupMeta：默认值与钳制', () => {
    const meta = normalizeGroupMeta({});
    assert.equal(meta.v, 2);
    assert.equal(meta.kind, 'group');
    assert.equal(meta.mode, 'roundtable');
    assert.equal(meta.goal, 'explore');
    assert.equal(meta.maxRounds, 2);
    assert.equal(meta.maxSpeeches, 12);
    assert.equal(meta.roundMode, 'sequential');
    assert.equal(meta.timeouts.memberTotalMs, 180000);
    assert.equal(meta.timeouts.chairThinkingMs, 240000);
    assert.equal(meta.chair.kind, 'ai');
    assert.equal(meta.chair.policy, 'round-plan');
    assert.deepEqual(meta.discussion.agenda, []);
    assert.equal(meta.sharedSummary, null);
    // 非法值回默认
    const bad = normalizeGroupMeta({maxRounds: 9, maxSpeeches: -5, goal: 'nope', mode: 'nope', roundMode: 'nope', timeouts: {memberTotalMs: -1}});
    assert.equal(bad.maxRounds, 3);
    assert.equal(bad.maxSpeeches, 1);
    assert.equal(bad.goal, 'explore');
    assert.equal(bad.mode, 'roundtable');
    assert.equal(bad.roundMode, 'sequential');
    assert.equal(bad.timeouts.memberTotalMs, 180000);
    // 成员截断到上限
    const many = normalizeGroupMeta({memberIds: Array.from({length: GROUP_MEMBER_MAX + 3}, (_, i) => 'a' + i)});
    assert.equal(many.memberIds.length, GROUP_MEMBER_MAX);
});

test('estimateDiscussionCalls：round-plan 13 / adaptive 17（4 成员 × 2 轮，§3.4）', () => {
    assert.equal(estimateDiscussionCalls(4, 2, 'round-plan'), 13);
    assert.equal(estimateDiscussionCalls(4, 2, 'adaptive'), 17);
    assert.equal(estimateDiscussionCalls(3, 1, 'round-plan'), 3 + 2 + 1);
});

test('preflightGroup：大窗绿 / 小窗红 / 人设超长黄', () => {
    const items = preflightGroup({agents, profiles, memberIds: ['a1', 'a2'], sharedTokens: 0, boardTokens: 1200});
    assert.equal(items.length, 2);
    // a1：900 + 0 + 1200 = 2100 / (1M - 8192 - 2048) → 远小于 70% 绿
    assert.equal(items[0].level, 'green');
    // a2：900 + ~1500 + 1200 = 3600 / (32768 - 4096 - 2048 = 26624) ≈ 13.5% → 也绿（窗口按 32K 算仍装得下）
    assert.equal(items[1].level, 'green');
    // 共享对话推高后小窗变红、大窗仍绿
    const stressed = preflightGroup({agents, profiles, memberIds: ['a1', 'a2'], sharedTokens: 90000, boardTokens: 4096});
    assert.equal(stressed[0].level, 'green');
    assert.equal(stressed[1].level, 'red');
    assert.match(stressed[1].detail, /停止参与/);
});

test('preflightGroup：模型不可用 / 已删除成员', () => {
    const items = preflightGroup({agents, profiles, memberIds: ['ghost', 'a1'], sharedTokens: 0, boardTokens: 1200});
    assert.equal(items[0].level, 'red');
    assert.equal(items[0].name, '已删除成员');
    const broken = preflightGroup({agents: [{...agents[1], modelRef: 'p2|ghost'}], profiles, memberIds: ['a2'], sharedTokens: 0, boardTokens: 1200});
    assert.equal(broken[0].level, 'red');
    assert.match(broken[0].detail, /模型不可用/);
});

test('BUILTIN_CHAIR 能通过 agentsUpsert 校验（一键创建默认主持人）', () => {
    const list = [];
    const result = agentsUpsert(list, {...BUILTIN_CHAIR, modelRef: ''}, () => 'chair-id');
    assert.equal(result.ok, true);
    assert.equal(list[0].chair, true);
    assert.equal(list[0].name, '主持人');
    // 重复创建被名字唯一性拦下
    const again = agentsUpsert(list, {...BUILTIN_CHAIR, modelRef: ''}, () => 'chair-2');
    assert.equal(again.ok, false);
    assert.match(again.error, /重名/);
});

test('resolveChairModel：AI 主持指向智能体 / user 主持为 null / 失效为 null', () => {
    const meta = normalizeGroupMeta({chair: {kind: 'ai', agentId: 'a3'}});
    assert.equal(resolveChairModel(meta, agents).id, 'a3');
    const userChair = normalizeGroupMeta({chair: {kind: 'user'}});
    assert.equal(resolveChairModel(userChair, agents), null);
    const ghost = normalizeGroupMeta({chair: {kind: 'ai', agentId: 'ghost'}});
    assert.equal(resolveChairModel(ghost, agents), null);
});

test('TIMEOUT_PRESETS：宽松档整体大于标准档', () => {
    for (const key of Object.keys(TIMEOUT_PRESETS.standard.timeouts)) {
        assert.ok(TIMEOUT_PRESETS.lenient.timeouts[key] > TIMEOUT_PRESETS.standard.timeouts[key], key);
    }
});
