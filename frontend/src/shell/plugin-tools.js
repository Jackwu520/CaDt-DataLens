// plugin-tools.js：插件 AI 工具注册表 + 授权过滤（纯逻辑，无 DOM，可单测）。
//
// 设计依据 docs/unfinished-plans/plugin-tool-security.md（M2 定稿）：
// - 命名 plugin__<pluginId>__<toolName>，与 mcp__ 同构，便于路由与审计识别来源。
// - 注册期严格校验（上限 / 规则 / schema），执行期宽容（单次失败不波及其他工具）。
// - 三层授权（全局总闸 / 插件级 / 工具级）+ readOnly 工具的「只读档可用」子开关，
//   声明只是候选资格，放行必须由用户在授权 UI 显式勾选。
// - 插件工具不许声明 dangerous：审批一律走既有权限链，不给短路口子。

export const PLUGIN_TOOL_PREFIX = 'plugin__';
export const MAX_TOOLS_PER_PLUGIN = 20;
export const MAX_TOOLS_TOTAL = 50;
export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_TIMEOUT_MS = 300000;

const PLUGIN_ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_NAME_RULE = /^[a-z0-9_]{1,40}$/;
const DESCRIPTION_MAX = 2000;
const PARAMETERS_MAX = 16 * 1024;

const tools = new Map(); // fullName → record

function bad(message) {
    throw new Error('[registerTool] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function pluginToolFullName(pluginId, toolName) {
    return PLUGIN_TOOL_PREFIX + pluginId + '__' + toolName;
}

export function isPluginToolName(name) {
    return typeof name === 'string' && name.startsWith(PLUGIN_TOOL_PREFIX);
}

// 解析公开名。toolName 注册时已禁止含 '__'，因此 split 结果恒为 3 段。
export function parsePluginToolName(name) {
    const text = String(name || '');
    if (!isPluginToolName(text)) return null;
    const rest = text.slice(PLUGIN_TOOL_PREFIX.length);
    const idx = rest.indexOf('__');
    if (idx <= 0) return null;
    const pluginId = rest.slice(0, idx);
    const toolName = rest.slice(idx + 2);
    if (!pluginId || !toolName) return null;
    return {pluginId, toolName};
}

// 归一化一个工具声明。校验失败抛错（plugins.js 会包成插件名前缀）。
export function normalizePluginTool(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!PLUGIN_ID_RULE.test(owner)) bad(`插件 id 无效：${JSON.stringify(pluginId)}`);
    if (!isPlainObject(spec)) bad('需要一个工具对象');

    const name = String(spec.name || '').trim();
    if (!TOOL_NAME_RULE.test(name)) bad(`工具名无效：${JSON.stringify(spec.name)}（需 ^[a-z0-9_]{1,40}$）`);
    if (name.includes('__')) bad(`工具名不能含连续双下划线：${name}`);

    const description = String(spec.description == null ? '' : spec.description).trim();
    if (!description) bad(`工具 ${name} 缺少 description`);
    if (description.length > DESCRIPTION_MAX) bad(`工具 ${name} 的 description 超过 ${DESCRIPTION_MAX} 字符`);

    if (spec.parameters != null && !isPlainObject(spec.parameters)) {
        bad(`工具 ${name} 的 parameters 必须是 JSON 对象`);
    }
    const parameters = spec.parameters == null
        ? {type: 'object', properties: {}}
        : spec.parameters;
    let encodedSize = 0;
    try {
        encodedSize = JSON.stringify(parameters).length;
    } catch (e) {
        bad(`工具 ${name} 的 parameters 无法序列化`);
    }
    if (encodedSize > PARAMETERS_MAX) bad(`工具 ${name} 的 parameters 超过 ${PARAMETERS_MAX} 字节`);

    if (typeof spec.execute !== 'function') bad(`工具 ${name} 缺少 execute 函数`);

    const timeoutRaw = Math.round(Number(spec.timeoutMs));
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, timeoutRaw))
        : DEFAULT_TIMEOUT_MS;

    return {
        fullName: pluginToolFullName(owner, name),
        pluginId: owner,
        pluginName: String(pluginName || owner),
        name,
        description,
        parameters,
        readOnly: spec.readOnly === true,
        timeoutMs,
        execute: spec.execute,
    };
}

