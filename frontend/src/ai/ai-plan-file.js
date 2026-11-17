// ai-plan-file.js：计划模式产出的计划正文落盘规则（纯函数，可单测）。
//
// 约定：计划正文在用户批准（「执行计划」）时写进 <工作区>/.cadt/plan/，对话区只留一张入口卡
// （正文去标签页看），所以文件名必须**由会话自身推导**——同一会话永远覆盖同一个文件，
// 继续规划的修订轮落盘时自然演进同一份文档，而不是每次都另起新文件。
// 未批准的计划不落盘：对话里用入口卡 + 虚拟只读标签页预览（openVirtualDoc，不碰磁盘）。
// 格式：plan-<sessionId>.md。

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

// 时间戳（本地时间，秒级）：只用于落盘正文尾部的来源注释，不再参与文件名。
export function planStamp(ts) {
    const date = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return '' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
        '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

// 会话 id 清洗：只留文件名安全字符（参考 ZCode plan-file-continuity 的做法），空值回落 'session'。
export function planSessionSlug(sessionId) {
    const value = String(sessionId == null ? '' : sessionId)
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return value || 'session';
}

// 会话固定路径：同一会话的计划永远落在同一个文件（批准时覆盖写），修订轮自然演进同一份。
export function planFileRelPath(sessionId) {
    return PLAN_DIR_REL + '/plan-' + planSessionSlug(sessionId) + '.md';
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

// 计划消息判定（对话区入口卡 / 审批卡 / 批准落盘 / 回注的共同依据）：
// - 新形态：submit_plan 工具提交，计划正文在 message.planText（正文可为空、带 toolCalls）；
// - 旧形态（兼容历史会话）：计划模式的最终答复，正文即计划，中间工具轮与半成品不算。
export function isPlanMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (message.status !== 'done') return false;
    if (String(message.planText == null ? '' : message.planText).trim()) return true;
    if (!message.planMode) return false;
    if (Array.isArray(message.toolCalls) && message.toolCalls.length) return false;
    return !!String(message.content == null ? '' : message.content).trim();
}

// compact 后的计划回注块（对齐 ZCode 的 plan_file_reference）：压缩把前段消息移入
// session.archived，计划正文随之离开可见历史，只剩摘要。这里从「最近一条计划消息」
// 重建完整计划并包成 model-only 注入块，让压缩后的下一轮仍能"继续按计划执行 / 修订"。
// 只在 summary 存在（发生过压缩）时注入——未压缩时计划全文还在历史里，重复注入纯浪费。
// archived 在前、messages 在后拼接即时间序，遍历取最后一条命中的就是最近的计划。
export function planReferenceBlock(session) {
    if (!session) return '';
    const summary = session.summary;
    if (!summary || !String(summary.text == null ? '' : summary.text).trim()) return '';
    const pool = [];
    if (Array.isArray(session.archived)) pool.push(...session.archived);
    if (Array.isArray(session.messages)) pool.push(...session.messages);
    let plan = null;
    for (const message of pool) {
        if (isPlanMessage(message)) plan = message;
    }
    const content = plan ? String(plan.planText || plan.content || '').trim() : '';
    if (!content) return '';
    const path = plan ? String(plan.planFile == null ? '' : plan.planFile).trim() : '';
    return [
        '<plan_reference>',
        '本会话发生过上下文压缩，此前历史已归档为摘要；下面的计划正文可能已不在可见消息里。',
        path ? '当前计划已保存到工作区文件：' + path + '。' : '当前计划尚未保存为文件（用户批准后落盘）。',
        '',
        content,
        '',
        '如果该计划与当前工作相关且尚未完成，继续按计划推进，不要重新规划；用户发送的补充意见是对本计划的修订要求，基于它输出修订版。',
        '</plan_reference>',
    ].join('\n');
}
