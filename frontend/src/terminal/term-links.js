// term-links.js：终端内 http/https 链接检测纯函数——拼接行文本提取链接、修剪尾部
// 标点与未配对括号、把字符偏移换算成 xterm ILink 的每行坐标。缓冲区取行与激活
// 回调（Ctrl+单击打开）在 terminal-sessions.js 的 registerTermLinks。

// URL 词法：scheme 后取非空白、非引号、非尖括号的连续字符；尾巴交给 trimLinkTail 收拾
const URL_RE = /https?:\/\/[^\s"'`<>]+/g;
const TRIM_CHARS = ',.;:!?\'"';

// 修剪链接尾部：普通标点/引号一律剪，右括号/方括号/花括号只在未配对时剪
// （shell 输出常见 `(see http://x.com/a).`），配对的括号是 URL 本体要保留
export function trimLinkTail(t) {
    while (t.length) {
        const last = t[t.length - 1];
        if (TRIM_CHARS.includes(last)) {
            t = t.slice(0, -1);
            continue;
        }
        if (')]}'.includes(last)) {
            const open = last === ')' ? '(' : (last === ']' ? '[' : '{');
            if (countChar(t, last) > countChar(t, open)) {
                t = t.slice(0, -1);
                continue;
            }
        }
        break;
    }
    return t;
}

function countChar(t, ch) {
    let n = 0;
    for (let i = 0; i < t.length; i++) if (t[i] === ch) n++;
    return n;
}

// matchLinks(text) → [{text, start, end}]：end 不含，偏移相对拼接文本
export function matchLinks(text) {
    const out = [];
    if (!text) return out;
    for (const m of text.matchAll(URL_RE)) {
        const body = trimLinkTail(m[0]);
        if (body.length - (body.indexOf('://') + 3) < 1) continue; // scheme:// 后至少 1 字符（localhost 无点也合法）
        out.push({text: body, start: m.index, end: m.index + body.length});
    }
    return out;
}

// linkRangeInRows(rows, match)：rows 为软换行序列 [{y, text, colOf, wideAt}]——
// y 是 xterm 的 1-based 缓冲行号；colOf 把字符串偏移映射到 0-based cell 列
// （宽字符占 2 cell，字符串索引 ≠ cell 列，映射由 terminal-sessions 逐 cell 建立）；
// wideAt 记录宽字符的字符串偏移（URL 末字符是宽字符时 end 要含住后半格）。
// 返回 {start:{x,y}, end:{x,y}}：x 为 1-based cell 列、end 含端点（与 xterm 内置
// OscLinkProvider 同约定），结构异常返回 null。
export function linkRangeInRows(rows, match) {
    if (!rows || !rows.length || !match || !(match.end > match.start)) return null;
    const offsets = [];
    let acc = 0;
    for (const r of rows) {
        offsets.push(acc);
        acc += r.text.length;
    }
    const rowAt = (pos) => {
        let k = 0;
        for (let i = 0; i < rows.length; i++) if (offsets[i] <= pos) k = i;
        return k;
    };
    const a = rowAt(match.start);
    const b = rowAt(match.end - 1);
    const startOff = match.start - offsets[a];
    const endOff = match.end - 1 - offsets[b];
    if (startOff >= rows[a].text.length || endOff >= rows[b].text.length) return null;
    const endX = cellColOf(rows[b], endOff) + (rows[b].wideAt && rows[b].wideAt.has(endOff) ? 2 : 1);
    return {
        start: {x: cellColOf(rows[a], startOff) + 1, y: rows[a].y},
        end: {x: endX, y: rows[b].y},
    };
}

function cellColOf(row, off) {
    const col = row.colOf ? row.colOf[off] : off; // 无映射时按纯 ASCII 假设退化
    return typeof col === 'number' ? col : off;
}
