// 插件文档导入器注册表护栏（cadt.registerImporter）：归一化 → 扩展名查找 → 清空重建，
// 以及宿主支撑的解码（十六进制视图 → base64）——打开链用它把二进制交给插件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bytesToBase64, clearPluginImporters, findImporterFor, getPluginImporters,
    hexDumpToBase64, normalizeExt, normalizePluginImporter, registerPluginImporter,
} from '../../src/shell/plugin-importers.js';

const convert = async () => '# md';
const plain = (over) => ({id: 'pdf-md', label: 'PDF 转 Markdown', extensions: ['pdf'], convert, ...over});
const reset = () => clearPluginImporters();

// 与 internal/fileio 的 imageHexDump 同格式：偏移 + 两空格 + 16 个 "xx " + " |ascii|"
function hexDump(bytes) {
    const lines = [];
    for (let off = 0; off < bytes.length; off += 16) {
        const end = Math.min(off + 16, bytes.length);
        let line = off.toString(16).padStart(8, '0') + '  ';
        for (let i = 0; i < 16; i += 1) {
            line += off + i < end ? bytes[off + i].toString(16).padStart(2, '0') + ' ' : '   ';
            if (i === 7) line += ' ';
        }
        let ascii = '';
        for (let i = off; i < end; i += 1) {
            const c = bytes[i];
            ascii += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
        }
        lines.push(line + ' |' + ascii + '|');
    }
    return lines.join('\n');
}

test('扩展名归一：去点、小写、去空白', () => {
    assert.equal(normalizeExt('.PDF'), 'pdf');
    assert.equal(normalizeExt('  Docx '), 'docx');
    assert.equal(normalizeExt(null), '');
});

test('归一化：默认值与字段', () => {
    const record = normalizePluginImporter('p1', 'P1', {id: 'pdf-md', extensions: ['.PDF'], convert});
    assert.equal(record.key, 'p1:pdf-md');
    assert.equal(record.pluginName, 'P1');
    assert.equal(record.label, 'pdf-md', '缺 label 用 id');
    assert.deepEqual(record.extensions, ['pdf'], '归一：去点 + 小写');
    assert.equal(typeof record.convert, 'function');
});

test('归一化：非法声明抛错', () => {
    assert.throws(() => normalizePluginImporter('BAD', 'P', plain()), /插件 id 无效/);
    assert.throws(() => normalizePluginImporter('p1', 'P', null), /需要一个导入器对象/);
    assert.throws(() => normalizePluginImporter('p1', 'P', plain({id: 'PDF MD'})), /id 无效/);
    assert.throws(() => normalizePluginImporter('p1', 'P', {id: 'x', extensions: ['pdf']}), /缺少 convert/);
    assert.throws(() => normalizePluginImporter('p1', 'P', {id: 'x', convert}), /缺少 extensions/);
    assert.throws(() => normalizePluginImporter('p1', 'P', {id: 'x', extensions: ['.'], convert}), /缺少 extensions/);
});

test('注册与查找：按扩展名首个命中，跨插件不串', () => {
    reset();
    assert.equal(findImporterFor('pdf'), null, '空注册表返回 null');
    registerPluginImporter('p1', 'P1', plain());
    registerPluginImporter('p2', 'P2', plain({id: 'docx-md', extensions: ['docx'], convert}));
    assert.equal(getPluginImporters().length, 2);
    assert.equal(findImporterFor('.PDF').pluginId, 'p1');
    assert.equal(findImporterFor('docx').id, 'docx-md');
    assert.equal(findImporterFor('txt'), null);
    assert.equal(findImporterFor(''), null);
    assert.throws(() => registerPluginImporter('p1', 'P1', plain()), /已注册/);
    clearPluginImporters();
    assert.deepEqual(getPluginImporters(), []);
    assert.equal(findImporterFor('pdf'), null);
});

test('bytesToBase64：标准 base64、支持大块分片', () => {
    assert.equal(bytesToBase64(new Uint8Array([80, 75, 3, 4])), 'UEsDBA==');
    const big = new Uint8Array(70000).fill(65);
    const encoded = bytesToBase64(big);
    assert.equal(encoded.length, Math.ceil(70000 / 3) * 4);
    assert.equal(atob(encoded).length, 70000);
});

test('hexDumpToBase64：还原出原始字节', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x41, 0x42, 0x00, 0x7e, 0x7f, 0x20, 0x09, 0x0a, 0x0d, 0x00, 0x01, 0x02]);
    assert.equal(hexDumpToBase64(hexDump(bytes)), bytesToBase64(bytes));
    // 右对齐补空格的末行、以及 ASCII 列里的 " |" 不会干扰切分
    const ascii = new Uint8Array(Array.from('|  a |b|', (c) => c.charCodeAt(0)));
    assert.equal(hexDumpToBase64(hexDump(ascii)), bytesToBase64(ascii));
    assert.equal(hexDumpToBase64(''), '');
    assert.equal(hexDumpToBase64('不是 hex dump'), '');
});
