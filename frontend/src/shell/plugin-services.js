// 插件后台服务注册表（纯逻辑，无 DOM 依赖）：插件经 cadt.registerService 声明一个
// 后台进程，本模块规范化声明、维护「插件内短 id → Go 侧全局 id」映射，并在所有插件
// 加载完成后由 loadPlugins 统一 AppServiceSync 推送给 Go。启停/状态/日志操作转发 backend。
//
// 设计边界：进程真正的启停/健康检查/退出清理都在 Go 侧 internal/appservices；
// 本模块只管声明与转发，不持有进程，也不做协议改写。

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FULL_ID_RULE = /^[a-z0-9][a-z0-9-]{0,127}$/;

const services = new Map();
let backend = null;

function bad(message) {
    throw new Error('[registerService] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// 绑定当前 backend（loadPlugins 每次调用时设置；启停操作据此转发）。
export function bindServiceBackend(b) {
    backend = b || null;
}

// Go 侧服务 id 只允许 [a-z0-9-]，故用连字符拼接插件 id 与短 id 形成全局唯一 id。
function fullServiceId(pluginId, shortId) {
    return String(pluginId) + '-' + String(shortId);
}

function normalizeSpec(pluginId, pluginDir, raw) {
    if (!isPlainObject(raw)) bad('需要一个服务对象');
    const id = String(raw.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(raw.id)}`);
    const exe = String(raw.exe || '').trim();
    if (!exe) bad(`服务 ${id} 缺少 exe`);
    const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)).slice(0, 128) : [];
    // cwd 为空时退回插件目录；相对路径也以插件目录为基准（Windows 正/反斜杠都保留）。
    let cwd = String(raw.cwd == null ? '' : raw.cwd).trim();
    if (!cwd) cwd = String(pluginDir || '');
    else if (!/^[a-zA-Z]:[\\/]/.test(cwd) && !cwd.startsWith('\\\\') && !cwd.startsWith('/')) {
        const base = String(pluginDir || '').replace(/[\\/]+$/, '');
        cwd = base ? base + (cwd.startsWith('\\') || cwd.startsWith('/') ? '' : '/') + cwd : cwd;
    }
    const healthURL = String(raw.healthURL || '').trim();
    if (healthURL && !/^https?:\/\//i.test(healthURL)) bad(`服务 ${id} 的 healthURL 仅支持 http/https`);
    const pollIntervalMs = Math.max(500, Math.round(Number(raw.pollIntervalMs)) || 3000);
    const logCapBytes = Math.max(1024, Math.round(Number(raw.logCapBytes)) || 262144);
    return {
        id, exe, args, cwd, healthURL,
        autoStart: raw.autoStart === true,
        pollIntervalMs,
        logCapBytes,
    };
}

// 注册一个服务。spec 形状见 docs/plugins/README.md「注册后台服务」。
export function registerPluginService(pluginId, pluginDir, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner) bad('缺少插件 id');
    const normalized = normalizeSpec(owner, pluginDir, spec);
    const fullId = fullServiceId(owner, normalized.id);
    if (!FULL_ID_RULE.test(fullId)) bad(`拼出的服务 id 无效：${fullId}`);
    if (services.has(fullId)) bad(`服务 ${normalized.id} 已注册`);
    const record = {pluginId: owner, shortId: normalized.id, fullId, spec: normalized};
    services.set(fullId, record);
    return record;
}

export function clearPluginServices() {
    services.clear();
}

export function getPluginServices() {
    return [...services.values()];
}

// 组装推送给 Go AppServiceSync 的数组（id 换成全局 id）。
export function buildServiceSpecs() {
    return getPluginServices().map((r) => ({...r.spec, id: r.fullId}));
}

function resolveFullId(pluginId, shortId) {
    const fullId = fullServiceId(pluginId, shortId);
    if (!services.has(fullId)) throw new Error('服务未注册：' + shortId);
    return fullId;
}

function requireBackend() {
    if (!backend || typeof backend.AppServiceStart !== 'function') {
        throw new Error('当前版本不支持插件后台服务');
    }
    return backend;
}

export function startService(pluginId, shortId) {
    try { return Promise.resolve(requireBackend().AppServiceStart(resolveFullId(pluginId, shortId))); }
    catch (e) { return Promise.reject(e); }
}

export function stopService(pluginId, shortId) {
    try { return Promise.resolve(requireBackend().AppServiceStop(resolveFullId(pluginId, shortId))); }
    catch (e) { return Promise.reject(e); }
}

export function serviceStatus(pluginId, shortId) {
    try { return Promise.resolve(requireBackend().AppServiceStatus(resolveFullId(pluginId, shortId))); }
    catch (e) { return Promise.reject(e); }
}

export function serviceLogs(pluginId, shortId) {
    try { return Promise.resolve(requireBackend().AppServiceLogs(resolveFullId(pluginId, shortId))); }
    catch (e) { return Promise.reject(e); }
}

// 供插件设置页按插件 id 列出其服务（短 id + 全局 id）。
export function servicesOfPlugin(pluginId) {
    return getPluginServices().filter((r) => r.pluginId === pluginId);
}
