// memo-docx.js：快捷便签的 Word 原生 .docx 生成——纯模块（DOMParser 遍历 + OOXML 直排 +
// store-mode ZIP），零第三方依赖。图片按 PNG IHDR 实际尺寸等比内嵌为 w:drawing（EMU 换算，
// 超页宽自动缩）；PNG 本身已压缩，ZIP 用 store 模式（手写 CRC32）不损体积。
// 排版：微软雅黑/Calibri 双字体、主题色标题与勾选符、完成划线置灰、代码块底纹、
// 分组标题下边框——全部走直排格式化，不需要 styles.xml。
// 消费方：bridge-memo-view.js 的内置导出「Word 文档（.docx 原生）」。

const EMU_PER_PX = 9525;
const MAX_W_EMU = 5760000; // A4 页宽减边距内

// 排版基调（直排格式化进每个 run/段落，不依赖 styles.xml）
const FONT_BODY = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/>';
const FONT_MONO = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="微软雅黑"/>';
const COLOR_TEXT = '333333';
const COLOR_ACCENT = '2B579A';
const COLOR_TITLE = '1F3864';
const COLOR_MUTED = '8A8A8A';
const COLOR_DONE = '999999';
const COLOR_DONE_MARK = '2E7D32';
const COLOR_DOING_MARK = 'BF6A02';
const COLOR_PENDING_MARK = 'AAB2BD';
const COLOR_BORDER = 'D6E0F0';
const COLOR_CODE_BG = 'F5F5F5';

