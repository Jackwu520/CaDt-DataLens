// ai-config-model.js：AI 配置「账号 + 多模型」数据层（纯函数，无 DOM 依赖，可单测）。
// 账号（profile）保存连接信息（provider / baseURL / apiKey / 代理 / 请求头）；
// models[] 下每个模型条目有独立的上下文窗口 / 输出窗口 / 输入能力 / 推理等级配置。
// 旧版单模型字段（model / maxTokens / contextWindow / …）保留为激活条目的镜像，
// 旧版本 exe 回滚后仍能读到一份可用配置；新逻辑一律以 models[] 为准。

export const CONTEXT_WINDOW_MIN = 2048;
export const CONTEXT_WINDOW_MAX = 8388608; // 8M tokens
export const OUTPUT_WINDOW_MIN = 1;
export const OUTPUT_WINDOW_MAX = 2097152; // 2M tokens
export const THINKING_BUDGET_MIN = 1024;
export const THINKING_BUDGET_MAX = 393215;

// 「本次会话上下文上限」候选档位（模型选择器下拉可选的会话级窗口上限）。
// 只列出 < 模型 contextWindow 的档位；模型窗口不大于最小档时整个设置不出现。
export const CTX_LIMIT_TIERS = [262144, 524288, 1048576]; // 256K / 512K / 1M

export const MODALITY_KEYS = ['text', 'image', 'video', 'audio'];
export const MODALITY_LABELS = {text: '文本', image: '图像', video: '视频', audio: '音频'};

export function clampNumber(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// 窗口类输入支持 K / M 单位：'256K' → 262144、'1M' → 1048576、'131K' → 134144、
// '1.5M' → 1572864、'4096' → 4096；非法输入（负数 / 非数字 / 空串）返回 null。
export function parseTokenAmount(raw) {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || raw <= 0) return null;
        return Math.round(raw);
    }
    const text = String(raw == null ? '' : raw).trim().replace(/[,\s_]/g, '');
    if (!text) return null;
    const match = text.match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base) || base <= 0) return null;
    const unit = (match[2] || '').toLowerCase();
    const scale = unit === 'k' ? 1024 : (unit === 'm' ? 1024 * 1024 : 1);
    const value = Math.round(base * scale);
    return value > 0 ? value : null;
}

// 数字回显：能精确表示成整 K / M 时用单位显示（262144 → '256K'），否则原样。
export function formatTokenAmount(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1048576 && n % 1048576 === 0) return (n / 1048576) + 'M';
    if (n >= 1024 && n % 1024 === 0) return (n / 1024) + 'K';
    return String(n);
}

// 窗口字段归一：先按 K/M 解析，再 clamp；解析失败退回数字 clamp（含回退值）。
export function windowValue(value, min, max, fallback) {
    const parsed = parseTokenAmount(value);
    if (parsed != null) return clampNumber(parsed, min, max, fallback);
    return clampNumber(value, min, max, fallback);
}

// 服务端参数校验给出 max_tokens 上界时，把模型条目的输出窗口收敛到该上界。
// 只降不升（服务端上限比用户已设值还宽松时不动），返回是否改动。
// 供 AI 面板在 Go 侧自动降档重试成功后回写配置，避免下一轮继续踩同一个 400。
export function applyOutputWindowLimit(entry, limit) {
    const raw = Math.round(Number(limit));
    if (!entry || typeof entry !== 'object' || !Number.isFinite(raw) || raw <= 0) return false;
    const cap = clampNumber(raw, OUTPUT_WINDOW_MIN, OUTPUT_WINDOW_MAX, 0);
    const current = Math.round(Number(entry.outputWindow));
    if (!Number.isFinite(current) || current <= cap) return false;
    entry.outputWindow = cap;
    // Anthropic 扩展思考要求 maxTokens > thinkingBudget：收敛后预算可能反过来越界。
    const budget = Math.round(Number(entry.thinkingBudget));
    if (Number.isFinite(budget) && budget >= cap) entry.thinkingBudget = Math.max(1, cap - 1);
    return true;
}

// 会话上下文上限归一：支持数字与 K/M 字符串（读回旧 meta 时的容错）；
// 非法 / ≤0 一律归 0（不设限），合法值 clamp 进窗口量级。
export function normalizeCtxLimit(raw) {
    const parsed = parseTokenAmount(raw);
    return parsed != null ? Math.min(CONTEXT_WINDOW_MAX, parsed) : 0;
}

