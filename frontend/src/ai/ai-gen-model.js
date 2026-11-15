// ai-gen-model.js：生图/视频模型（config.genModels[]）数据层与通用输入输出模板（纯函数，无 DOM 依赖，可单测）。
// 各家生图/视频接口不一：请求体模板 + 响应提取路径把差异吸收进配置（docs/unfinished-plans/ai-gen-models.md §3.1）。
// 约定：占位符一律渲染为 JSON 字面量（bodyTemplate 里不手写引号，prompt 内容无法破坏 JSON 结构）；
// headers / 轮询 URL 用纯文本替换（renderGenText）。方案细节见该文档 §3.1-§3.3。

export const GEN_KINDS = ['image', 'video'];
export const GEN_KIND_LABELS = {image: '生图', video: '视频'};

// 请求体模板的合法占位符（未知占位符在渲染时抛错，防拼写错误把参数悄悄丢掉）。
export const GEN_PLACEHOLDERS = ['prompt', 'model', 'size', 'n', 'seed', 'apiKey', 'jobId'];

export const GEN_BODY_LIMIT = 64 << 20;      // 响应体上限（含内嵌 b64 的 JSON）
export const GEN_IMAGE_LIMIT = 25 << 20;     // 单张图片落盘上限
export const GEN_VIDEO_LIMIT = 220 << 20;    // 单个视频落盘上限

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// headers 归一为 [{key, value}]：接受 [{key,value}] / {k:v} / "K: V" 行文本三种形态，丢弃空键与换行。
export function normalizeGenHeaders(raw) {
    const out = [];
    const push = (key, value) => {
        key = String(key || '').trim().replace(/[\r\n]+/g, '');
        value = String(value == null ? '' : value).trim().replace(/[\r\n]+/g, '');
        if (!key || out.length >= 16) return;
        if (out.some((item) => item.key.toLowerCase() === key.toLowerCase())) return;
        out.push({key, value});
    };
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (item && typeof item === 'object') push(item.key, item.value);
        }
    } else if (raw && typeof raw === 'object') {
        for (const key of Object.keys(raw)) push(key, raw[key]);
    } else if (typeof raw === 'string') {
        for (const line of raw.split(/\r?\n/)) {
            const idx = line.indexOf(':');
            if (idx > 0) push(line.slice(0, idx), line.slice(idx + 1));
        }
    }
    return out;
}

function isProxyMode(value) {
    return ['system', 'direct'].includes(value) || /^(https?|socks5):\/\//i.test(String(value || ''));
}

export function normalizeGenModel(raw, idGen) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        id: String(source.id || '').trim() || (idGen ? idGen() : 'gen-' + Date.now().toString(36)),
        name: String(source.name || '').trim(),
        kind: GEN_KINDS.includes(source.kind) ? source.kind : 'image',
        enabled: source.enabled !== false,
        baseURL: String(source.baseURL || '').trim(),
        path: String(source.path || '').trim(),
        proxy: isProxyMode(source.proxy) ? source.proxy : 'system',
        timeoutSec: clampInt(source.timeoutSec, 30, 300, 120),
        apiKey: String(source.apiKey || ''),
        headers: normalizeGenHeaders(source.headers),
        bodyTemplate: String(source.bodyTemplate || ''),
        resultType: source.resultType === 'url' ? 'url' : 'b64',
        resultPath: String(source.resultPath || '').trim(),
        errorPath: String(source.errorPath || '').trim(),
        defaultModel: String(source.defaultModel || '').trim(),
        defaultSize: String(source.defaultSize || '').trim(),
        defaultN: clampInt(source.defaultN, 1, 4, 1),
        // 异步任务（submitPath 非空即视为异步型；image/video 共用同一套 submit/poll 引擎）
        submitPath: String(source.submitPath || '').trim(),
        jobIdPath: String(source.jobIdPath || '').trim(),
        pollPath: String(source.pollPath || '').trim(),
        statusPath: String(source.statusPath || '').trim(),
        doneValue: String(source.doneValue || '').trim(),
        failedValue: String(source.failedValue || '').trim(),
        pollIntervalSec: clampInt(source.pollIntervalSec, 2, 30, 5),
        maxPolls: clampInt(source.maxPolls, 1, 240, 60),
    };
}

