// memo-docx（Word 原生 .docx 生成器）护栏：ZIP 结构（本地头/EOCD/CRC 由 python zipfile
// 交叉验证见开发流程）、OOXML 内容（标题/勾选符/贴图 drawing/rels）、边界（无图片/取消路径
// 不在本模块——它只管从 html+images 产字节）。DOMParser 是 WebView 运行时 API，测试挂 shim。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoDocxBuild, memoDocxBase64} from '../../src/bridge/memo-docx.js';

// DOMParser shim：只实现测试 fixture 用到的扁平结构（h2/ul/li/div/img/p + class/src）。
// bodyWalk 的容器选择器在 shim 里恒为 null；WebView 运行时用原生 DOMParser。
function shimDOMParser(html) {
    const start = html.indexOf('<body');
    const end = html.lastIndexOf('</body>');
    const inner = start >= 0 ? html.slice(html.indexOf('>', start) + 1, end) : html;
    const mkText = (t) => {
        // 浏览器 DOMParser 会解码字符引用成字面字符（esc 再负责转义回 OOXML 安全形态）
        const decoded = t.replace(/&(lt|gt|quot|apos|amp);/g,
            (m, e) => ({lt: '<', gt: '>', quot: '"', apos: "'", amp: '&'}[e]));
        return {nodeType: 3, nodeValue: decoded, childNodes: [],
            getAttribute: () => null, classList: {contains: () => false}, querySelector: () => null};
    };
    const mkEl = (tag, attrsRaw) => {
        const attrs = new Map();
        for (const m of (attrsRaw || '').matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) attrs.set(m[1], m[2]);
        const node = {
            nodeType: 1, tagName: tag.toUpperCase(), childNodes: [],
            getAttribute: (n) => attrs.has(n) ? attrs.get(n) : null,
            classList: {contains: (c) => (' ' + (attrs.get('class') || '') + ' ').includes(' ' + c + ' ')},
            querySelector: (sel) => {
                // 容器分支用（p/div 是否含 ul/ol/pre/h1-h4）：按标签名找第一个后代元素
                const tags = String(sel || '').split(',').map((t) => t.trim().toLowerCase());
                const find = (n) => {
                    for (const child of n.childNodes) {
                        if (child.nodeType !== 1) continue;
                        if (tags.indexOf(child.tagName.toLowerCase()) >= 0) return child;
                        const hit = find(child);
                        if (hit) return hit;
                    }
                    return null;
                };
                return find(node);
            },
            querySelectorAll: () => [],
        };
        node.appendChild = (n) => node.childNodes.push(n);
        return node;
    };
    const body = mkEl('body');
    const stack = [body];
    const selfClosing = new Set(['img', 'br', 'meta', 'link', 'hr', 'input']);
    const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>|([^<]+)/g;
    let m;
    while ((m = re.exec(inner))) {
        if (m[3] != null) {
            if (m[3]) stack[stack.length - 1].appendChild(mkText(m[3]));
            continue;
        }
        const closing = m[0][1] === '/';
        const tag = m[1].toLowerCase();
        if (closing) {
            if (stack.length > 1) stack.pop();
        } else {
            const node = mkEl(tag, m[2] || '');
            stack[stack.length - 1].appendChild(node);
            if (!selfClosing.has(tag)) stack.push(node);
        }
    }
    return {body};
}

globalThis.DOMParser = class { parseFromString(html) { return shimDOMParser(html); } };

// 1×1 红 PNG（完整文件，IHDR 含真实宽高）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const HTML = '<html><body><h2>1. 阶段一</h2><ul>' +
    '<li class="done">223s 完成</li><li class="doing">进行中任务</li></ul>' +
    '<div class="md"><img src="img/a.png" data-ai-src="img/a.png"></div></body></html>';

function extractFile(buf, name) {
    let at = 0;
    while (at < buf.length - 4) {
        if (buf.readUInt32LE(at) !== 0x04034b50) { at++; continue; }
        const nameLen = buf.readUInt16LE(at + 26);
        const extraLen = buf.readUInt16LE(at + 28);
        const size = buf.readUInt32LE(at + 18);
        const nameStart = at + 30;
        const dataStart = nameStart + nameLen + extraLen;
        const fileName = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
        if (fileName === name) return buf.slice(dataStart, dataStart + size).toString('utf8');
        at = dataStart + size;
    }
    throw new Error('ZIP 内找不到 ' + name);
}

test('memoDocxBuild：ZIP 签名与必备条目', () => {
    const buf = Buffer.from(memoDocxBase64(HTML, [{name: 'a.png', mime: 'image/png', base64: PNG_1PX}]), 'base64');
    assert.equal(buf.slice(0, 4).toString('binary'), 'PK\x03\x04', 'ZIP 本地头签名');
    assert.ok(buf.lastIndexOf('PK\x05\x06') > 0, 'EOCD 在尾部');
    assert.ok(extractFile(buf, '[Content_Types].xml').includes('wordprocessingml.document.main+xml'));
    assert.ok(extractFile(buf, 'word/media/image1.png').length > 0, '贴图进 media');
    const rels = extractFile(buf, 'word/_rels/document.xml.rels');
    assert.ok(rels.includes('Target="media/image1.png"'), 'rels 指向 media');
});

