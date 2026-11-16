// ai-gen-model.js：生图/视频模型（config.genModels[]）数据层与通用输入输出模板（纯函数，无 DOM 依赖，可单测）。
// 各家生图/视频接口不一：请求体模板 + 响应提取路径把差异吸收进配置（docs/unfinished-plans/ai-gen-models.md §3.1）。
// 约定：占位符一律渲染为 JSON 字面量（bodyTemplate 里不手写引号，prompt 内容无法破坏 JSON 结构）；
// headers / 轮询 URL 用纯文本替换（renderGenText）。方案细节见该文档 §3.1-§3.3。

export const GEN_KINDS = ['image', 'video'];
export const GEN_KIND_LABELS = {image: '生图', video: '视频'};

// 请求体模板的合法占位符（未知占位符在渲染时抛错，防拼写错误把参数悄悄丢掉）。
// images：参考图清单（{{images}} 渲染为 JSON 数组字面量，见 renderGenImages）。
export const GEN_PLACEHOLDERS = ['prompt', 'model', 'size', 'n', 'seed', 'apiKey', 'jobId', 'images'];

// 参考图（图生图 / edits）边界：JSON-body 的 edits 接口普遍 ≤5 张，单张 4MB 是
// base64 膨胀（×1.33）与 Wails IPC 单字符串体积的折中（5 张 ≈ 27MB，仍可一次投递）。
export const GEN_REF_LIMIT = 5;
export const GEN_REF_BYTES_LIMIT = 4 << 20;
export const GEN_IMAGE_WRAP_DEFAULT = 'image_url';

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
        // 图生图 / 编辑端点（同步型 JSON body）：带参考图时替代 path；空 = 该条目不支持参考图
        editPath: String(source.editPath || '').trim(),
        // 参考图字段名：JSON 模式是数组元素的字段名（缺省 image_url）；multipart 模式是文件字段名
        // （缺省 image——Qwen-Image / OpenAI 官方都用 image）。
        editImageWrap: (source.editImageWrap === undefined || source.editImageWrap === null)
            ? (source.editFormat === 'multipart' ? 'image' : GEN_IMAGE_WRAP_DEFAULT)
            : String(source.editImageWrap).trim(),
        // 编辑端点的请求体格式：json（默认，多数服务商）/ multipart（Qwen-Image、OpenAI 官方
        // /v1/images/edits 这类 FormData 接口——图片走独立的 image 文件字段，不是 JSON 里的数组）
        editFormat: source.editFormat === 'multipart' ? 'multipart' : 'json',
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
        // 探针端点（可选，支持 {{jobId}}）：有的服务端任务完成后响应里只有本机文件路径、
        // 没有可下载地址（url 为空），产物要走独立端点；配了它就多一条「2xx 即完成」的判定。
        // 配了它就多一条「2xx 即视为完成」的判定，产物直接用该 URL 下载。
        probePath: String(source.probePath || '').trim(),
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
        // 参考图只存路径 / URL 摘要，不存 Data URL 本体（会话 JSONL 会被 base64 撑爆）；
        // 卡片重绘时按路径现读缩略图。
        references: (Array.isArray(source.references) ? source.references : [])
            .map((item) => String(item == null ? '' : item))
            .filter(Boolean)
            .slice(0, GEN_REF_LIMIT),
    };
}

// ---------- 参考图（图生图 / edits） ----------

