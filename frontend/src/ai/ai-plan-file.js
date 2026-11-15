// ai-plan-file.js：计划模式产出的计划正文落盘规则（纯函数，可单测）。
//
// 约定：计划正文默认写进 <工作区>/.cadt/plan/，对话区只留一张入口卡（正文去标签页看），
// 所以文件名必须**由消息自身推导**——同一消息任何一次渲染 / 重启后重放都指向同一个文件，
// 不依赖内存里记过的路径。格式：<YYYYMMDD-HHmmss>-<标题 slug>.md。

export const PLAN_DIR_REL = '.cadt/plan';

// 计划标题：优先第一个 ATX 标题（# / ## …），退化到第一行非空文本（去掉列表符号）。
export function planTitleOf(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (m && m[1].trim()) return m[1].trim();
    }
    for (const line of lines) {
        // 退化路径也要先摘掉裸的 # 记号（`#   ` 这种空标题不能变成 '#'）
        const value = line
            .replace(/^\s*#{1,6}\s*/, '')
            .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
            .trim();
        if (value) return value;
    }
    return '';
}

// slug：去掉 Markdown 强调 / 行内代码 / 链接语法，再剔除 Windows 非法字符。
// 中文保留（Windows 文件名支持），按字符数截断，空标题回落 'plan'。
export function planSlug(text, max = 40) {
    const title = planTitleOf(text);
    let value = title
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '');
    value = value
        .replace(/[\\/:*?"<>|]/g, ' ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-. ]+|[-. ]+$/g, '');
    const runes = Array.from(value);
    if (runes.length > max) value = runes.slice(0, max).join('').replace(/[-. ]+$/, '');
    if (!value) return 'plan';
    // Windows 保留设备名（con / nul / com1 …）不能直接做文件名
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) return value + '-plan';
    return value;
}

// 时间戳目录名：本地时间，秒级（同一秒内两次计划极少见，真撞了也只是覆盖同一份内容）。
export function planStamp(ts) {
    const date = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return '' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
        '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

// 工作区相对路径（正斜杠，与 .cadt/ 下其它产物一致）。
export function planFileRelPath(ts, text) {
    return PLAN_DIR_REL + '/' + planStamp(ts) + '-' + planSlug(text) + '.md';
}

// 展示用短路径：从绝对路径里切出 .cadt/plan/… 一段；不是计划文件时回落文件名。
export function planDisplayPath(absPath) {
    const value = String(absPath == null ? '' : absPath).replace(/\\/g, '/');
    const m = value.match(/(?:^|\/)\.cadt\/plan\/[^/]+$/);
    if (m) return m[0].replace(/^\//, '');
    const idx = value.lastIndexOf('/');
    return idx >= 0 ? value.slice(idx + 1) : value;
}

// 卡片上的一句话规模：行数 + 字数（去空白），给「值不值得点开」一个判断依据。
export function planDigest(text) {
    const raw = String(text == null ? '' : text);
    const lines = raw ? raw.split(/\r?\n/).length : 0;
    const chars = raw.replace(/\s+/g, '').length;
    return {title: planTitleOf(raw), lines, chars};
}

// 落盘正文：原文 + 一行 HTML 注释（Markdown 预览不显示，纯文本编辑可见），便于回查来源。
export function planFileBody(text, meta) {
    const raw = String(text == null ? '' : text).replace(/\s+$/, '');
    const info = meta || {};
    const parts = [];
    if (Number(info.ts)) parts.push(planStamp(info.ts));
    if (info.title) parts.push('会话「' + String(info.title).replace(/\s+/g, ' ').trim() + '」');
    if (info.model) parts.push(String(info.model).trim());
    const footer = parts.length ? '\n\n<!-- 计划由 CaDt-DataLens 生成 · ' + parts.join(' · ') + ' -->\n' : '\n';
    return raw + footer;
}

// 计划正文落盘判定：只有「计划模式的最终答复」才算计划——中间工具轮带 toolCalls，
// 停止 / 失败的半成品也不落盘（否则 .cadt/plan/ 会堆一堆残稿）。
export function isPlanMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (!message.planMode) return false;
    if (message.status !== 'done') return false;
    if (Array.isArray(message.toolCalls) && message.toolCalls.length) return false;
    return !!String(message.content == null ? '' : message.content).trim();
}
