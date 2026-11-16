// ai-group-model.js：群聊域纯函数层（方案 docs/unfinished-plans/ai-group-chat.md）。
// G1：meta 归一化（§6.2）、调用估算（§3.4）、创建前兼容性预检（§3.16）、内置主持人模板。
// G2/G3 在本文件继续：点名解析、group 块、主持人契约、看板合并、上下文组装、超时档。
// 无 DOM、无副作用，可单测。

import {aiEstimateTokens} from './ai-constants.js';
import {agentCapability} from './ai-agent-model.js';

export const GROUP_SCHEMA = 2;
export const GROUP_MEMBER_MIN = 2;
export const GROUP_MEMBER_MAX = 8;
export const GROUP_TITLE_MAX = 60;
export const GROUP_TOPIC_MAX = 2000;

export const GROUP_MODES = [
    {id: 'roundtable', label: '圆桌'},
    {id: 'task', label: '任务'},
    {id: 'free', label: '自由'},
];

// 目标（§6.2）：影响主持人提示与纪要结构
export const GROUP_GOALS = [
    {id: 'explore', label: '探索'},
    {id: 'decide', label: '决策'},
    {id: 'plan', label: '方案'},
    {id: 'review', label: '评审'},
];

export const CHAIR_KINDS = [
    {id: 'ai', label: 'AI 主持人'},
    {id: 'member', label: '成员兼任'},
    {id: 'user', label: '我来主持'},
];

export const CHAIR_POLICIES = [
    {id: 'round-plan', label: '轮计划（推荐）'},
    {id: 'adaptive', label: '逐句调度'},
];

// 超时预设（§15 已收口：非思考总时长 180s、思考主持 240s；宽松档覆盖慢供应商）
export const TIMEOUT_PRESETS = {
    standard: {
        label: '标准',
        timeouts: {
            memberFirstActivityMs: 45000,
            memberTotalMs: 180000,
            memberThinkingTotalMs: 240000,
            chairMs: 60000,
            chairThinkingMs: 240000,
            discussionTotalMs: 900000,
        },
    },
    lenient: {
        label: '宽松',
        timeouts: {
            memberFirstActivityMs: 90000,
            memberTotalMs: 300000,
            memberThinkingTotalMs: 420000,
            chairMs: 120000,
            chairThinkingMs: 360000,
            discussionTotalMs: 1800000,
        },
    },
};

export const BOARD_TOKEN_BUDGET = 4096;
export const BRIEF_BOARD_TOKEN_BUDGET = 1200;
// 群规则/成员名单/模式段等系统框架开销估算常量（§7.1 的 [system] 段减去人设与看板）
export const GROUP_SYSTEM_OVERHEAD_TOKENS = 900;
// 请求预算 = contextWindow - outputWindow - reserve（§7.1）
export const GROUP_OUTPUT_RESERVE_TOKENS = 2048;

// 内置主持人模板（§16.2「一键创建默认主持人」）：写进 agents[]，用户可编辑
export const BUILTIN_CHAIR = {
    name: '主持人',
    role: '圆桌主持：建立议程、安排发言、复盘收敛与输出纪要；不参与辩论',
    personaText: [
        '你是多智能体圆桌的主持人：不参与辩论、不站队，职责是让讨论覆盖议程并收敛。',
        '- 建立议程：把议题拆成 2–5 个可讨论的子问题；',
        '- 安排发言：一次决定本轮谁按什么顺序发言、各自回应什么焦点；',
        '- 轮末复盘：汇总共识与分歧、指出未决问题、决定继续或收敛；',
        '- 输出纪要：共识（带理由）、分歧（双方观点）、决定、行动项、未决问题；',
        '- 公正：保证每个成员都被听到；用户点名优先；不替成员表达观点。',
    ].join('\n'),
    chair: true,
    enabled: true,
};

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function clampText(value, max) {
    return String(value == null ? '' : value).slice(0, max);
}

export function normalizeChair(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
        kind: CHAIR_KINDS.some((k) => k.id === c.kind) ? c.kind : 'ai',
        agentId: String(c.agentId || ''),
        policy: c.policy === 'adaptive' ? 'adaptive' : 'round-plan',
        modelRef: String(c.modelRef || ''),
    };
}

function normalizeTimeouts(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const defaults = TIMEOUT_PRESETS.standard.timeouts;
    const out = {};
    for (const key of Object.keys(defaults)) {
        const n = Number(source[key]);
        out[key] = Number.isFinite(n) && n > 0 ? n : defaults[key];
    }
    return out;
}

function normalizeGroupContext(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
        preferredWindow: clampInt(c.preferredWindow, 0, 8388608, 262144),
        maxContextTokens: clampInt(c.maxContextTokens, 0, 8388608, 0),
        boardTokenBudget: clampInt(c.boardTokenBudget, 256, 32768, BOARD_TOKEN_BUDGET),
        briefBoardTokenBudget: clampInt(c.briefBoardTokenBudget, 128, 16384, BRIEF_BOARD_TOKEN_BUDGET),
    };
}

function normalizeDiscussion(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const arr = (value) => (Array.isArray(value) ? value : []);
    return {
        round: clampInt(d.round, 0, 99, 0),
        agenda: arr(d.agenda).map((item) => String(item || '').slice(0, 200)).filter(Boolean),
        positions: arr(d.positions),
        agreements: arr(d.agreements).map(String),
        disagreements: arr(d.disagreements),
        openQuestions: arr(d.openQuestions).map(String),
        decisions: arr(d.decisions).map(String),
        actionItems: arr(d.actionItems),
        coveredPoints: arr(d.coveredPoints).map(String),
        lastRoundSummary: String(d.lastRoundSummary || ''),
    };
}