test('memoDocxBuild：OOXML 内容（标题/勾选符/贴图 drawing）', () => {
    const buf = Buffer.from(memoDocxBase64(HTML, [{name: 'a.png', mime: 'image/png', base64: PNG_1PX}]), 'base64');
    const docXml = extractFile(buf, 'word/document.xml');
    assert.ok(docXml.includes('1. 阶段一'), '标题进 OOXML');
    assert.ok(docXml.includes('☑'), '完成勾选符');
    assert.ok(docXml.includes('◐'), '进行中勾选符');
    assert.ok(docXml.includes('223s 完成'), '条目文本');
    assert.ok(docXml.includes('r:embed="rIdImg1"'), '贴图 drawing 引用');
    assert.ok(docXml.includes('<w:sectPr>'), '节属性收尾');
    // 图片按 IHDR 1×1 换算：EMU = 1*9525
    assert.ok(docXml.includes('cx="9525"'), 'PNG 尺寸换算 EMU');
});

test('memoDocxBuild：排版基调（主题色标题/下边框/完成划线/彩色勾选符/代码底纹）', () => {
    const withPre = '<html><body><h1>快捷便签 · 工作区</h1><h2>1. 阶段一</h2><ul><li class="done">223s 完成</li></ul>' +
        '<div class="md"><pre><code>line1' + String.fromCharCode(10) + 'line2</code></pre>' +
        '<p>正文 <strong>加粗</strong> 与 <em>斜体</em> <code>code</code></p></div></body></html>';
    const buf = Buffer.from(memoDocxBase64(withPre, [{name: 'a.png', mime: 'image/png', base64: PNG_1PX}]), 'base64');
    const docXml = extractFile(buf, 'word/document.xml');
    assert.ok(docXml.includes('w:color w:val="2B579A"'), '分组标题主题色');
    assert.ok(docXml.includes('w:color w:val="1F3864"'), '文档标题色');
    assert.ok(docXml.includes('<w:pBdr>'), '分组标题下边框');
    assert.ok(docXml.includes('w:color="D6E0F0"'), '边框浅色');
    assert.ok(docXml.includes('<w:strike/>'), '完成条目划线');
    assert.ok(docXml.includes('w:color w:val="2E7D32"'), '☑ 绿色');
    assert.ok(docXml.includes('w:fill="F5F5F5"'), '代码块底纹');
    assert.ok(docXml.includes('w:ascii="Consolas"'), '等宽字体');
    assert.ok(docXml.includes('<w:br/>'), '代码内换行走 w:br');
    assert.ok(docXml.includes('加粗') && docXml.includes('<w:b/>'), '加粗 run');
    assert.ok(docXml.includes('<w:i/>'), '斜体 run');
});

test('memoDocxBuild：无图片文档（rels 空、无 media）', () => {
    const buf = Buffer.from(memoDocxBase64('<html><body><h2>只有文字</h2></body></html>', []), 'base64');
    assert.equal(
        extractFile(buf, 'word/_rels/document.xml.rels'),
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
        '无图片时 rels 为空');
    let media = false;
    try { extractFile(buf, 'word/media/image1.png'); media = true; } catch (e) { /* 应不存在 */ }
    assert.equal(media, false, '无图片不应产出 media');
});

test('memoDocxBuild：多图与 md 条目（data-ai-src 相对引用同名映射）', () => {
    const html = '<html><body><div class="md"><img src="img/first.png" data-ai-src="img/first.png">' +
        '<img src="img/second.png" data-ai-src="img/second.png"></div></body></html>';
    const buf = Buffer.from(memoDocxBase64(html, [
        {name: 'first.png', mime: 'image/png', base64: PNG_1PX},
        {name: 'second.png', mime: 'image/png', base64: PNG_1PX},
    ]), 'base64');
    const docXml = extractFile(buf, 'word/document.xml');
    assert.ok(docXml.includes('r:embed="rIdImg1"') && docXml.includes('r:embed="rIdImg2"'), '两张图分别引用');
    assert.ok(extractFile(buf, 'word/media/image2.png').length > 0, '第二张贴图入包');
});

test('memoDocxBuild：转义安全——文本里的 <script> 不逃逸成元素', () => {
    const buf = Buffer.from(memoDocxBase64(
        '<html><body><p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; ok</p></body></html>', []), 'base64');
    const docXml = extractFile(buf, 'word/document.xml');
    assert.ok(docXml.includes('&lt;script&gt;'), '转义保留为字面文本');
    assert.ok(!docXml.includes('<script>'), '不得出现真实 script 元素');
});