export function escapeXml(t) {
    return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ---- ZIP（store 模式，手写 CRC32）----
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) { // files: [{name, data: Uint8Array}] → Uint8Array
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const name = new TextEncoder().encode(f.name);
        const crc = crc32(f.data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true); // 名字 UTF-8
        lh.setUint16(10, dosTime, true);
        lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, f.data.length, true);
        lh.setUint32(22, f.data.length, true);
        lh.setUint16(26, name.length, true);
        chunks.push(new Uint8Array(lh.buffer), name, f.data);
        central.push({name, crc, size: f.data.length, offset});
        offset += 30 + name.length + f.data.length;
    }
    const cdStart = offset;
    for (const c of central) {
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(12, dosTime, true);
        ch.setUint16(14, dosDate, true);
        ch.setUint32(16, c.crc, true);
        ch.setUint32(20, c.size, true);
        ch.setUint32(24, c.size, true);
        ch.setUint16(28, c.name.length, true);
        ch.setUint32(42, c.offset, true);
        chunks.push(new Uint8Array(ch.buffer), c.name);
        offset += 46 + c.name.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    chunks.push(new Uint8Array(eocd.buffer));
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

function bytesOf(s) {
    return new TextEncoder().encode(s);
}

function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// ---- 图片尺寸与 w:drawing ----
// PNG 尺寸：IHDR 在字节 16..23（宽高各 4 字节大端）。base64 前 32 字符解码出前 24 字节。
function pngSize(base64) {
    try {
        const bin = atob(base64.slice(0, 32));
        const w = (bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) |
            (bin.charCodeAt(18) << 8) | bin.charCodeAt(19);
        const h = (bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) |
            (bin.charCodeAt(22) << 8) | bin.charCodeAt(23);
        if (w > 0 && h > 0) return {w, h};
    } catch (e) { /* 非 PNG 或截断：走默认尺寸 */ }
    return null;
}

function imageEmu(base64) {
    const size = pngSize(base64);
    let w = 280, h = 210; // 非 PNG / 读不出尺寸的兜底
    if (size) { w = size.w; h = size.h; }
    let cx = w * EMU_PER_PX;
    let cy = h * EMU_PER_PX;
    if (cx > MAX_W_EMU) { cy = Math.round(cy * (MAX_W_EMU / cx)); cx = MAX_W_EMU; }
    return {cx, cy};
}

function drawingXml(seq, relId, base64) {
    const {cx, cy} = imageEmu(base64);
    return '<w:r><w:drawing>' +
        '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
        '<wp:docPr id="' + seq + '" name="Picture ' + seq + '"/>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + seq + '" name="img"/>' +
        '<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + relId + '"/>' +
        '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

// ---- run 级排版：base 对象 {bold, italic, mono, strike, color, size} → w:rPr ----
function rprOf(base) {
    const b = base || {};
    let rPr = b.mono ? FONT_MONO : FONT_BODY;
    if (b.bold) rPr += '<w:b/>';
    if (b.italic) rPr += '<w:i/>';
    if (b.strike) rPr += '<w:strike/>';
    rPr += '<w:color w:val="' + (b.color || COLOR_TEXT) + '"/>';
    rPr += '<w:sz w:val="' + (b.size || 22) + '"/>';
    return '<w:rPr>' + rPr + '</w:rPr>';
}

// runsOf 把 DOM 节点序列转成 w:r 串：文本（保留换行）、b/strong、i/em、code、img。
// base 透传给子层级并按标签叠加（li 完成态划线置灰整段生效；b/i/code 组合可嵌套）。
// class="mark" 的字面勾选符（.doc/.html 路径用）在这里跳过——docx 的彩色勾选符由
// li 分支自己按状态生成，避免双份。
function runsOf(node, imagesByName, base) {
    const b = base || {};
    let out = '';
    for (const child of node.childNodes) {
        if (child.nodeType === 3) { // 文本
            const text = child.nodeValue || '';
            if (!text) continue;
            const parts = escapeXml(text).split('\n');
            out += '<w:r>' + rprOf(b) + '<w:t xml:space="preserve">' +
                parts.join('</w:t></w:r><w:r>' + rprOf(b) + '<w:br/><w:t xml:space="preserve">') +
                '</w:t></w:r>';
            continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (child.classList.contains('mark')) continue;
        if (tag === 'img') {
            const name = (child.getAttribute('src') || '').replace(/^img\//, '');
            const image = imagesByName.get(name);
            if (image) out += drawingXml(image.seq, image.relId, image.base64);
            continue;
        }
        if (tag === 'br') { out += '<w:r>' + rprOf(b) + '<w:br/></w:r>'; continue; }
        if (tag === 'b' || tag === 'strong') { out += runsOf(child, imagesByName, {...b, bold: true}); continue; }
        if (tag === 'i' || tag === 'em') { out += runsOf(child, imagesByName, {...b, italic: true}); continue; }
        if (tag === 'code') { out += runsOf(child, imagesByName, {...b, mono: true}); continue; }
        const inner = runsOf(child, imagesByName, b);
        if (inner) out += inner; // span 等透明容器
    }
    return out;
}

// para 段落封装：间距（before/after）、底部边框（分组标题分隔线）、底纹（代码块）
function para(html, opts) {
    const o = opts || {};
    let pPr = '';
    if (o.before || o.after) {
        pPr += '<w:spacing ' +
            (o.before ? 'w:before="' + o.before + '" ' : '') +
            'w:after="' + (o.after != null ? o.after : 80) + '"/>';
    } else {
        pPr += '<w:spacing w:after="80"/>';
    }
    if (o.ind) pPr += '<w:ind w:left="' + o.ind + '"/>';
    if (o.border) {
        pPr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="3" w:color="' + o.border + '"/></w:pBdr>';
    }
    if (o.shd) pPr += '<w:shd w:val="clear" w:color="auto" w:fill="' + o.shd + '"/>';
    return '<w:p><w:pPr>' + pPr + '</w:pPr>' + html + '</w:p>';
}

// bodyWalk 把解析出的 body 子元素序列转成 OOXML 段落序列（带排版基调）
function bodyWalk(body, imagesByName) {
    const parts = [];
    const walk = (node, listDepth) => {
        for (const el of node.childNodes) {
            if (el.nodeType !== 1) continue;
            const tag = el.tagName.toLowerCase();
            if (tag === 'h1') {
                parts.push(para(runsOf(el, imagesByName, {bold: true, color: COLOR_TITLE, size: 32}), {after: 140}));
            } else if (tag === 'h2') {
                parts.push(para(runsOf(el, imagesByName, {bold: true, color: COLOR_ACCENT, size: 26}),
                    {before: 200, after: 100, border: COLOR_BORDER}));
            } else if (tag === 'h3') {
                parts.push(para(runsOf(el, imagesByName, {bold: true, size: 24}), {before: 120, after: 60}));
            } else if (tag === 'h4') {
                parts.push(para(runsOf(el, imagesByName, {bold: true, size: 22}), {before: 100, after: 60}));
            } else if (tag === 'ul' || tag === 'ol') {
                walk(el, listDepth + 1);
            } else if (tag === 'li') {
                const done = el.classList.contains('done');
                const doing = el.classList.contains('doing');
                const mark = done ? '☑' : doing ? '◐' : '☐';
                const markColor = done ? COLOR_DONE_MARK : doing ? COLOR_DOING_MARK : COLOR_PENDING_MARK;
                const base = done ? {strike: true, color: COLOR_DONE} : {};
                parts.push(para(
                    '<w:r>' + rprOf({color: markColor, bold: true}) + '<w:t xml:space="preserve"> ' + mark + '  </w:t></w:r>' +
                    runsOf(el, imagesByName, base),
                    {after: 40, ind: 284 + listDepth * 284}));
            } else if (tag === 'pre') {
                parts.push(para(runsOf(el, imagesByName, {mono: true, size: 18, color: '24292E'}),
                    {after: 120, shd: COLOR_CODE_BG, ind: 56}));
            } else if (tag === 'p' || tag === 'div') {
                if (el.querySelector('ul,ol,pre,h1,h2,h3,h4')) walk(el, listDepth);
                else parts.push(para(runsOf(el, imagesByName)));
            } else if (tag === 'img') {
                parts.push(para(runsOf(el, imagesByName), {after: 60}));
            } else if (tag === 'section' || tag === 'article' || tag === 'main') {
                walk(el, listDepth);
            } else if (tag === 'style' || tag === 'script' || tag === 'head' || tag === 'title') {
                continue;
            } else {
                const inner = runsOf(el, imagesByName);
                if (inner) parts.push(para(inner));
            }
        }
    };
    walk(body, 0);
    return parts;
}

// memoDocxBuild 由导出场景组装的 HTML（图片为相对 img/<name> 引用）与字节就绪的
// images（[{name, mime, base64}]）生成 .docx 字节。DOMParser 是 WebView 运行时 API。
export function memoDocxBuild(html, images) {
    const imagesByName = new Map();
    images.forEach((image, i) => {
        imagesByName.set(image.name, {
            base64: image.base64,
            relId: 'rIdImg' + (i + 1),
            seq: i + 1,
        });
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const bodyParts = bodyWalk(doc.body, imagesByName);
    const rels = images.map((image, i) =>
        '<Relationship Id="rIdImg' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' +
        (i + 1) + '.png"/>').join('');

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>';
    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>';
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<w:body>' + bodyParts.join('') +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
        '</w:body></w:document>';

    const files = [
        {name: '[Content_Types].xml', data: bytesOf(contentTypes)},
        {name: '_rels/.rels', data: bytesOf(rootRels)},
        {name: 'word/document.xml', data: bytesOf(documentXml)},
        {name: 'word/_rels/document.xml.rels', data: bytesOf(docRels)},
    ];
    images.forEach((image, i) => {
        files.push({
            name: 'word/media/image' + (i + 1) + '.png',
            data: new Uint8Array(atob(image.base64).split('').map((c) => c.charCodeAt(0))),
        });
    });
    return buildZip(files);
}

// memoDocxBase64 便捷封装：直接产出 base64（供 SaveDataURL 写盘）。
export function memoDocxBase64(html, images) {
    return bytesToBase64(memoDocxBuild(html, images));
}
