// ai-file-tools.js：AI 文件类工具的纯函数（read_file 窗口切片 / edit_file 定位 /
// search_text 通配过滤 / list_dir 人类可读大小 / browser_navigate 的 file:// 解析）。
// ai-panel.js 超线只减不增，这些逻辑从 executeTool 各 case 抽到这里，
// 配套测试见 ai-file-tools.test.mjs。

export const AI_READ_MAX_CHARS = 64 << 10;

// —— read_file ——

// 归一化读取窗口参数：字符模式（offset/limit）与行号模式（startLine/endLine）互斥。
// 不变量不满足时 throw，错误消息会作为工具结果回给模型。
export function normalizeReadWindow(input) {
    const raw = input || {};
    const hasChars = raw.offset != null || raw.limit != null;
    const hasLines = raw.startLine != null || raw.endLine != null;
    if (hasChars && hasLines) {
        throw new Error('offset/limit 与 startLine/endLine 不能混用：字符分页用 offset+limit，按行读取用 startLine+endLine');
    }
    if (hasLines) {
        const startLine = Math.max(1, Math.round(Number(raw.startLine) || 1));
        let endLine = null;
        if (raw.endLine != null) {
            endLine = Math.round(Number(raw.endLine));
            if (!Number.isFinite(endLine) || endLine < 1) endLine = 1;
            if (endLine < startLine) {
                throw new Error('endLine（' + endLine + '）不能小于 startLine（' + startLine + '）');
            }
        }
        return {mode: 'lines', startLine, endLine};
    }
    let offset = Math.round(Number(raw.offset) || 0);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    let limit = raw.limit == null ? AI_READ_MAX_CHARS : Math.round(Number(raw.limit));
    if (!Number.isFinite(limit) || limit < 1) {
        throw new Error('limit 至少为 1（当前不传即默认上限 ' + AI_READ_MAX_CHARS + '）');
    }
    return {mode: 'chars', offset, limit: Math.min(limit, AI_READ_MAX_CHARS)};
}

// 按归一化参数切窗口。行号模式输出带右对齐行号 + tab 前缀（对齐编辑器行号；
// 仅供模型引用，edit_file 的 oldString 用不含前缀的原文），截断时给出续读提示。
export function readWindowOf(text, params) {
    const raw = String(text == null ? '' : text);
    const p = params;
    if (p.mode === 'lines') {
        // 与编辑器行号一致：按 \n 切，文件以换行结尾时最后一段不算一行
        const lines = raw.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const totalLines = lines.length;
        const startLine = Math.min(p.startLine, Math.max(1, totalLines));
        const endLine = Math.min(p.endLine == null ? totalLines : p.endLine, totalLines);
        if (p.startLine > totalLines) {
            return {text: '', hint: '行号超出范围：文件共 ' + totalLines + ' 行', targetLine: totalLines,
                startLine: null, endLine: null, truncated: false, nextStartLine: null, totalLines};
        }
        const width = String(totalLines).length;
        let out = '';
        let truncated = false;
        let nextStartLine = null;
        for (let i = startLine; i <= endLine; i++) {
            const line = lines[i - 1].replace(/\r$/, '');
            const piece = String(i).padStart(width) + '\t' + line + '\n';
            if (out.length + piece.length > AI_READ_MAX_CHARS) {
                truncated = true;
                nextStartLine = i;
                break;
            }
            out += piece;
        }
        if (!out) out = '（空行区间）\n';
        const hint = truncated ? '…（已截断，继续读请 startLine=' + nextStartLine + '）' : '';
        return {text: out, hint, targetLine: startLine, startLine, endLine,
            truncated, nextStartLine, totalLines};
    }
    // 字符模式：无前缀，保持历史输出格式
    const offset = Math.min(p.offset, raw.length);
    const slice = raw.slice(offset, offset + p.limit);
    const truncated = offset + slice.length < raw.length;
    const targetLine = offset > 0 ? (raw.slice(0, offset).match(/\n/g) || []).length + 1 : 1;
    let hint = '';
    if (truncated) hint = '…（已截断，继续读请 offset=' + (offset + slice.length) + '）';
    else if (offset > 0 && !raw.length) hint = '（空文件）';
    else if (offset >= raw.length && raw.length) hint = '（offset 已到文件末尾，共 ' + raw.length + ' 字符）';
    return {text: slice, hint, targetLine, startLine: null, endLine: null,
        truncated, nextOffset: offset + slice.length, totalLines: null};
}

// —— edit_file ——

// 定位 oldString：默认要求恰好命中一处；CRLF 文件且精确匹配失败时按文件换行重试一次。
// replaceAll=true 时多处命中改为全量替换。返回 {next, count} 或 {error}。
export function locateEditTarget(text, oldString, newString, replaceAll) {
    let needle = oldString;
    let replacement = newString;
    let first = text.indexOf(needle);
    if (first < 0 && text.includes('\r\n') && !oldString.includes('\r')) {
        needle = oldString.replace(/\r?\n/g, '\r\n');
        replacement = newString.replace(/\r?\n/g, '\r\n');
        first = text.indexOf(needle);
    }
    if (first < 0) {
        return {error: '未找到 oldString，请先 read_file 并逐字复制（注意缩进与换行）'};
    }
    let count = 1;
    let at = first;
    while ((at = text.indexOf(needle, at + needle.length)) >= 0) count++;
    if (count > 1 && !replaceAll) {
        return {error: 'oldString 多处命中（' + count + ' 处），请提供更长的唯一上下文，或传 replaceAll=true 全部替换'};
    }
    const next = replaceAll
        ? text.split(needle).join(replacement)
        : text.slice(0, first) + replacement + text.slice(first + needle.length);
    return {next, count, needle, replacement};
}