// genModels[] 归一：过滤非对象项、按 id 去重（后到者让位），空输入给空数组（缺字段即默认态，零迁移）。
export function normalizeGenModels(list, idGen) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = normalizeGenModel(raw, idGen);
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }
    return out;
}

// 缺省条目：该产物类型下第一个启用的条目。
export function defaultGenModelOf(list, kind) {
    return (Array.isArray(list) ? list : []).find((entry) => entry && entry.kind === kind && entry.enabled !== false) || null;
}

// 列表里的优先级顺序 = 同类型条目在 genModels[] 里的先后（defaultGenModelOf 取第一个启用的）。
// 设置页把生图/视频分两组展示，组内的「上移 / 下移」因此只能交换**同类型的槽位**：
// 若整体重排，把一个视频条目挪到两条生图之间会悄悄改掉视频组的顺序，用户看不见。
// 返回新数组；找不到条目、delta 为 0 或已到组边界时原样返回同一个引用（调用方据此跳过落盘）。
export function moveGenModelWithinKind(list, id, delta) {
    const arr = Array.isArray(list) ? list : [];
    const step = Math.sign(Number(delta) || 0);
    const index = arr.findIndex((entry) => entry && entry.id === id);
    if (index < 0 || !step) return arr;
    const kind = arr[index].kind;
    const slots = [];
    arr.forEach((entry, i) => { if (entry && entry.kind === kind) slots.push(i); });
    const pos = slots.indexOf(index);
    const next = pos + step;
    if (pos < 0 || next < 0 || next >= slots.length) return arr;
    // slots 是「同类型条目占用的数组槽位」，order 是槽位的新排布：只在这几个槽位里换人。
    const order = slots.slice();
    order.splice(pos, 1);
    order.splice(next, 0, index);
    const out = arr.slice();
    slots.forEach((slot, i) => { out[slot] = arr[order[i]]; });
    return out;
}

// 工具参数 model 的解析：按 id 或名称精确匹配（同类型且启用）。ref 非空但没命中时返回 null
//（调用方报错让模型改参数——静默回落会「要 A 花 B 的钱」）；空 ref 回落缺省条目。
export function genModelByRef(list, kind, ref) {
    const key = String(ref || '').trim().toLowerCase();
    if (!key) return defaultGenModelOf(list, kind);
    return (Array.isArray(list) ? list : []).find((entry) => entry && entry.kind === kind &&
        entry.enabled !== false && (entry.id.toLowerCase() === key || entry.name.toLowerCase() === key)) || null;
}

// AI / 外部来源的条目合并（set_gen_model 桥）：部分更新语义——incoming 的字段覆盖 existing，
// 未传的字段沿用 existing（AI 可以只改一处而不重发全量）；唯独 apiKey 永远取 existing 的
// ——AI 不可写密钥：新建留空给用户填，已填的不会被冲掉。existing 命中时沿用其 id。
export function mergeGenModelEntry(existing, incoming, idGen) {
    const source = incoming && typeof incoming === 'object' ? incoming : {};
    const merged = normalizeGenModel({
        ...(existing || {}),
        ...source,
        id: (existing && existing.id) || source.id || '',
    }, idGen);
    merged.apiKey = (existing && existing.apiKey) || '';
    return merged;
}

// 该条目是否为异步型（配了提交端点即走 submit/poll 引擎）。
export function isAsyncGenModel(entry) {
    return !!(entry && entry.submitPath && entry.jobIdPath && entry.pollPath);
}

