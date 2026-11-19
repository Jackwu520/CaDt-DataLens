// plugin-importers.js：插件文档导入转换器（纯逻辑，无 DOM，可单测）。
//
// 与 registerDocConverter（只出不进）同构：插件声明「我能把某类文件转成文本」，
// 打开链在遇到内置格式解析不了的文件时询问导入器。典型：PDF→Markdown、docx→md、OCR。
//
// 边界：转换在插件侧完成（重依赖随插件分发，核心包零依赖）；本模块只管声明与查找。

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const importers = new Map(); // `${pluginId}:${id}` → record

function bad(message) {
    throw new Error('[registerImporter] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// 扩展名归一：去点、小写、去空白。
export function normalizeExt(ext) {
    return String(ext == null ? '' : ext).trim().replace(/^\./, '').toLowerCase();
}

export function normalizePluginImporter(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!ID_RULE.test(owner)) bad(`插件 id 无效：${JSON.stringify(pluginId)}`);
    if (!isPlainObject(spec)) bad('需要一个导入器对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.convert !== 'function') bad(`导入器 ${id} 缺少 convert 函数`);
    const extensions = (Array.isArray(spec.extensions) ? spec.extensions : [])
        .map(normalizeExt)
        .filter(Boolean);
    if (!extensions.length) bad(`导入器 ${id} 缺少 extensions`);
    return {
        key: owner + ':' + id,
        pluginId: owner,
        pluginName: String(pluginName || owner),
        id,
        label: String(spec.label == null ? id : spec.label).trim().slice(0, 60) || id,
        extensions,
        convert: spec.convert,
    };
}

export function registerPluginImporter(pluginId, pluginName, spec) {
    const record = normalizePluginImporter(pluginId, pluginName, spec);
    if (importers.has(record.key)) bad(`导入器 ${record.id} 已注册`);
    importers.set(record.key, record);
    return record;
}

export function clearPluginImporters() {
    importers.clear();
}

export function getPluginImporters() {
    return [...importers.values()];
}

// 按扩展名找能处理它的导入器（返回第一个；未命中返回 null）。
export function findImporterFor(ext) {
    const want = normalizeExt(ext);
    if (!want) return null;
    for (const record of importers.values()) {
        if (record.extensions.includes(want)) return record;
    }
    return null;
}

// ---- 导入器宿主支撑：把 Go 侧 OpenFile 的十六进制视图还原成 base64 ----
// 内置没有「按路径读原始字节」的绑定（读图通道 ReadImageAsDataURL 只认图片），
// 而导入器（PDF→Markdown / docx→md）恰恰需要原始字节。这里把二进制视图那份 hex dump
// 还原回字节，给 ctx.readBinaryFile 兜底；上限沿用 Go 侧 imageHexLimit（1 MB），
// 调用方按 file.size > file.hexShown 判截断并报错，不返回半截字节。

export function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
        binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// 行格式（internal/fileio 的 imageHexDump）：
//   "00000010  50 4b 03 04 14 00 06 00  08 00 00 00 21 00  |PK..........!.|"
// 偏移 + 两空格 + 16 个 "xx " （第 8 个后多一个空格）+ " |ascii|"。
const HEX_DUMP_LINE = /^[0-9a-f]{8} {2}([^|]*)\|/;

export function hexDumpToBase64(hexDump) {
    const text = String(hexDump == null ? '' : hexDump);
    if (!text) return '';
    const out = [];
    for (const line of text.split('\n')) {
        const m = HEX_DUMP_LINE.exec(line);
        if (!m) continue;
        for (const token of m[1].trim().split(/\s+/)) {
            if (!/^[0-9a-f]{2}$/i.test(token)) continue;
            out.push(parseInt(token, 16));
        }
    }
    return bytesToBase64(new Uint8Array(out));
}
