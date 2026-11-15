// 插件注册的可插拔 AI provider：以「虚拟账号」进入模型选择器，并在每次组装请求配置时
// 调用插件的 prepare() 注入动态请求头 / 请求体补丁。
//
// 设计边界（重要）：
// - 插件不接管 HTTP。请求与 SSE 解码始终在 Go 侧，插件只能声明连接信息与每轮补丁，
//   这样代理、超时、看门狗、错误分类等既有能力全部保留。
// - 虚拟账号只在内存里存在（pluginAI: true），saveAIConfig 会过滤掉它们，
//   插件卸载 / 禁用后账号随之消失，用户 ai-config.json 不被写入任何插件数据。
// - 补丁只放行 extraHeaders / extraBody 两个白名单字段；baseURL / apiKey / model
//   仍由注册时的账号声明决定，stream 恒为 true（Go 侧另有强制护栏）。
// - 上限与 Go 侧 aiMaxExtraHeaders / aiMaxExtraBodyKeys / aiMaxExtraBodyBytes 对齐；
//   本模块是纯逻辑、无 DOM 依赖，注册表只由 loadPlugins 重建。

export const AI_PROVIDER_ACCOUNT_PREFIX = 'pluginai:';
export const AI_PROVIDER_MAX_HEADERS = 8;
export const AI_PROVIDER_MAX_MODELS = 50;
export const AI_PROVIDER_MAX_BODY_KEYS = 32;
export const AI_PROVIDER_MAX_BODY_BYTES = 64 * 1024;

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const providers = new Map();

function bad(message) {
    throw new Error('[registerAIProvider] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function cleanHeaderEntries(raw) {
    if (!isPlainObject(raw)) return [];
    const out = [];
    for (const [key, value] of Object.entries(raw)) {
        const name = String(key).trim();
        const text = String(value == null ? '' : value);
        if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(text)) continue;
        out.push([name, text]);
    }
    return out;
}