// 生效上下文窗口：会话上限只在低于模型窗口时收窄，永不放大；
// 基线异常（≤0 / 非数字）时只信任上限（可能为 0，调用方自行兜底）。
export function effectiveContextWindow(baseWindow, ctxLimit) {
    const limit = normalizeCtxLimit(ctxLimit);
    const base = Math.round(Number(baseWindow));
    if (!Number.isFinite(base) || base <= 0) return limit;
    return limit > 0 ? Math.min(limit, base) : base;
}

// 该模型窗口下可选择的档位（严格小于模型窗口的固定档）；空数组 = 隐藏整个设置。
export function ctxLimitTiersFor(baseWindow) {
    const base = Math.max(0, Math.round(Number(baseWindow)) || 0);
    return CTX_LIMIT_TIERS.filter((tier) => tier < base);
}

export function defaultModalities() {
    // 默认勾选文本 + 图像；视频 / 音频留待模型与发送通道支持后再开。
    return {text: true, image: true, video: false, audio: false};
}

export function normalizeModalities(raw) {
    const out = defaultModalities();
    if (raw && typeof raw === 'object') {
        for (const key of MODALITY_KEYS) {
            if (raw[key] === true || raw[key] === false) out[key] = raw[key];
        }
    }
    return out;
}

export function normalizeModelEntry(raw, idGen) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        id: String(source.id || '').trim() || (idGen ? idGen() : 'model-' + Date.now().toString(36)),
        model: String(source.model || '').trim(),
        contextWindow: windowValue(source.contextWindow, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, 128000),
        outputWindow: windowValue(
            source.outputWindow != null ? source.outputWindow : source.maxTokens,
            OUTPUT_WINDOW_MIN, OUTPUT_WINDOW_MAX, 4096),
        modalities: normalizeModalities(source.modalities),
        reasoningEffort: ['low', 'medium', 'high'].includes(source.reasoningEffort) ? source.reasoningEffort : '',
        thinking: source.thinking === true,
        thinkingBudget: clampNumber(source.thinkingBudget, THINKING_BUDGET_MIN, THINKING_BUDGET_MAX, 8000),
        // 窗口/能力是否还归模型配置表管（model-catalog.js）：用户手改过任一被回填字段就置 false，
        // 之后再换模型 ID 也不覆盖。存量条目视为手填，不会被配置表改动。
        autoFilled: source.autoFilled === true,
    };
}

// 取账号的激活模型条目：按 activeModelId 精确匹配，缺省退回首条目；无条目返回 null。
// 注意这是「取一个可用条目」的语义——找不到会静默回落首条，**不要**用它做 id 有效性校验，
// 否则 `if (!modelEntryOf(...))` 恒为假，兜底分支永远不执行。校验请用 findModelEntry。
export function modelEntryOf(account, activeModelId) {
    const models = account && Array.isArray(account.models) ? account.models : [];
    if (!models.length) return null;
    const id = String(activeModelId || '');
    return models.find((entry) => entry && entry.id === id) || models[0];
}

// 严格按 id 精确匹配条目；找不到返回 null，绝不回落。用于校验一个 id 是否真的存在。
export function findModelEntry(account, id) {
    const models = account && Array.isArray(account.models) ? account.models : [];
    const key = String(id || '');
    return key ? (models.find((entry) => entry && entry.id === key) || null) : null;
}

// 解析出「保证落在该账号下」的模型 id：preferred 精确命中优先，其次 fallback，最后首条目；
// 无条目返回 ''。配置归一化 / 导入 / 编辑器关停等兜底统一走它，避免把失效 id 写回配置。
export function resolveModelId(account, preferred, fallback) {
    const models = account && Array.isArray(account.models) ? account.models : [];
    if (!models.length) return '';
    return (findModelEntry(account, preferred) || findModelEntry(account, fallback) || models[0]).id;
}

// 确保 account.models 为归一化的非空数组；旧版单模型 profile 迁移为首条目，
// 并把旧字段同步为激活条目（缺省首条目）的镜像。
export function migrateAccountModels(account, activeModelId, idGen) {
    if (!account || typeof account !== 'object') return [];
    const seen = new Set();
    let models = Array.isArray(account.models)
        ? account.models
            .filter((raw) => raw && typeof raw === 'object')
            .map((raw) => normalizeModelEntry(raw, idGen))
            .filter((entry) => {
                if (seen.has(entry.id)) return false;
                seen.add(entry.id);
                return true;
            })
        : [];
    if (!models.length) {
        models = [normalizeModelEntry({
            id: account.id ? account.id + '-m1' : '',
            model: account.model,
            contextWindow: account.contextWindow,
            outputWindow: account.maxTokens,
            reasoningEffort: account.reasoningEffort,
            thinking: account.thinking,
            thinkingBudget: account.thinkingBudget,
        }, idGen)];
    }
    account.models = models;
    const mirror = modelEntryOf(account, activeModelId) || models[0];
    account.model = mirror.model;
    account.maxTokens = mirror.outputWindow;
    account.contextWindow = mirror.contextWindow;
    account.reasoningEffort = mirror.reasoningEffort;
    account.thinking = mirror.thinking;
    account.thinkingBudget = mirror.thinkingBudget;
    return models;
}

