// ai-usage-quota.js：账号额度查询管线——模板/脚本拼装请求规格 → Go 哑通道
//（AIUsageHTTPRequest 转发 aigen.HTTPRequest）发同步 HTTP → Worker 沙箱执行
// extractor → 归一化 → 内存 + localStorage 缓存。「官方」模板不走脚本，直接用
// AIUsageQuery 白名单引擎。展示在 ai-model-settings / ai-panel 弹层，配置在
// ai-usage-config-dialog。extractor 沙箱：Worker 全局没有 window.go / DOM，
// prelude 再禁掉网络与派生原语，超时 terminate——导入的配置按不可信输入对待。
import {
    USAGE_CODE_MAX_LENGTH,
    USAGE_TIMEOUT_MAX_SEC,
    USAGE_TIMEOUT_MIN_SEC,
    normalizeUsageConfig,
} from './ai-config-model.js';
import {
    OFFICIAL_USAGE_HOSTS,
    renderUsageVars,
    usageTemplatePresetCode,
} from './ai-usage-templates.js';

// 沙箱单阶段（解析脚本 / 跑 extractor）的硬超时；查询整体另有 HTTP 超时兜底。
const USAGE_WORKER_TIMEOUT_MS = 5000;
// 脚本响应体上限：余额响应远小于生图，256KB 足够。
const USAGE_RESPONSE_MAX_BYTES = 262144;
const USAGE_SNAPSHOT_ITEMS_MAX = 10;
// localStorage 快照键：只存展示数据（items/error/at），绝不存 override apiKey。
const USAGE_SNAPSHOT_STORAGE_KEY = 'cadt.ai-usage-cache.v1';

// ── 纯函数（可单测）──────────────────────────────────────────

// 结果条目形状：{planName?, isValid, invalidMessage?, remaining?/total?/used?,
// unit?, extra?, label?/value?（官方引擎条目）}。snapshot：{state:'ok'|'error',
// items, error, at}。
export function normalizeUsageResult(raw) {
    const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
    if (!list.length) return {items: [], error: 'extractor 没有返回结果'};
    if (list.length > USAGE_SNAPSHOT_ITEMS_MAX) list.length = USAGE_SNAPSHOT_ITEMS_MAX;
    const items = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return {items: [], error: 'extractor 返回的每个套餐必须是对象'};
        }
        // 字符串字段限长：恶意/异常 extractor 的超长串不进 localStorage 快照
        const str = (value) => (typeof value === 'string' ? value.slice(0, 200) : '');
        const item = {
            planName: str(entry.planName),
            isValid: entry.isValid !== false,
            invalidMessage: str(entry.invalidMessage),
            unit: str(entry.unit),
            extra: str(entry.extra),
        };
        let hasNumber = false;
        for (const key of ['remaining', 'total', 'used']) {
            const value = Number(entry[key]);
            if (Number.isFinite(value)) {
                item[key] = value;
                hasNumber = true;
            }
        }
        if (item.isValid && !hasNumber) {
            return {items: [], error: 'extractor 返回缺少 remaining/total/used 数值字段'};
        }
        items.push(item);
    }
    return {items, error: ''};
}

// 官方白名单引擎（AIUsageResult）→ snapshot。Supported=false 给出选模板的引导文案。
export function officialSnapshotFromResult(result) {
    if (!result || typeof result !== 'object') {
        return {state: 'error', items: [], error: '查询无结果', at: Date.now()};
    }
    if (result.error) {
        return {state: 'error', items: [], error: String(result.error), at: Date.now()};
    }
    if (!result.supported) {
        return {
            state: 'error',
            items: [],
            error: '该服务商不在官方查询白名单（已内置 DeepSeek / OpenRouter / SiliconFlow）；其他服务商请选脚本模板',
            at: Date.now(),
        };
    }
    const items = (Array.isArray(result.items) ? result.items : []).map((item) => ({
        label: String((item && item.label) || ''),
        value: String((item && item.value) || ''),
        isValid: true,
        planName: '',
        invalidMessage: '',
        unit: '',
        extra: '',
    }));
    if (!items.length) {
        return {state: 'error', items: [], error: '响应中没有可展示的余额条目', at: Date.now()};
    }
    return {state: 'ok', items, at: Date.now()};
}