function normalizeAccount(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const baseURL = String(src.baseURL == null ? '' : src.baseURL).trim();
    if (baseURL && !/^https?:\/\//i.test(baseURL)) bad('account.baseURL 仅支持 http/https');
    const temperature = Number(src.temperature);
    return {
        provider: ['anthropic', 'responses'].includes(src.provider) ? src.provider : 'openai',
        baseURL,
        apiKey: String(src.apiKey == null ? '' : src.apiKey),
        temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.7,
        proxy: String(src.proxy == null ? '' : src.proxy).trim(),
        // 静态头也要守 Go 侧的 8 条上限，否则未注入动态头时会被 validateAIEndpoint 拒绝
        extraHeaders: Object.fromEntries(cleanHeaderEntries(src.extraHeaders).slice(0, AI_PROVIDER_MAX_HEADERS)),
    };
}

function normalizeModel(raw, index) {
    const src = isPlainObject(raw) ? raw : {};
    const model = String(src.model == null ? '' : src.model).trim();
    if (!model) bad(`models[${index}] 缺少 model`);
    const windowOf = (value, fallback) => {
        const n = Math.round(Number(value));
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
        id: `m${index + 1}`,
        model,
        contextWindow: windowOf(src.contextWindow, 128000),
        outputWindow: windowOf(src.outputWindow, 4096),
        modalities: {text: true, image: true, video: false, audio: false},
        reasoningEffort: ['low', 'medium', 'high'].includes(src.reasoningEffort) ? src.reasoningEffort : '',
        thinking: src.thinking === true,
        thinkingBudget: windowOf(src.thinkingBudget, 8000),
        autoFilled: false,
    };
}

// 注册一个 provider。spec 形状见 docs/plugins/README.md「注册 AI provider」。
export function registerPluginAIProvider(pluginId, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner) bad('缺少插件 id');
    if (!isPlainObject(spec)) bad('需要一个 provider 对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(spec.id)}`);
    const name = String(spec.name || '').trim().slice(0, 80);
    if (!name) bad('缺少 name');
    if (spec.prepare != null && typeof spec.prepare !== 'function') bad('prepare 必须是函数');
    if (!Array.isArray(spec.models) || !spec.models.length) bad('models 至少要有 1 条');
    if (spec.models.length > AI_PROVIDER_MAX_MODELS) bad(`models 最多 ${AI_PROVIDER_MAX_MODELS} 条`);
    const accountId = AI_PROVIDER_ACCOUNT_PREFIX + owner + ':' + id;
    if (providers.has(accountId)) bad(`provider ${id} 已注册`);
    const models = spec.models.map(normalizeModel);
    const record = {
        accountId,
        id,
        pluginId: owner,
        name,
        account: normalizeAccount(spec.account),
        models,
        prepare: typeof spec.prepare === 'function' ? spec.prepare : null,
    };
    providers.set(accountId, record);
    return record;
}

export function clearPluginAIProviders() {
    providers.clear();
}

export function getPluginAIProviders() {
    return [...providers.values()];
}

// 生成可直接进 config.profiles 的虚拟账号（字段与 normalizeProfile 的产物对齐）。
export function pluginAIAccounts() {
    const out = [];
    for (const record of providers.values()) {
        const models = record.models.map((entry, index) => ({...entry, id: `${record.accountId}-m${index + 1}`}));
        const first = models[0];
        out.push({
            id: record.accountId,
            name: record.name,
            provider: record.account.provider,
            baseURL: record.account.baseURL,
            apiKey: record.account.apiKey,
            temperature: record.account.temperature,
            proxy: record.account.proxy,
            extraHeaders: {...record.account.extraHeaders},
            models,
            lastModelId: first.id,
            // 旧字段镜像（旧版 exe 回滚时读取）
            model: first.model,
            maxTokens: first.outputWindow,
            contextWindow: first.contextWindow,
            reasoningEffort: first.reasoningEffort,
            thinking: first.thinking,
            thinkingBudget: first.thinkingBudget,
            // 保存配置时据此剔除，绝不落盘
            pluginAI: true,
        });
    }
    return out;
}

// 纯函数：把 prepare() 的返回值合并进 AIConfig，只放行两个白名单字段。
export function applyPluginAIPatch(cfg, patch) {
    if (!cfg || typeof cfg !== 'object' || !isPlainObject(patch)) return cfg;
    const next = {...cfg};

    const patchHeaders = cleanHeaderEntries(patch.extraHeaders);
    if (patchHeaders.length) {
        const staticHeaders = cleanHeaderEntries(cfg.extraHeaders);
        const patchNames = new Set(patchHeaders.map(([key]) => key.toLowerCase()));
        const keptStatic = staticHeaders.filter(([key]) => !patchNames.has(key.toLowerCase()));
        let merged = [...keptStatic, ...patchHeaders];
        if (merged.length > AI_PROVIDER_MAX_HEADERS) {
            // 插件的动态头优先，静态头按剩余名额保留
            const dynamic = patchHeaders.slice(0, AI_PROVIDER_MAX_HEADERS);
            merged = [...keptStatic.slice(0, Math.max(0, AI_PROVIDER_MAX_HEADERS - dynamic.length)), ...dynamic];
        }
        next.extraHeaders = Object.fromEntries(merged);
    }

    if (isPlainObject(patch.extraBody)) {
        const keys = Object.keys(patch.extraBody);
        let size = 0;
        try {
            size = JSON.stringify(patch.extraBody).length;
        } catch (e) {
            console.warn('[plugin-ai] extraBody 不可序列化，已忽略');
        }
        if (size > 0 && keys.length <= AI_PROVIDER_MAX_BODY_KEYS && size <= AI_PROVIDER_MAX_BODY_BYTES) {
            const body = {...patch.extraBody};
            // SSE 解码依赖流式响应，插件不能把它关掉
            delete body.stream;
            next.extraBody = body;
        } else if (size > 0) {
            console.warn('[plugin-ai] extraBody 超出上限，已忽略');
        }
    }
    return next;
}

// 每次组装请求配置时调用：按账号 id 找 provider → prepare(ctx) → 合并补丁。
// prepare 抛异常只降级忽略，绝不阻断本轮对话。
export function mergePluginAIRequest(cfg, ctx) {
    const accountId = String((ctx && ctx.accountId) || '');
    if (!accountId.startsWith(AI_PROVIDER_ACCOUNT_PREFIX)) return cfg;
    const record = providers.get(accountId);
    if (!record || !record.prepare) return cfg;
    let patch;
    try {
        patch = record.prepare({
            sessionId: String((ctx && ctx.sessionId) || ''),
            accountId,
            providerId: record.id,
            model: String((cfg && cfg.model) || ''),
            baseURL: String((cfg && cfg.baseURL) || ''),
        });
    } catch (e) {
        console.warn('[plugin-ai] prepare 失败，已忽略补丁：' + ((e && e.message) || e));
        return cfg;
    }
    return applyPluginAIPatch(cfg, patch);
}
