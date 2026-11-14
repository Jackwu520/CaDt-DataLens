// ai-local-classifier.js：端侧命令分类器（内置线性模型 + 插件分类器聚合）。
// 纯函数部分（哈希特征化 / 推理 / 阈值判定 / SGD）无 DOM 依赖——
// scripts/train-local-classifier.mjs 直接 import 本文件，保证训练与推理是同一套特征算法；
// 权重产物 local-classifier-weights.mjs 由训练脚本生成（勿手改），按需动态 import（不进主包）。
// 安全边界（方案 §10）：端侧模型只产出危险概率 score、无 deny 权；判定统一按严格度阈值
// 转 allow/ask（ai-permissions.js），失败 / 低置信一律交回调用方回退远程分类器或人工。
import {
    LOCAL_CLASSIFIER_FAIL_LIMIT,
    judgeLocalClassifier,
    localClassifierThreshold,
    normalizeLocalClassifierStrictness,
} from './ai-permissions.js';

// 特征配置：必须与 local-classifier-weights.mjs 的记录一致，改动任何一处都要重跑训练脚本。
export const LC_FEATURES = {
    dims: 8192,      // 哈希特征空间维度
    ngrams: [3, 5],  // 字符 n-gram 长度
    seed: 6447741,   // FNV-1a 哈希种子（固定，保证训练/推理/测试同源）
};

const LC_BUCKET_SEED = (LC_FEATURES.seed ^ 0x9e3779b9) >>> 0;
const LC_TEXT_LIMIT = 2000;