function usageErrorSnippet(body) {
    const text = String(body || '').trim();
    if (!text) return '';
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

// 沙箱脚本（prelude + 消息处理）。网络原语必须从**实例与原型链两层摘除**：
// WebIDL 把 fetch/XHR 等定义在 DedicatedWorkerGlobalScope.prototype 上，只写
// `self[name] = undefined` 是在 globalThis 建 own property 遮蔽，恶意脚本经
// `Object.getPrototypeOf(self).fetch` 能拿回原生函数（2026-11-19 审查在 Chromium
// 实测复现）。原型属性是 configurable 的，delete 生效；被摘引用不保留，用户代码
// 无法还原。prelude 先于消息处理运行，用户代码拿不到未摘除的窗口期。
// 返回值是字符串方便测试断言禁用表；实际由 Blob URL 加载。
export function buildUsageWorkerScript() {
    return [
        "'use strict';",
        "const _deny = (name) => {",
        "  try { delete self[name]; } catch (_) {}",
        "  try { self[name] = undefined; } catch (_) {}",
        "  const proto = Object.getPrototypeOf(self);",
        "  try { delete proto[name]; } catch (_) {}",
        "};",
        "['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','Worker',",
        " 'SharedWorker','indexedDB','open','caches','sendBeacon'].forEach(_deny);",
        "try {",
        "  navigator.sendBeacon = undefined;",
        "  delete Object.getPrototypeOf(navigator).sendBeacon;",
        "} catch (_) {}",
        'let _cfg = null;',
        'self.onmessage = (event) => {',
        '  const data = event.data || {};',
        '  try {',
        "    if (data.type === 'run') {",
        "      const cfg = new Function('return (' + data.code + ')')();",
        "      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('脚本顶层必须是对象字面量');",
        '      const req = cfg.request;',
        "      if (!req || typeof req !== 'object') throw new Error('缺少 request 配置');",
        "      if (typeof req.url !== 'string' || !req.url.trim()) throw new Error('缺少 request.url');",
        "      const url = req.url.trim().toLowerCase();",
        "      if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('request.url 必须以 http(s):// 开头');",
        '      const headers = {};',
        '      if (req.headers != null && typeof req.headers === \'object\') {',
        '        for (const [name, value] of Object.entries(req.headers)) {',
        "          if (typeof value !== 'string' && typeof value !== 'number') throw new Error('request.headers 的值必须是字符串');",
        '          headers[String(name)] = String(value);',
        '        }',
        '      }',
        '      let body = \'\';',
        '      if (req.body != null) body = typeof req.body === \'string\' ? req.body : JSON.stringify(req.body);',
        "      const method = typeof req.method === 'string' && req.method.trim() ? req.method.trim().toUpperCase() : 'GET';",
        "      self.postMessage({ type: 'request', request: { url: req.url.trim(), method, headers, body } });",
        "    } else if (data.type === 'response') {",
        "      if (!_cfg || typeof _cfg.extractor !== 'function') throw new Error('缺少 extractor 函数');",
        '      const resp = data.response || {};',
        '      let parsed = resp.body;',
        '      try { parsed = JSON.parse(resp.body); } catch (_) { /* 非 JSON 响应原样传字符串 */ }',
        '      const raw = _cfg.extractor(parsed);',
        '      let safe;',
        '      try { safe = JSON.parse(JSON.stringify(raw)); } catch (_) { throw new Error(\'extractor 返回值无法序列化（含函数或循环引用）\'); }',
        "      self.postMessage({ type: 'result', raw: safe });",
        '    }',
        "  } catch (err) { self.postMessage({ type: 'error', error: String((err && err.message) || err) }); }",
        '};',
    ].join('\n');
}

// 脚本 → 请求规格（发给 Go 哑通道的字段名与 aigen.HTTPSpec 对齐）。
export function buildUsageSpec(request, profile, usage) {
    const timeoutSec = Math.min(Math.max(Number(usage.timeoutSec) || 10, USAGE_TIMEOUT_MIN_SEC), USAGE_TIMEOUT_MAX_SEC);
    return {
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
        body: String(request.body || ''),
        proxy: String((profile && profile.proxy) || ''),
        timeoutSec,
        maxBytes: USAGE_RESPONSE_MAX_BYTES,
    };
}

// 查询节流：有缓存且未到 autoIntervalMin 视为新鲜（0 = 不自动查，只在手动时刷）。
export function usageStale(snapshot, intervalMin, now = Date.now()) {
    const interval = Number(intervalMin) || 0;
    if (interval <= 0) return !snapshot || !snapshot.at;
    if (!snapshot || !snapshot.at) return true;
    return (now - snapshot.at) >= interval * 60000;
}

export function formatUsageAmount(value, unit) {
    if (value === -1) return '∞';
    const text = Number(value).toFixed(2);
    return unit === '%' ? text + '%' : (text + (unit ? ' ' + unit : ''));
}

// 单条目的展示文案（余额行主句 + 弹层行共用）。
export function usageItemText(item) {
    if (!item) return '';
    if (item.isValid === false) return item.invalidMessage || '已失效';
    if (item.label && item.value) return item.label + ' ' + item.value;
    const unit = item.unit || '';
    if (Number.isFinite(item.remaining)) return '余额 ' + formatUsageAmount(item.remaining, unit);
    if (Number.isFinite(item.used)) return (item.planName ? item.planName + ' ' : '') + '已用 ' + formatUsageAmount(item.used, unit);
    if (Number.isFinite(item.total)) return (item.planName ? item.planName + ' ' : '') + '总额 ' + formatUsageAmount(item.total, unit);
    return item.planName || '';
}

// 余额行主句：脚本条目单套餐直显、多套餐报数；官方引擎的 label/value 明细行
//（总额/赠送/充值/账户可用）不算套餐——取第一条有信息量的行。
export function formatUsageHeadline(snapshot) {
    if (!snapshot) return '';
    if (snapshot.state === 'error') return snapshot.error || '查询失败';
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    if (!items.length) return '';
    const planShaped = items.some((item) =>
        item.planName || Number.isFinite(item.remaining) || Number.isFinite(item.used) || Number.isFinite(item.total));
    if (planShaped && items.length > 1) {
        const primary = items.find((item) => item.isValid !== false) || items[0];
        return items.length + ' 个套餐 · ' + usageItemText(primary);
    }
    if (planShaped) return usageItemText(items[0]);
    const official = items.find((item) => item.label && item.value && item.label !== '账户可用') || items[0];
    return official.label && official.value ? official.label + ' ' + official.value : usageItemText(official);
}

// 查询时间相对文案（data-tip 里给绝对时间）。
export function formatUsageAge(at, now) {
    if (!at) return '';
    const diff = Math.max(0, (now || Date.now()) - at);
    if (diff < 60000) return '刚刚查询';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前查询';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前查询';
    return Math.floor(diff / 86400000) + ' 天前查询';
}

// ── 快照存储（localStorage 只存展示数据）───────────────────────

function loadSnapshotStore(storage) {
    try {
        const raw = storage.getItem(USAGE_SNAPSHOT_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {}; // 损坏即弃：快照只是展示缓存，重新查询即可
    }
}

function saveSnapshotStore(storage, store) {
    try {
        storage.setItem(USAGE_SNAPSHOT_STORAGE_KEY, JSON.stringify(store));
    } catch (_) {
        // 尽力而为：隐私模式 / 配额满时静默放弃持久化，内存缓存仍然生效
    }
}

// ── 查询管线 ─────────────────────────────────────────────────

export function createAIUsageQuota(deps) {
    // deps.backend 是 getter（组合根约定）：求值兼容直接传对象（测试）与传 getter 两种形态
    const backend = () => (typeof deps.backend === 'function' ? deps.backend() : (deps.backend || null));
    // workerFactory：沙箱 Worker 的构造缝（默认真 Worker；node 测试环境没有 Worker，注入假件走同一消息协议）
    const makeWorker = typeof deps.workerFactory === 'function'
        ? deps.workerFactory
        : (url) => new Worker(url);
    const cache = new Map(); // profileId → snapshot（模块级活状态，getter 语义）
    const inflight = new Map(); // profileId → Promise（并发去重）
    let store = null; // localStorage 快照，首次用到时懒加载

    function ensureStore() {
        if (!store) {
            try {
                store = loadSnapshotStore(window.localStorage);
            } catch (_) {
                store = {};
            }
            for (const [id, snapshot] of Object.entries(store)) {
                if (!cache.has(id) && snapshot && typeof snapshot === 'object') cache.set(id, snapshot);
            }
        }
        return store;
    }

    function persist() {
        const target = ensureStore();
        for (const [id, snapshot] of cache.entries()) target[id] = snapshot;
        try {
            saveSnapshotStore(window.localStorage, target);
        } catch (_) {
            // window 不可用（测试环境）时静默放弃
        }
    }

    function peek(profileId) {
        ensureStore();
        return cache.get(profileId) || null;
    }

    function invalidate(profileId) {
        cache.delete(profileId);
        const target = ensureStore();
        delete target[profileId];
        try {
            saveSnapshotStore(window.localStorage, target);
        } catch (_) { /* 同上：尽力而为 */ }
    }

    function errorSnapshot(error) {
        return {state: 'error', items: [], error, at: Date.now()};
    }

    // 「官方」模板的查询入参：连接字段取账号，apiKey/baseUrl 允许覆盖。
    function officialQueryConfig(profile, usage) {
        return {
            baseURL: String(usage.baseUrl || (profile && profile.baseURL) || ''),
            apiKey: String(usage.apiKey || (profile && profile.apiKey) || ''),
            proxy: String((profile && profile.proxy) || ''),
            extraHeaders: (profile && profile.extraHeaders && typeof profile.extraHeaders === 'object')
                ? profile.extraHeaders : {},
        };
    }

    // host 是否在官方白名单（sweep 用来避免对白名单外账号反复自动查询）。
    function officialSupported(profile, usage) {
        const base = String(usage.baseUrl || (profile && profile.baseURL) || '');
        const match = base.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
        const hostport = match ? match[1] : base.split('/')[0];
        const at = hostport.lastIndexOf('@');
        let host = at >= 0 ? hostport.slice(at + 1) : hostport;
        const colon = host.lastIndexOf(':');
        if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
        host = host.toLowerCase();
        return OFFICIAL_USAGE_HOSTS.some((known) => host === known || host.endsWith('.' + known));
    }

    function usageVarsFor(profile, usage) {
        const vars = {
            baseUrl: String(usage.baseUrl || (profile && profile.baseURL) || ''),
            apiKey: String(usage.apiKey || (profile && profile.apiKey) || ''),
        };
        const extra = usage.extraFields && typeof usage.extraFields === 'object' ? usage.extraFields : {};
        for (const [key, value] of Object.entries(extra)) {
            vars[key] = String(value);
        }
        return vars;
    }

    // 沙箱单阶段通信：发消息 → 等对应回包，超时 terminate。
    function workerPhase(worker, message, wantType, phaseLabel) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(phaseLabel + '超时（沙箱已终止）'));
            }, USAGE_WORKER_TIMEOUT_MS);
            const onMessage = (event) => {
                const data = event.data || {};
                if (data.type === 'error') {
                    cleanup();
                    reject(new Error(data.error || '沙箱执行失败'));
                    return;
                }
                if (data.type !== wantType) return;
                cleanup();
                resolve(data);
            };
            const cleanup = () => {
                clearTimeout(timer);
                // 真 Worker 恒有 removeEventListener；测试假件可能只实现 addEventListener
                if (typeof worker.removeEventListener === 'function') {
                    worker.removeEventListener('message', onMessage);
                }
            };
            worker.addEventListener('message', onMessage);
            worker.postMessage(message);
        });
    }

    // 脚本模板查询：Worker 解析脚本 → request 出沙箱 → Go 发请求 → 响应回沙箱跑 extractor。
    async function runScriptQuery(profile, usage) {
        const backendRef = backend();
        if (!backendRef || typeof backendRef.AIUsageHTTPRequest !== 'function') {
            throw new Error('当前版本不支持脚本额度查询通道');
        }
        const code = String(usage.code || '').trim();
        if (!code) throw new Error('脚本是空的（先选模板或粘贴脚本）');
        if (code.length > USAGE_CODE_MAX_LENGTH) throw new Error('脚本超过 64KB 上限');
        const rendered = renderUsageVars(code, usageVarsFor(profile, usage));
        const blobURL = URL.createObjectURL(new Blob([buildUsageWorkerScript()], {type: 'text/javascript'}));
        let worker = null;
        try {
            // Worker 构造也可能同步抛（极端环境无 Worker 构造器），放进 try 才能保证 blob 释放
            worker = makeWorker(blobURL);
            const {request} = await workerPhase(worker, {type: 'run', code: rendered}, 'request', '脚本解析');
            const result = await backendRef.AIUsageHTTPRequest(JSON.stringify(buildUsageSpec(request, profile, usage)));
            if (!result || typeof result !== 'object') throw new Error('查询通道无返回');
            if (result.error && !result.status) throw new Error(result.error);
            if (Number(result.status) >= 400) {
                const snippet = usageErrorSnippet(result.body);
                throw new Error('HTTP ' + result.status + (snippet ? '：' + snippet : ''));
            }
            const extracted = await workerPhase(
                worker,
                {type: 'response', response: {status: result.status, body: String(result.body || '')}},
                'result',
                '响应提取',
            );
            return normalizeUsageResult(extracted.raw);
        } finally {
            if (worker) worker.terminate();
            URL.revokeObjectURL(blobURL);
        }
    }

    async function runQuery(profile, usage) {
        if (!profile || !usage.enabled) return errorSnapshot('用量查询未启用');
        try {
            if (usage.template === 'official') {
                const backendRef = backend();
                if (!backendRef || typeof backendRef.AIUsageQuery !== 'function') {
                    return errorSnapshot('当前版本不支持官方用量查询');
                }
                return officialSnapshotFromResult(await backendRef.AIUsageQuery(officialQueryConfig(profile, usage)));
            }
            if (usage.template !== 'custom' && !usageTemplatePresetCode(usage.template, usage.planProvider)) {
                return errorSnapshot('模板预设缺失');
            }
            // 预设模板的脚本运行时取自预设表（修正随版本走，不落盘）；自定义用 code 本体
            const code = usage.template === 'custom'
                ? usage.code
                : usageTemplatePresetCode(usage.template, usage.planProvider);
            const norm = await runScriptQuery(profile, {...usage, code});
            if (norm.error) return errorSnapshot(norm.error);
            return {state: 'ok', items: norm.items, at: Date.now()};
        } catch (err) {
            return errorSnapshot((err && err.message) || String(err));
        }
    }

    // 查询一个账号（结果写缓存，绝不 throw——失败也是 snapshot）。force 绕过节流。
    async function queryAccountUsage(profile, opts = {}) {
        const id = profile && profile.id;
        const usage = normalizeUsageConfig(profile && profile.usage);
        if (!id) return errorSnapshot('账号无效');
        ensureStore();
        if (!opts.force) {
            const cached = cache.get(id);
            if (!usageStale(cached, usage.autoIntervalMin, Date.now())) return cached;
        }
        const pending = inflight.get(id);
        if (pending) return pending;
        const job = runQuery(profile, usage).finally(() => inflight.delete(id));
        inflight.set(id, job);
        const snapshot = await job;
        cache.set(id, snapshot);
        persist();
        return snapshot;
    }

    // 弹窗「测试脚本」：同一条管线但不写缓存。
    async function testConfig(profile, usageDraft) {
        const usage = normalizeUsageConfig(usageDraft);
        return runQuery(profile, usage);
    }

    // 卡片自动刷新：对开启查询且过期的账号并发补查，批完回调一次（触发重渲染）。
    // 白名单外的「官方」模板不打扰（查了也只得到不支持文案）。
    function sweep(profiles, onChange) {
        const now = Date.now();
        const jobs = [];
        for (const profile of profiles || []) {
            const usage = normalizeUsageConfig(profile && profile.usage);
            if (!usage.enabled || inflight.has(profile.id)) continue;
            if (usage.template === 'official' && !officialSupported(profile, usage)) continue;
            if (!usageStale(peek(profile.id), usage.autoIntervalMin, now)) continue;
            jobs.push(queryAccountUsage(profile));
        }
        if (!jobs.length) return;
        Promise.all(jobs).then(() => {
            if (typeof onChange === 'function') onChange();
        });
    }

    return {queryAccountUsage, testConfig, peek, invalidate, sweep};
}