function normalizeSharedSummary(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text || '');
    if (!text) return null;
    return {
        text,
        cutoffGid: String(raw.cutoffGid || ''),
        createdAt: Number(raw.createdAt) || 0,
        createdBy: String(raw.createdBy || 'user'),
        summarizerModel: String(raw.summarizerModel || ''),
    };
}

// 群 meta 归一化（§6.2）：磁盘读回与创建入参共用；非法字段回默认，不抛错。
export function normalizeGroupMeta(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const now = Date.now();
    return {
        v: GROUP_SCHEMA,
        kind: 'group',
        id: String(source.id || ''),
        title: clampText(source.title, GROUP_TITLE_MAX),
        createdAt: Number(source.createdAt) || now,
        updatedAt: Number(source.updatedAt) || now,
        workspace: String(source.workspace || ''),
        memberIds: Array.isArray(source.memberIds)
            ? source.memberIds.map((id) => String(id || '')).filter(Boolean).slice(0, GROUP_MEMBER_MAX)
            : [],
        mode: GROUP_MODES.some((m) => m.id === source.mode) ? source.mode : 'roundtable',
        chair: normalizeChair(source.chair),
        topic: clampText(source.topic, GROUP_TOPIC_MAX),
        goal: GROUP_GOALS.some((g) => g.id === source.goal) ? source.goal : 'explore',
        maxRounds: clampInt(source.maxRounds, 1, 3, 2),
        maxSpeeches: clampInt(source.maxSpeeches, 1, 200, 12),
        maxTokensPerDiscussion: clampInt(source.maxTokensPerDiscussion, 0, 100000000, 0),
        roundMode: source.roundMode === 'parallel' ? 'parallel' : 'sequential',
        timeouts: normalizeTimeouts(source.timeouts),
        context: normalizeGroupContext(source.context),
        mutedAgentIds: Array.isArray(source.mutedAgentIds) ? source.mutedAgentIds.map(String).filter(Boolean) : [],
        discussion: normalizeDiscussion(source.discussion),
        sharedSummary: normalizeSharedSummary(source.sharedSummary),
        minutes: source.minutes && typeof source.minutes === 'object' ? source.minutes : null,
        lastMessageId: String(source.lastMessageId || ''),
        messageCount: Number(source.messageCount) || 0,
    };
}

// 预计调用量（§3.4）：round-plan = 成员发言 + 每轮计划/复盘 + 1 次纪要；
// adaptive = 每次发言前后各一次主持。4×2 → 13 / 17。
export function estimateDiscussionCalls(memberCount, maxRounds, policy) {
    const speeches = Math.max(1, memberCount) * Math.max(1, maxRounds);
    return policy === 'adaptive'
        ? speeches * 2 + 1
        : speeches + 2 * Math.max(1, maxRounds) + 1;
}

// 创建前兼容性预检（§3.16）：逐成员算「系统 + 人设 + 看板 + 全部共享对话」/ 可用预算。
// 红：>85% 或塞不下（本模型停止参与）；黄：70–85%；绿：≤70%。
// 新建群 sharedTokens=0；讨论中把共享对话估算值传进来即可重跑。
export function preflightGroup({agents, profiles, memberIds, sharedTokens = 0, boardTokens = BRIEF_BOARD_TOKEN_BUDGET, preferredWindow = 262144, outputWindow = 8192}) {
    const list = Array.isArray(agents) ? agents : [];
    const ids = Array.isArray(memberIds) ? memberIds : [];
    return ids.map((id) => {
        const agent = list.find((item) => item && item.id === id);
        if (!agent) {
            return {agentId: id, name: '已删除成员', level: 'red', detail: '智能体不存在，已从名单移除', contextWindow: 0};
        }
        const cap = agentCapability(agent, profiles);
        if (!cap.available) {
            return {agentId: id, name: agent.name, level: 'red', detail: '模型不可用（账号或模型已删除）', contextWindow: 0, thinking: !!agent.slowTier};
        }
        const overhead = GROUP_SYSTEM_OVERHEAD_TOKENS
            + aiEstimateTokens(agent.personaText || '')
            + Math.max(0, Math.round(boardTokens) || 0)
            + Math.max(0, Math.round(sharedTokens) || 0);
        const window = cap.contextWindow || preferredWindow;
        const budget = Math.max(1, window - (cap.outputWindow || outputWindow) - GROUP_OUTPUT_RESERVE_TOKENS);
        const ratio = overhead / budget;
        const level = ratio > 0.85 ? 'red' : ratio > 0.7 ? 'yellow' : 'green';
        const percent = Math.min(999, Math.round(ratio * 100));
        return {
            agentId: id,
            name: agent.name,
            level,
            contextWindow: window,
            thinking: cap.tier === 'thinking',
            detail: level === 'red'
                ? `上下文不足（估算 ${percent}%），该模型将停止参与；可压缩群聊数据、换更大窗口模型或缩短人设`
                : level === 'yellow'
                    ? `接近窗口上限（估算 ${percent}%），可参加`
                    : `正常（估算 ${percent}%）`,
        };
    });
}

// 主持人对象解析：群 meta.chair → 实际生效的模型 ref / 智能体。
// kind='ai'：chairAgentId 指向智能体（取其 modelRef）；kind='member'：成员兼任；
// kind='user'：无 AI 调度。失效返回 null（UI 显示不可用，不静默换模型）。
export function resolveChairModel(meta, agents) {
    const chair = meta && meta.chair ? meta.chair : null;
    if (!chair || chair.kind === 'user') return null;
    const list = Array.isArray(agents) ? agents : [];
    const agent = list.find((item) => item && item.id === chair.agentId);
    if (!agent) return null;
    return agent;
}