// 参考图元素分类：
// - url：http(s) 图片地址，原样交给服务商拉取（不代用户下载，域名也不单过 web 规则）；
// - path：本地图片路径（相对工作区或已授权的绝对路径），由调用方走 read_file 授权链读成 Data URL；
// - invalid：data: / file: / ftp: 等——data URL 会绕开文件授权与体积预算，file: 在服务商侧无意义；
// - empty：空字符串（丢弃）。
export function classifyGenRef(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return {kind: 'empty', value: ''};
    if (/^https?:\/\//i.test(text)) return {kind: 'url', value: text};
    // Windows 盘符（D:\ / D:/）不是协议：先排除再看「带协议的字符串」
    if (!/^[A-Za-z]:[\\/]/.test(text) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return {kind: 'invalid', value: text};
    return {kind: 'path', value: text};
}

// 参考图清单 → {{images}} 的 JSON 数组字面量。包装字段名由条目的 editImageWrap 决定：
// 非空 → [{"image_url":"…"},…]；空 → ["…",…]。字段名严格校验（拼错会让服务端静默忽略参考图）。
export function renderGenImages(values, wrap) {
    const list = (Array.isArray(values) ? values : []).map((item) => String(item == null ? '' : item));
    const key = wrap === undefined || wrap === null ? GEN_IMAGE_WRAP_DEFAULT : String(wrap).trim();
    if (!key) return JSON.stringify(list);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new Error('参考图包装字段名无效：' + key);
    return JSON.stringify(list.map((value) => ({[key]: value})));
}

// Data URL 的原始字节数（base64 段长度 × 3/4，够做上限判断；不解析 mime）。
export function dataURLBytes(dataURL) {
    const text = String(dataURL || '');
    const idx = text.indexOf('base64,');
    if (idx < 0) return 0;
    return Math.floor(text.slice(idx + 7).replace(/\s+/g, '').length * 3 / 4);
}

// 带参考图时该走哪个端点：配了 editPath 即走编辑端点，否则回生成端点（缺 editPath 由调用方报错）。
export function genRequestPath(entry, params) {
    if (!entry) return '';
    const refs = params && Array.isArray(params.references) ? params.references : [];
    if (refs.length && entry.editPath) return entry.editPath;
    return entry.path || '';
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
        // {{images}} 已经是渲染好的 JSON 数组字面量（renderGenImages），不能再包一层引号
        if (token === 'images') return String((vars && vars.images) || '[]');
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

// 产物值提取：extractGenPath 在末段是 null 时会返回 [null]（长度 1），若直接当「已取到产物」
// 就会拿 "null" 去下载。服务端常用 url:null + 独立下载端点表示「产物在别处」，这类空值必须滤掉。
export function extractGenProducts(data, path) {
    return extractGenPath(data, path)
        .filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
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
        // 参考图由调用方先解析成 Data URL / URL（params.references），这里只负责渲染成字面量
        images: renderGenImages(source.references, entry.editImageWrap),
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

// ---------- multipart/form-data 请求体（二进制编辑端点） ----------
// Qwen-Image / OpenAI 官方 /v1/images/edits 收 FormData：普通参数是文本字段，
// 参考图是同名字段（editImageWrap，缺省 image）重复多个**文件**段。
// multipart 模式下模板被当作「文本字段来源」：渲染后 JSON 的每个键值转成一个表单字段
// （images 例外——参考图只从 references 来，模板里写了也不读）。
// 返回 {bodyBase64, contentType, bytes}：body 含图片原始字节，JSON 传不了二进制，故 base64 交 Go 解码。

const GEN_MULTIPART_DEFAULT_IMAGE_FIELD = 'image';

function genBytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function genTextBytes(text) {
    return new TextEncoder().encode(String(text));
}

// Data URL → {mime, bytes}；非 Data URL（http/https 等）返回 null（multipart 需要真实字节）。
function genDataURLBytesOf(value) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(value || '').trim());
    if (!match) return null;
    const binary = atob(match[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return {mime: match[1].toLowerCase(), bytes};
}

export function buildGenMultipart(entry, vars, refs, options) {
    const list = Array.isArray(refs) ? refs : [];
    if (!list.length) throw new Error('multipart 编辑端点需要至少一张参考图');
    const boundary = String((options && options.boundary) || '').trim() ||
        '----CaDtDataLensBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const imageField = String((entry && entry.editImageWrap) || '').trim() || GEN_MULTIPART_DEFAULT_IMAGE_FIELD;

    // 1) 模板 → 文本字段（images 跳过：参考图只从 references 来）
    const rendered = renderGenJson((entry && entry.bodyTemplate) || '', vars);
    let fields;
    try {
        fields = JSON.parse(rendered);
    } catch (e) {
        throw new Error('multipart 模式下请求体模板必须是合法 JSON 对象（用于生成表单字段）：' + ((e && e.message) || e));
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error('multipart 模式下请求体模板必须是 JSON 对象');
    }

    const parts = [];
    const pushText = (name, text) => {
        parts.push(genTextBytes('--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' + text + '\r\n'));
    };
    for (const key of Object.keys(fields)) {
        if (key === 'images') continue;
        const value = fields[key];
        if (value === undefined || value === null) continue;
        pushText(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }

    // 2) 参考图 → 文件段（同名字段重复，服务端按重复次数收多参考图）
    list.forEach((ref, index) => {
        const parsed = genDataURLBytesOf(ref);
        if (!parsed) {
            throw new Error('multipart 编辑端点需要本地图片（当前第 ' + (index + 1) + ' 张是 URL）；' +
                'URL 参考图请改用本地文件，或换回 JSON 型编辑端点');
        }
        const ext = genExtFor(parsed.mime, 'image');
        const filename = 'ref-' + (index + 1) + '.' + ext;
        parts.push(genTextBytes('--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + imageField + '"; filename="' + filename + '"\r\n' +
            'Content-Type: ' + parsed.mime + '\r\n\r\n'));
        parts.push(parsed.bytes);
        parts.push(genTextBytes('\r\n'));
    });

    parts.push(genTextBytes('--' + boundary + '--\r\n'));

    // 3) 拼接字节
    let total = 0;
    for (const part of parts) total += part.length;
    const body = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        body.set(part, offset);
        offset += part.length;
    }
    return {
        bodyBase64: genBytesToBase64(body),
        contentType: 'multipart/form-data; boundary=' + boundary,
        bytes: total,
    };
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
