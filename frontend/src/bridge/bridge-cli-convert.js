// CLI 转换模式：隐藏窗口加载前端格式层，转换完立即退出（--convert）。
// 从 bridge-ui.js 拆出。
import {formats, pluginFormats, detectFormat} from '../core/formats.js';
import {parseJson} from '../core/json-safe.js';

export function createBridgeCliConvert(deps) {

// ---- CLI 转换模式：隐藏窗口加载前端格式层，转换完立即退出 ----
function convertTargetDriver(to) {
    const id = String(to || '').toLowerCase().replace(/^\./, '');
    const aliases = {yml: 'yaml', ndjson: 'jsonl'};
    const targetID = aliases[id] || id;
    const driver = formats[targetID] ||
        pluginFormats.find((f) => f.id === targetID) ||
        Object.values(formats).find((f) => f.extensions.includes(targetID));
    if (!driver || typeof driver.parse !== 'function' || typeof driver.stringify !== 'function') {
        throw new Error('不支持的目标格式：' + to);
    }
    return driver;
}

async function maybeRunConvertJob() {
    if (!deps.hasWails || !deps.backend.GetConvertRequest) return false;
    let raw = '';
    try {
        raw = await deps.backend.GetConvertRequest();
    } catch (e) {
        return false;
    }
    if (!raw) return false;
    const req = parseJson(raw, null);
    if (!req || typeof req !== 'object') return false;
    let target = null;
    let targetError = '';
    try {
        target = convertTargetDriver(req.to);
    } catch (e) {
        targetError = String((e && e.message) || e);
    }
    const results = [];
    for (const job of req.jobs || []) {
        try {
            if (targetError) throw new Error(targetError);
            const data = await deps.backend.OpenFile(job.input, 'auto');
            if (!data || data.binary) throw new Error('二进制文件不支持转换');
            const content = String(data.content == null ? '' : data.content);
            const source = detectFormat(job.input, content);
            if (typeof source.parse !== 'function' || typeof source.stringify !== 'function') {
                throw new Error('不支持读取该格式：' + (source.name || ''));
            }
            const value = source.parse(content);
            const output = target.stringify(value);
            results.push({
                input: job.input,
                output: job.output || '',
                content: output == null ? '' : String(output),
            });
        } catch (e) {
            results.push({
                input: job.input,
                output: job.output || '',
                error: String((e && e.message) || e),
            });
        }
    }
    try {
        await deps.backend.FinishConvert(JSON.stringify({stdout: !!req.stdout, results}));
    } catch (e) {}
    return true;
}


return {maybeRunConvertJob};
}