// 模型条目的思考等级单一来源（模型选择器行内徽标 / 档位条 / chip 文案共用）：
// 非 Anthropic 按 reasoningEffort 推导（空串 = 自动），Anthropic 按 thinking/thinkingBudget
// 反推档位（沿用旧边界：≤2048 低、≤10000 中、其余高）。返回当前档位值、中文标签、
// 该协议的候选档位表与徽标配色档（tone：auto=灰、low=蓝、mid=黄、high=紫红，
// 驱动 style.css 的 --ai-lv-* 分色徽标）。
export function reasoningLevelInfo(account, entry) {
    const anthropic = !!(account && account.provider === 'anthropic');
    const options = anthropic
        ? [['off', '关'], ['low', '低'], ['medium', '中'], ['high', '高']]
        : [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']];
    let value;
    if (anthropic) {
        if (!entry || entry.thinking !== true) {
            value = 'off';
        } else {
            const budget = Number(entry.thinkingBudget) || 8000;
            value = budget <= 2048 ? 'low' : (budget <= 10000 ? 'medium' : 'high');
        }
    } else {
        value = entry && ['low', 'medium', 'high'].includes(entry.reasoningEffort) ? entry.reasoningEffort : 'auto';
    }
    const labels = {auto: '自动', off: '关', low: '低', medium: '中', high: '高'};
    const tones = {auto: 'auto', off: 'auto', low: 'low', medium: 'mid', high: 'high'};
    return {value, label: labels[value] || '自动', options, tone: tones[value] || 'auto'};
}

// 组装发请求用的 AIConfig：连接类字段取账号，模型类字段取条目。
export function configForModel(account, entry) {
    const provider = ['anthropic', 'responses'].includes(account && account.provider) ? account.provider : 'openai';
    return {
        provider,
        baseURL: account ? String(account.baseURL || '') : '',
        apiKey: account ? String(account.apiKey || '') : '',
        model: entry ? String(entry.model || '') : '',
        temperature: account ? Number(account.temperature) || 0 : 0,
        maxTokens: entry ? entry.outputWindow : 4096,
        proxy: account ? String(account.proxy || '') : '',
        extraHeaders: (account && account.extraHeaders && typeof account.extraHeaders === 'object')
            ? account.extraHeaders : {},
        thinking: provider === 'anthropic' && !!entry && entry.thinking === true,
        thinkingBudget: entry ? entry.thinkingBudget : 8000,
        reasoningEffort: provider === 'anthropic' ? '' : (entry ? (entry.reasoningEffort || '') : ''),
    };
}

// 解析模型引用（自动审批分类器等场景）：'accountId|modelId'；兼容旧格式（纯账号 id
// 解析为该账号首条目）。无效 / 已删除返回 ''（跟随当前模型）。
export function resolveModelRef(rawRef, profiles) {
    const ref = String(rawRef == null ? '' : rawRef).trim();
    if (!ref || !Array.isArray(profiles)) return '';
    const sep = ref.indexOf('|');
    const accountId = sep >= 0 ? ref.slice(0, sep) : ref;
    const modelId = sep >= 0 ? ref.slice(sep + 1) : '';
    const account = profiles.find((p) => p && typeof p === 'object' && p.id === accountId);
    if (!account) return '';
    const models = Array.isArray(account.models) ? account.models : [];
    if (modelId) {
        return models.some((entry) => entry && entry.id === modelId) ? ref : '';
    }
    return models[0] ? accountId + '|' + models[0].id : '';
}

// 下拉 / 菜单选项标签：模型名 · 账号名（与模型菜单一致）；缺模型名时退回账号名。
export function modelRefLabel(account, entry) {
    const model = entry && entry.model ? String(entry.model).trim() : '';
    const name = account && account.name ? String(account.name).trim() : '';
    const primary = model || name;
    if (!primary) return '';
    return name && name !== primary ? primary + ' · ' + name : primary;
}