// 工具消息侧数据 toolMessage.gen 的归一（随会话 JSONL 持久化，重放后照常渲染）；
// 运行中状态在重启后由调用方收敛为失败（轮询循环不跨重启）。
export function normalizeGenSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const files = (Array.isArray(source.files) ? source.files : [])
        .map((file) => (file && typeof file === 'object')
            ? {path: String(file.path || ''), bytes: Number(file.bytes) || 0, mime: String(file.mime || '')}
            : null)
        .filter(Boolean);
    return {
        jobId: String(source.jobId || ''),
        kind: GEN_KINDS.includes(source.kind) ? source.kind : 'image',
        entryName: String(source.entryName || ''),
        status: ['running', 'done', 'failed', 'stopped'].includes(source.status) ? source.status : 'failed',
        progressText: String(source.progressText || ''),
        error: String(source.error || ''),
        files,
    };
}

// ---------- 模板渲染 ----------

function jsonLiteralOf(value) {
    if (value === undefined || value === null) return 'null';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return JSON.stringify(String(value));
}

// 请求体模板渲染：占位符替换为 JSON 字面量（字符串带引号转义、数字/布尔裸值、缺参 null）。
// 未知占位符抛错（防 {{promt}} 这类拼写错误静默丢参数）；同一占位符可出现多次。
export function renderGenJson(template, vars) {
    const source = String(template || '');
    if (!source.trim()) throw new Error('请求体模板为空');
    return source.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (raw, token) => {
        if (!GEN_PLACEHOLDERS.includes(token)) {
            throw new Error('请求体模板含未知占位符 {{' + token + '}}（可用：' + GEN_PLACEHOLDERS.join(' / ') + '）');
        }
        return jsonLiteralOf(vars ? vars[token] : undefined);
    });
}

// 纯文本渲染（headers 值 / 轮询 URL）：占位符替换为原文字符串，缺参留空；未知占位符同样抛错。
export function renderGenText(template, vars) {
    return String(template || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (raw, token) => {
        if (!GEN_PLACEHOLDERS.includes(token)) {
            throw new Error('模板含未知占位符 {{' + token + '}}（可用：' + GEN_PLACEHOLDERS.join(' / ') + '）');
        }
        const value = vars ? vars[token] : undefined;
        return value === undefined || value === null ? '' : String(value);
    });
}

// ---------- 响应提取（手写点路径，不引 JSONPath 库） ----------

// 语法：a.b.c（对象属性）/ data[0]（数组下标）/ data[*]（数组全部）；空路径返回整个值。
// 返回值恒为数组（[*] 展开多值、普通路径取单值），路径走不通时为空数组。
// 语法错误整条前置校验（与数据无关、报错确定性），行走不到给空数组。
export function extractGenPath(data, path) {
    const text = String(path || '').trim();
    if (!text) return [data];
    const segs = [];
    for (const rawSeg of text.split('.')) {
        const match = rawSeg.trim().match(/^([A-Za-z0-9_-]+)(\[\s*(\d+|\*)\s*\])?$/);
        if (!match) throw new Error('提取路径语法无效：' + text);
        segs.push({name: match[1], index: match[3]});
    }
    let current = data;
    for (const {name, index} of segs) {
        if (current == null) return [];
        if (Array.isArray(current)) {
            // [*] 展开后再取字段：逐项取值并滤掉缺失项（部分元素缺字段时只收有值的）
            current = current
                .map((item) => (item && typeof item === 'object') ? item[name] : undefined)
                .filter((item) => item !== undefined);
        } else if (current && typeof current === 'object') {
            current = current[name];
        } else {
            return [];
        }
        if (index !== undefined) {
            if (index === '*') {
                current = Array.isArray(current) ? current : (current == null ? [] : [current]);
            } else if (Array.isArray(current)) {
                current = current[Number(index)];
            } else {
                return [];
            }
        }
        if (current === undefined) return [];
    }
    // 末段落在数组（[*] 或值本身是数组）时原样返回多值，否则包成单值数组
    return Array.isArray(current) ? current : [current];
}

// mime → 扩展名（落盘命名用）；未知 mime 按产物类型给缺省扩展名。
export function genExtFor(mime, kind) {
    const text = String(mime || '').toLowerCase();
    const table = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
        'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-msvideo': 'avi', 'video/quicktime': 'mov'};
    if (table[text]) return table[text];
    const main = text.split('/')[0];
    if (main === 'image') return 'png';
    if (main === 'video') return 'mp4';
    return kind === 'video' ? 'mp4' : 'png';
}