// —— list_dir ——

// 字节数的人类可读形式（1024 基；一位小数去掉尾零）
export function humanSizeBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v < 1024) return v + 'B';
    const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
    if (v < 1024 * 1024) return trim(v / 1024) + 'KB';
    return trim(v / (1024 * 1024)) + 'MB';
}

// list_dir 递归树（Go ReadDirTree 的结果）→ ├──/└── 文本。目录名带 / 后缀，
// 文件带人类可读大小；Omitted 目录补一行「…（还有条目未列出）」。
// 节点结构见 app_fs.go DirTreeNode；nodes 传 null 时返回占位（空目录）。
export function renderDirTreeText(nodes) {
    const lines = [];
    const walk = (children, prefix) => {
        const list = Array.isArray(children) ? children : [];
        for (let i = 0; i < list.length; i++) {
            const node = list[i] || {};
            const last = i === list.length - 1;
            const branch = last ? '└── ' : '├── ';
            if (node.isDir) {
                lines.push(prefix + branch + (node.name || '') + '/');
            } else {
                const sizeText = humanSizeBytes(node.size);
                lines.push(prefix + branch + (node.name || '') + (sizeText ? '（' + sizeText + '）' : ''));
            }
            if (node.isDir && Array.isArray(node.children) && node.children.length) {
                walk(node.children, prefix + (last ? '    ' : '│   '));
            }
            if (node.isDir && node.omitted) {
                lines.push(prefix + (last ? '    ' : '│   ') + '…（还有条目未列出）');
            }
        }
    };
    walk(nodes, '');
    return lines;
}

// —— search_text ——

// 文件名/相对路径通配：* 任意串、** 跨目录、? 单字符（都不跨 /，** 除外）；
// **/ 可匹配「零个目录段」（src/**/*.js 命中 src/a.js）；模式含 / 时匹配相对路径，
// 否则匹配文件名；大小写不敏感（Windows 语义）。Go 侧 globMatchPath 与本函数同规则。
export function globMatchPath(pattern, relPath, name) {
    const pat = String(pattern || '').trim();
    if (!pat) return true;
    const subject = String(relPath || '').replace(/\\/g, '/');
    const target = pat.includes('/') ? subject : String(name || subject.split('/').pop() || '');
    const wildcard = pat.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000');
    let re = '';
    for (const ch of wildcard) {
        if (ch === '\u0001') re += '(?:.*/)?';
        else if (ch === '\u0000') re += '.*';
        else if (ch === '*') re += '[^/]*';
        else if (ch === '?') re += '[^/]';
        else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    try {
        return new RegExp('^' + re + '$', 'i').test(target);
    } catch (e) {
        // 非法模式按「不过滤」处理，避免一次坏参数把搜索整个打挂
        return true;
    }
}

// —— browser_navigate 的 file:// 解析 ——

// 解码后的本地路径做段归一：\→/、折叠空段与 .、解析 ..（盘符/UNC 分享为地板）。
// 只接受「盘符:/...」与「//server/share/...」两种绝对形式；file:foo.html 会被 URL
// 解析成 file:///foo.html（驱动器相对），语义不明确，一并拒绝。失败返回 ''。
function normalizeLocalFilePath(raw) {
    const text = String(raw || '').replace(/\\/g, '/');
    const drive = /^[A-Za-z]:\//.exec(text);
    const unc = text.startsWith('//');
    let prefix = '';
    let rest = '';
    if (drive) {
        prefix = text.slice(0, 2);
        rest = text.slice(3);
    } else if (unc) {
        rest = text.slice(2);
    } else {
        return '';
    }
    const out = [];
    for (const part of rest.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            // URL 解析器已把 .. 挡在盘符/分享根内，但解码后出现的 ..（%2e%2e）要在这里兜住
            if (out.length <= (unc ? 2 : 0)) return '';
            out.pop();
            continue;
        }
        out.push(part);
    }
    if (unc) return out.length >= 2 ? '//' + out.join('/') : '';
    return prefix + '/' + out.join('/');
}

// file:// 导航目标解析：把 URL 解析成解码后的本地绝对路径。只做解析与归一，不判权限——
// 授权链在 ai-panel 的 resolveReadPathWithApproval（与 read_file 同口径：工作区内直开；
// 工作区外点名/已批准读根直开，read/edit 弹审批、auto/full 直开，应用数据目录硬拒）。
// 通过返回 {ok:true, url（规范化后的可导航地址）, path（解码 + 段归一的本地路径）}；
// 失败返回 {ok:false, reason}。
export function normalizeFileUrlTarget(raw) {
    const text = String(raw || '').trim();
    let u;
    try {
        u = new URL(text);
    } catch (e) {
        return {ok: false, reason: 'file:// 地址格式无效：' + text + '（示例：file:///D:/dir/page.html）'};
    }
    if (u.protocol !== 'file:') {
        return {ok: false, reason: '不是 file:// 地址：' + text};
    }
    let decoded;
    try {
        decoded = decodeURIComponent(u.pathname);
    } catch (e) {
        return {ok: false, reason: 'file:// 地址编码无效：' + text};
    }
    const host = String(u.hostname || '').toLowerCase();
    // pathname 恒以 / 开头：本机形式 /D:/dir/x → D:/dir/x；UNC 形式由 host 拼回 //server/share
    const joined = host && host !== 'localhost' ? '//' + u.hostname + decoded : decoded.replace(/^\//, '');
    const path = normalizeLocalFilePath(joined);
    if (!path) {
        return {ok: false, reason: 'file:// 需要绝对路径（示例：file:///D:/dir/page.html）：' + text};
    }
    return {ok: true, url: u.href, path};
}