export function registerPluginTool(pluginId, pluginName, spec) {
    const record = normalizePluginTool(pluginId, pluginName, spec);
    if (tools.has(record.fullName)) bad(`工具 ${record.name} 已注册`);
    let owned = 0;
    for (const item of tools.values()) if (item.pluginId === record.pluginId) owned += 1;
    if (owned >= MAX_TOOLS_PER_PLUGIN) bad(`单插件工具数超过上限 ${MAX_TOOLS_PER_PLUGIN}`);
    if (tools.size >= MAX_TOOLS_TOTAL) bad(`插件工具总数超过上限 ${MAX_TOOLS_TOTAL}`);
    tools.set(record.fullName, record);
    return record;
}

export function clearPluginTools() {
    tools.clear();
}

export function getPluginTools() {
    return [...tools.values()];
}

export function getPluginTool(fullName) {
    return tools.get(String(fullName || '')) || null;
}

// 按插件分组的工具清单（授权 UI 用）。
export function pluginToolsByPlugin() {
    const groups = new Map();
    for (const tool of tools.values()) {
        if (!groups.has(tool.pluginId)) {
            groups.set(tool.pluginId, {pluginId: tool.pluginId, pluginName: tool.pluginName, tools: []});
        }
        groups.get(tool.pluginId).tools.push(tool);
    }
    return [...groups.values()];
}

// 读取某个工具的授权状态。auth 形如：
// {enabled: boolean, plugins: {<pluginId>: {allow: boolean, tools: {<toolName>: {on: boolean, readOnlyOk: boolean}}}}}
export function toolAuthState(auth, pluginId, toolName) {
    const src = isPlainObject(auth) ? auth : {};
    const plugins = isPlainObject(src.plugins) ? src.plugins : {};
    const plugin = isPlainObject(plugins[pluginId]) ? plugins[pluginId] : null;
    if (!plugin) return {globalOn: src.enabled === true, pluginAllow: false, toolOn: false, readOnlyOk: false};
    const entries = isPlainObject(plugin.tools) ? plugin.tools : {};
    const entry = isPlainObject(entries[toolName]) ? entries[toolName] : null;
    return {
        globalOn: src.enabled === true,
        pluginAllow: plugin.allow === true,
        toolOn: !!(entry && entry.on === true),
        readOnlyOk: !!(entry && entry.readOnlyOk === true),
    };
}

// 该工具在当前条件下是否应下发给模型。
// scope ∈ {read, edit, auto, full}；planMode 恒为不给（与 MCP 同口径）。
export function toolIsAvailable(tool, auth, scope, planMode) {
    if (!tool) return false;
    if (planMode) return false;
    const state = toolAuthState(auth, tool.pluginId, tool.name);
    if (!state.globalOn || !state.pluginAllow || !state.toolOn) return false;
    if (scope === 'read') {
        // 只读档：仅「声明 readOnly」且用户显式勾了「只读档可用」的工具才下发。
        return tool.readOnly === true && state.readOnlyOk === true;
    }
    return true;
}

// 组装下发用工具定义（形状对齐 AI_TOOL_DEFS：name / description / parameters）。
export function authorizedPluginToolDefs(auth, scope, planMode) {
    if (planMode) return [];
    const out = [];
    for (const tool of tools.values()) {
        if (!toolIsAvailable(tool, auth, scope, planMode)) continue;
        out.push({
            name: tool.fullName,
            description: tool.description,
            parameters: tool.parameters,
        });
    }
    return out;
}