// ---------- 请求组装（运行时与设置页「测试连接」共用） ----------

export const GEN_PROMPT_LIMIT = 8000;

// baseURL + path 拼接；path 已是完整 URL（本地服务回调等）时原样使用。
export function genJoinURL(base, path) {
    const b = String(base || '').trim().replace(/\/+$/, '');
    const p = String(path || '').trim();
    if (!p) return b;
    if (/^https?:\/\//i.test(p)) return p;
    if (!b) return p;
    return b + (p.startsWith('/') ? '' : '/') + p;
}

// 工具参数 + 条目缺省值合并成占位符词表；n/seed 归一为数字（缺省 seed 渲染为 null）。
export function buildGenVars(entry, params) {
    const source = params && typeof params === 'object' ? params : {};
    const prompt = String(source.prompt || '').trim();
    if (!prompt) throw new Error('生成提示词（prompt）为空');
    if (prompt.length > GEN_PROMPT_LIMIT) throw new Error('生成提示词超过 ' + GEN_PROMPT_LIMIT + ' 字符上限');
    const seedRaw = source.seed;
    const seed = seedRaw === undefined || seedRaw === null || seedRaw === '' ? null : Number(seedRaw);
    return {
        prompt,
        model: String(source.model || entry.defaultModel || ''),
        size: String(source.size || entry.defaultSize || ''),
        n: Math.max(1, Math.min(4, Math.round(Number(source.n) || entry.defaultN || 1))),
        seed: seed !== null && Number.isFinite(seed) ? seed : null,
        apiKey: String(entry.apiKey || ''),
        jobId: String(source.jobId || ''),
    };
}

// headers 归一表渲染成请求头对象（值走纯文本替换，{{apiKey}} 等占位符落地）。
export function genHeaderMap(entry, vars) {
    const out = {};
    for (const item of (entry && entry.headers) || []) {
        out[item.key] = renderGenText(item.value, vars);
    }
    return out;
}

// ---------- 内置预设（初始值，不锁定；用户选后微调） ----------

export const GEN_MODEL_PRESETS = [
    {
        key: 'openai-b64',
        name: 'OpenAI 兼容 · b64 返回（OpenAI / SiliconFlow 等）',
        kind: 'image',
        entry: {
            name: '生图 · OpenAI 兼容',
            kind: 'image',
            path: '/v1/images/generations',
            headers: [{key: 'Authorization', value: 'Bearer {{apiKey}}'}, {key: 'Content-Type', value: 'application/json'}],
            bodyTemplate: '{"model":{{model}},"prompt":{{prompt}},"size":{{size}},"n":{{n}},"response_format":"b64_json"}',
            resultType: 'b64',
            resultPath: 'data[*].b64_json',
            errorPath: 'error.message',
            defaultSize: '1024x1024',
        },
    },
    {
        key: 'openai-url',
        name: 'OpenAI 兼容 · URL 返回',
        kind: 'image',
        entry: {
            name: '生图 · OpenAI 兼容 URL',
            kind: 'image',
            path: '/v1/images/generations',
            headers: [{key: 'Authorization', value: 'Bearer {{apiKey}}'}, {key: 'Content-Type', value: 'application/json'}],
            bodyTemplate: '{"model":{{model}},"prompt":{{prompt}},"size":{{size}},"n":{{n}},"response_format":"url"}',
            resultType: 'url',
            resultPath: 'data[*].url',
            errorPath: 'error.message',
            defaultSize: '1024x1024',
        },
    },
    {
        key: 'custom',
        name: '自定义（空白模板）',
        kind: 'image',
        entry: {
            name: '',
            kind: 'image',
            headers: [{key: 'Content-Type', value: 'application/json'}],
            bodyTemplate: '{"prompt":{{prompt}}}',
            resultType: 'b64',
            resultPath: '',
        },
    },
];