// FNV-1a 32 位哈希（带种子）。质量对 8192 维哈希特征足够，速度优先。
export function lcHash(text, seed) {
    let h = (seed >>> 0) ^ 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// 命令 → 去重特征维度列表（升序，保证同命令特征顺序稳定、SGD 可复现）。
// 字符 3/5-gram + 结构桶（首词 / 子命令 / 管道落地 shell / 重定向 / 设备路径 /
// 子 shell 求值 / 链式调用 / base64 编码载荷），桶以带前缀的字符串进同一哈希空间。
export function lcExtractDims(command, cfg) {
    const c = cfg || LC_FEATURES;
    const text = String(command || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, LC_TEXT_LIMIT);
    if (!text) return [];
    const set = new Set();
    for (const n of c.ngrams) {
        for (let i = 0; i + n <= text.length; i += 1) {
            set.add(lcHash(text.slice(i, i + n), c.seed) % c.dims);
        }
    }
    const tokens = text.split(' ');
    const buckets = [];
    if (tokens[0]) buckets.push('w:' + tokens[0]);
    if (tokens[1]) buckets.push('c:' + tokens[1]);
    // 首词对（git status / npm install 这类两词组合是判定主信号，
    // 单靠字符 n-gram 会被同前缀的近邻命令族稀释，如 git stash ↔ git status）
    if (tokens[0] && tokens[1]) buckets.push('p:' + tokens[0] + ' ' + tokens[1]);
    // 裸命令桶：无任何参数/路径的单 token 命令（pwd / ls / cd）——
    // 这类命令特征极少、score 逼近 bias 基线，靠桶让裸命令类先验单独成维（公开语料 eval 发现 pwd/ls 误拦）
    if (tokens.length === 1) buckets.push('bare');
    if (/\|\s*(sh|bash|zsh|ksh|pwsh|powershell)\b/.test(text)) buckets.push('pipe:sh');
    // 管道落地系统/磁盘工具（echo x | diskpart 形态——词面全是安全词，靠桶兜住）
    if (/\|\s*(diskpart|reg|regedit|sc|bcdedit|bootrec|format|mkfs\S*|dd|fdisk|sfdisk|parted|wipefs|shred|cipher|sdelete|vssadmin)\b/.test(text)) buckets.push('pipe:danger');
    if (/\$\(|`|\biex\b|invoke-expression/.test(text)) buckets.push('subshell:eval');
    if (text.includes('>>')) buckets.push('redir:append');
    else if (text.includes('>')) buckets.push('redir:out');
    if (/\/dev\/(sd|nvme|hd|disk|mapper)|physicaldrive/.test(text)) buckets.push('path:device');
    if (/&&|;|\|/.test(text)) buckets.push('chain');
    if (/-enc(odedcommand)?\b|frombase64|\bbase64\b/.test(text)) buckets.push('payload:encoded');
    for (const bucket of buckets) {
        set.add(lcHash(bucket, LC_BUCKET_SEED) % c.dims);
    }
    return [...set].sort((a, b) => a - b);
}

// base64（Node 无 atob、浏览器无 Buffer，双路径）→ 字节数组。
function lcBase64Decode(b64) {
    if (typeof atob === 'function') {
        const raw = atob(String(b64 || ''));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        return bytes;
    }
    return Uint8Array.from(Buffer.from(String(b64 || ''), 'base64'));
}

// int8 量化权重（base64 密集存储，scale 缩放）→ 活动权重 Float32Array。
export function lcDequantize(b64, scale, dims) {
    const bytes = lcBase64Decode(b64);
    const out = new Float32Array(dims);
    const s = Number(scale) || 0;
    for (let i = 0; i < dims && i < bytes.length; i += 1) {
        out[i] = (bytes[i] < 128 ? bytes[i] : bytes[i] - 256) * s;
    }
    return out;
}

// 危险概率：σ(bias + Σ w·x)。x 为 0/1 出现特征（dims 数组）。
export function lcScore(dims, weights, bias) {
    let z = Number(bias) || 0;
    for (const d of dims) z += weights[d] || 0;
    return 1 / (1 + Math.exp(-z));
}

// 单样本 SGD + L2 锚定出厂权重（个性化有界不漂移）：梯度 g = p − y，
// 权重原地更新，偏置返回新值。dims 需为该样本出现（非零）特征维度。
export function lcSgdStep(dims, weights, factory, bias, y, lr, l2) {
    const p = lcScore(dims, weights, bias);
    const g = p - y;
    for (const d of dims) {
        const w = weights[d] || 0;
        weights[d] = w - lr * (g + l2 * (w - (factory[d] || 0)));
    }
    return {bias: bias - lr * g, p};
}

// 多 epoch 批量重训：从出厂权重重放全部样本（个性化重训入口）。样本顺序固定，可复现。
export function lcRetrain(samples, factory, bias, opts) {
    const weights = factory.slice();
    let currentBias = bias;
    let lr = opts.lr;
    for (let epoch = 0; epoch < opts.epochs; epoch += 1) {
        for (const sample of samples) {
            currentBias = lcSgdStep(sample.dims, weights, factory, currentBias, sample.y, lr, opts.l2).bias;
        }
        lr *= opts.decay;
    }
    return {weights, bias: currentBias};
}

// 活动权重相对出厂的非零 delta（稀疏存储形态：{维度: 修正量}）。
export function lcWeightsDelta(weights, factory) {
    const delta = {};
    for (let i = 0; i < weights.length; i += 1) {
        const diff = weights[i] - factory[i];
        if (Math.abs(diff) > 1e-9) delta[i] = Number(diff.toFixed(6));
    }
    return delta;
}

// 稀疏 delta 叠加到活动权重（非法维度忽略）。
export function lcApplyDelta(weights, delta) {
    if (!delta || typeof delta !== 'object') return;
    for (const key of Object.keys(delta)) {
        const dim = Number(key);
        const value = Number(delta[key]);
        if (Number.isInteger(dim) && dim >= 0 && dim < weights.length && Number.isFinite(value)) {
            weights[dim] += value;
        }
    }
}

// 命令文本脱敏（样本落盘前）：常见秘密赋值打码 + 空白归一 + 截断。
// 与 activity-log 的键级脱敏互补（这里是字符串内联形态），不存密钥与敏感参数。
export function lcSanitizeCommand(text, limit) {
    const max = Number(limit) > 0 ? Number(limit) : 300;
    let out = String(text == null ? '' : text);
    // 先打键值形态：api_key=xxx / --token xxx / Authorization: Bearer xxx（冒号、等号、空格分隔都覆盖），
    // Bearer 前缀原样保留只打令牌本体
    out = out.replace(
        /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|credential)(\s*[=:]\s*|\s+)(["']?)(bearer\s+)?[^\s"']+\3/gi,
        (match, key, sep, quote, bearerPrefix) => key + sep + quote + (bearerPrefix ? bearerPrefix + '***' : '***') + quote);
    // 再打裸 Bearer 令牌（无键名形态）
    out = out.replace(/\b(bearer)(\s+)(["']?)[a-z0-9._~+/=-]+\3/gi, '$1$2$3***$3');
    out = out.replace(/\s+/g, ' ').trim();
    return out.slice(0, max);
}

// ---------- 运行时：权重懒加载 + 分类器聚合 + 个性化学习 ----------

export function createAILocalClassifier(ctx) {
    // ctx（ai-panel 注入，getter 延迟求值）：
    // - getBackend(): Wails 后端（AIEnsureDir / SaveFile / SaveFileDialog）
    // - getAIAppDir(): 应用数据目录（Promise<string>）
    // - readTextFile(path, maxChars): 文本读取（OpenFile 包装），缺失时抛错
    // - getConfig(): AI 配置（localClassifierEnabled / Strictness / Personalize）
    // - getPluginClassifiers(): 插件注册的分类器列表 [{id, label, classify}]
    // - flash(message, isErr): 用户可见提示
    const SAMPLE_LIMIT = 500;       // samples.jsonl 环形上限（防历史包袱无限增长）
    const SAMPLE_TEXT_LIMIT = 300;
    const RETRAIN_EVERY = 20;       // 每新增 N 条样本触发一次批量重训
    const RETRAIN_DELAY_MS = 3000;  // 批量重训去抖（近似空闲时执行）
    const PERSONAL_LR = 0.03;       // 单样本更新学习率（小步）
    const PERSONAL_L2 = 0.01;       // L2 锚定出厂的强度
    const RETRAIN_OPTS = {epochs: 8, lr: 0.02, l2: 0.01, decay: 0.9};
    const LC_DIR = 'local-classifier';

    const state = {
        loaded: null,          // Promise<void>：权重懒加载（失败清空可重试）
        factoryVersion: '',
        featureCfg: null,
        factory: null,         // Float32Array 出厂权重
        bias: 0,
        delta: {},             // {维度: 修正量}（weights.json 持久化形态）
        biasDelta: 0,
        active: null,          // Float32Array = 出厂 + delta（推理用）
        samples: [],           // [{command, y, at}]（samples.jsonl 镜像）
        trainedAt: 0,
        sampleCount: 0,
        failures: new Map(),   // 分类器 id → 连续失败次数
        disabled: new Set(),   // 本会话熔断停用（连续失败 N 次）
        seenCommands: new Set(), // 样本去重：单命令至多 1 次更新（防漂移护栏 #3）
        dirtySamples: 0,       // 距上次批量重训新增样本数
        retrainTimer: 0,
        saveChain: Promise.resolve(), // 存储写链（读改写串行，避免并发覆盖）
    };

    async function storageDir() {
        const app = String((ctx.getAIAppDir ? await ctx.getAIAppDir() : '') || '').replace(/\/+$/, '');
        if (!app) throw new Error('无法定位应用数据目录');
        return app + '/' + LC_DIR;
    }

    // 读 weights.json + samples.jsonl。文件缺失 / 损坏按「无个性化数据」处理；
    // 出厂版本不匹配 → delta 自动重置、样本保留（方案 §7.2）。
    async function loadPersonalState() {
        state.delta = {};
        state.biasDelta = 0;
        state.samples = [];
        state.trainedAt = 0;
        state.sampleCount = 0;
        state.seenCommands = new Set();
        const dir = await storageDir();
        try {
            const read = await ctx.readTextFile(dir + '/weights.json', 256 << 10);
            const data = JSON.parse(read.text);
            if (data && typeof data === 'object') {
                if (data.factoryVersion === state.factoryVersion && data.delta && typeof data.delta === 'object') {
                    state.delta = data.delta;
                    state.biasDelta = Number(data.biasDelta) || 0;
                }
                state.trainedAt = Number(data.trainedAt) || 0;
            }
        } catch (e) {}
        try {
            const read = await ctx.readTextFile(dir + '/samples.jsonl', 2 << 20);
            for (const line of read.text.split('\n')) {
                const text = line.trim();
                if (!text) continue;
                try {
                    const row = JSON.parse(text);
                    if (!row || typeof row.command !== 'string' || (row.y !== 0 && row.y !== 1)) continue;
                    if (state.samples.length >= SAMPLE_LIMIT) break;
                    state.samples.push({command: row.command, y: row.y, at: Number(row.at) || 0});
                    state.seenCommands.add(row.command.toLowerCase());
                } catch (e) {}
            }
            state.sampleCount = state.samples.length;
        } catch (e) {}
        // 出厂版本升级后 delta 已重置、样本保留：个性化开着时自动重训一轮对齐新出厂
        if (ctx.getConfig().localClassifierPersonalize === true && state.samples.length) {
            scheduleRetrain(0);
        }
    }

    function ensureLoaded() {
        if (!state.loaded) {
            state.loaded = (async () => {
                const mod = await import('./local-classifier-weights.mjs');
                state.factoryVersion = mod.LOCAL_CLASSIFIER_FACTORY_VERSION;
                state.featureCfg = mod.LOCAL_CLASSIFIER_FEATURES;
                state.factory = lcDequantize(
                    mod.LOCAL_CLASSIFIER_WEIGHTS, mod.LOCAL_CLASSIFIER_QUANT.scale, mod.LOCAL_CLASSIFIER_FEATURES.dims);
                state.bias = Number(mod.LOCAL_CLASSIFIER_BIAS) || 0;
                await loadPersonalState();
                state.active = state.factory.slice();
                lcApplyDelta(state.active, state.delta);
            })().catch((e) => {
                state.loaded = null; // 允许下次重试
                throw e;
            });
        }
        return state.loaded;
    }

    function queueSave(job) {
        state.saveChain = state.saveChain.then(job).catch((e) => {
            // 尽力而为路径：学习数据写失败不影响审批主链，提示一次由用户决定后续
            if (ctx.flash) ctx.flash('端侧分类器学习数据保存失败：' + ((e && e.message) || e), true);
        });
        return state.saveChain;
    }

    async function writeWeightsJson(dir) {
        if (ctx.getBackend && typeof ctx.getBackend().AIEnsureDir === 'function') {
            await ctx.getBackend().AIEnsureDir(dir);
        }
        await ctx.getBackend().SaveFile(dir + '/weights.json', JSON.stringify({
            factoryVersion: state.factoryVersion,
            delta: state.delta,
            biasDelta: state.biasDelta,
            trainedAt: state.trainedAt,
            sampleCount: state.sampleCount,
        }, null, 1), 'lf', false, 'utf-8');
    }

    async function writeSamplesJsonl(dir) {
        if (ctx.getBackend && typeof ctx.getBackend().AIEnsureDir === 'function') {
            await ctx.getBackend().AIEnsureDir(dir);
        }
        const text = state.samples.map((s) => JSON.stringify({command: s.command, y: s.y, at: s.at})).join('\n');
        await ctx.getBackend().SaveFile(dir + '/samples.jsonl', text ? text + '\n' : '', 'lf', false, 'utf-8');
    }

    function persistLearningState() {
        return queueSave(async () => {
            const dir = await storageDir();
            await writeWeightsJson(dir);
            await writeSamplesJsonl(dir);
        });
    }

    // 批量重训（去抖近似空闲）：从出厂权重重放全部样本 → delta 收敛为全量重放结果。
    function scheduleRetrain(delay) {
        if (state.retrainTimer) return;
        state.retrainTimer = setTimeout(async () => {
            state.retrainTimer = 0;
            if (ctx.getConfig().localClassifierPersonalize !== true || !state.samples.length) return;
            try {
                await ensureLoaded();
                const replay = state.samples.map((s) => ({
                    dims: lcExtractDims(s.command, state.featureCfg),
                    y: s.y,
                }));
                const result = lcRetrain(replay, state.factory, state.bias, RETRAIN_OPTS);
                state.active = result.weights;
                state.biasDelta = result.bias - state.bias;
                state.delta = lcWeightsDelta(state.active, state.factory);
                state.trainedAt = Date.now();
                state.dirtySamples = 0;
                await persistLearningState();
            } catch (e) {}
        }, Number(delay) >= 0 ? delay : RETRAIN_DELAY_MS);
    }

    // 个性化回流：分类器转人工的审批卡经用户裁定后投喂一条样本。
    // 只学显式裁定（批准 → y=0，拒绝 → y=1）；开关关闭时直接忽略。
    async function recordDecision(command, approved) {
        if (ctx.getConfig().localClassifierPersonalize !== true) return false;
        const sanitized = lcSanitizeCommand(command, SAMPLE_TEXT_LIMIT);
        if (!sanitized) return false;
        const key = sanitized.toLowerCase();
        if (state.seenCommands.has(key)) return false; // 单命令至多 1 次更新
        try {
            await ensureLoaded();
        } catch (e) {
            return false;
        }
        const y = approved ? 0 : 1;
        state.seenCommands.add(key);
        state.samples.push({command: sanitized, y, at: Date.now()});
        if (state.samples.length > SAMPLE_LIMIT) {
            const dropped = state.samples.splice(0, state.samples.length - SAMPLE_LIMIT);
            for (const item of dropped) state.seenCommands.delete(item.command.toLowerCase());
        }
        state.sampleCount = state.samples.length;
        // 单样本实时更新（一步 SGD），批量重训随后收敛
        const dims = lcExtractDims(sanitized, state.featureCfg);
        const updated = lcSgdStep(dims, state.active, state.factory, state.bias + state.biasDelta, y, PERSONAL_LR, PERSONAL_L2);
        state.biasDelta = updated.bias - state.bias;
        state.delta = lcWeightsDelta(state.active, state.factory);
        state.trainedAt = Date.now();
        state.dirtySamples += 1;
        // 单样本已实时生效；批量重训按去抖窗口收敛（每 20 条必触发一次）
        scheduleRetrain();
        await persistLearningState();
        return true;
    }

    // 重置分类器：丢弃 delta，秒回出厂权重（样本保留，可重训）。
    async function resetToFactory() {
        try {
            await ensureLoaded();
        } catch (e) {
            throw new Error('分类器权重未加载：' + ((e && e.message) || e));
        }
        state.delta = {};
        state.biasDelta = 0;
        state.active = state.factory.slice();
        state.trainedAt = 0;
        state.dirtySamples = 0;
        if (state.retrainTimer) {
            clearTimeout(state.retrainTimer);
            state.retrainTimer = 0;
        }
        await persistLearningState();
    }

    // 清空学习数据：删样本 + delta，彻底回到出厂态。
    async function clearLearningData() {
        try {
            await ensureLoaded();
        } catch (e) {
            throw new Error('分类器权重未加载：' + ((e && e.message) || e));
        }
        state.samples = [];
        state.sampleCount = 0;
        state.seenCommands = new Set();
        state.delta = {};
        state.biasDelta = 0;
        state.trainedAt = 0;
        state.dirtySamples = 0;
        if (state.retrainTimer) {
            clearTimeout(state.retrainTimer);
            state.retrainTimer = 0;
        }
        state.active = state.factory.slice();
        await persistLearningState();
    }

    // 导出分类器数据（工厂版本 + delta + 脱敏样本 + 统计）到用户选的路径。
    async function exportData() {
        try {
            await ensureLoaded();
        } catch (e) {}
        const backend = ctx.getBackend ? ctx.getBackend() : {};
        if (!backend.SaveFileDialog || !backend.SaveFile) {
            throw new Error('当前版本不支持导出');
        }
        const dest = await backend.SaveFileDialog('local-classifier-export.json');
        if (!dest) return '';
        const payload = {
            exportedAt: new Date().toISOString(),
            factoryVersion: state.factoryVersion,
            delta: state.delta,
            biasDelta: state.biasDelta,
            trainedAt: state.trainedAt,
            samples: state.samples,
            stats: {sampleCount: state.sampleCount, deltaDims: Object.keys(state.delta).length},
        };
        await backend.SaveFile(dest, JSON.stringify(payload, null, 1), 'lf', false, 'utf-8');
        return dest;
    }

    // 单个分类器执行（内置或插件）：异常计数 + 连续失败熔断（本会话内停用）。
    async function classifyOne(id, label, fn, command, info) {
        if (state.disabled.has(id)) return null;
        try {
            const result = await fn(command, info);
            state.failures.delete(id);
            if (!result || typeof result !== 'object' || !Number.isFinite(Number(result.score))) {
                throw new Error('分类器输出缺少 score');
            }
            return {
                id,
                label: String(label || id),
                score: Math.min(1, Math.max(0, Number(result.score))),
                reason: String((result && result.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            };
        } catch (e) {
            const count = (state.failures.get(id) || 0) + 1;
            state.failures.set(id, count);
            if (count >= LOCAL_CLASSIFIER_FAIL_LIMIT) state.disabled.add(id);
            return null;
        }
    }

    // 聚合所有启用的端侧分类器：内置线性模型（localClassifierEnabled）+ 插件注册项，
    // **同时生效、保守合并取 max(score)**——任一分类器判险即转人工（fail-closed）。
    // 线性对良性命令的保守误拦由两层机制兜住：大模型复核（ai-panel，端侧未放行时）与个性化学习。
    // 无任何可用分类器（未启用 / 权重加载失败 / 全部熔断）返回 null，调用方回退远程分类器或人工。
    async function classifyAll(command, info) {
        const cfg = ctx.getConfig ? ctx.getConfig() : {};
        const strictness = normalizeLocalClassifierStrictness(cfg.localClassifierStrictness);
        const runInfo = Object.assign({}, info || {}, {
            strictness,
            threshold: localClassifierThreshold(strictness),
        });
        const list = [];
        if (cfg.localClassifierEnabled === true) {
            list.push({
                id: 'builtin-linear',
                label: '端侧分类器',
                fn: async (cmd) => {
                    await ensureLoaded();
                    const dims = lcExtractDims(cmd, state.featureCfg);
                    return {score: lcScore(dims, state.active, state.bias + state.biasDelta), reason: '线性模型判定'};
                },
            });
        }
        const plugins = ctx.getPluginClassifiers ? (ctx.getPluginClassifiers() || []) : [];
        for (const plugin of plugins) {
            if (plugin && typeof plugin.classify === 'function') {
                list.push({id: 'plugin:' + plugin.id, label: plugin.label || plugin.id, fn: plugin.classify});
            }
        }
        if (!list.length) return null;
        const results = [];
        for (const item of list) {
            const one = await classifyOne(item.id, item.label, item.fn, command, runInfo);
            if (one) results.push(one);
        }
        if (!results.length) return null;
        let best = results[0];
        for (const r of results) {
            if (r.score > best.score) best = r;
        }
        const verdict = judgeLocalClassifier(best.score, strictness);
        return {
            allow: verdict.allow,
            score: best.score,
            threshold: verdict.threshold,
            strictness,
            sourceLabel: best.id === 'builtin-linear' ? '端侧分类器' : (best.label || '插件分类器'),
            sourceId: best.id,
            reason: best.reason,
            classifierCount: results.length,
        };
    }

    // 设置页测试框：即时打分看判定，不产生审批记录、不回流学习。
    async function scoreText(command) {
        await ensureLoaded();
        const cfg = ctx.getConfig ? ctx.getConfig() : {};
        const dims = lcExtractDims(command, state.featureCfg);
        const score = lcScore(dims, state.active, state.bias + state.biasDelta);
        const verdict = judgeLocalClassifier(score, cfg.localClassifierStrictness);
        return {score, verdict, deltaDims: Object.keys(state.delta).length};
    }

    function getStatus() {
        return {
            loaded: !!state.active,
            factoryVersion: state.factoryVersion,
            featureCfg: state.featureCfg,
            sampleCount: state.sampleCount,
            trainedAt: state.trainedAt,
            deltaDims: Object.keys(state.delta).length,
            disabled: [...state.disabled],
            failures: Object.fromEntries(state.failures),
        };
    }

    return {classifyAll, scoreText, recordDecision, resetToFactory, clearLearningData, exportData, getStatus, ensureLoaded};
}
