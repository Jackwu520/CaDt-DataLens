// ai-compact.js：上下文压缩的应用内核（会话无关，主会话与子代理共用）。
// 从 ai-panel.js 的 `finishCompact` 逐字搬出「cutoff 计算 + summary 形状 + messages 裁剪」，
// 参数化后可被两处调用：
//   - 主会话：磁盘归档（sessionStore.archiveSession）、渲染、队列冲刷仍留在 panel；
//   - 子代理：只做内存裁剪，转录（subAgentTranscripts）是展示层、独立于 messages，
//     所以详情视图全程可看（展示与上下文分离）。
// 压缩请求的组装（system prompt + 转录）也在本模块，避免两处各写一份提示词。
import {aiTextOf} from './ai-constants.js';

// 摘要里保留的尾部条数下限（压缩后至少留这么多条，保证「当前正在做什么」还在上下文里）
export const COMPACT_KEEP_TAIL = 6;
// 压缩转录的硬上限（提示词输入，不随会话无界增长）
const TRANSCRIPT_MAX = 120000;

// cutoff：保留最近 N 条，并**回退到最近的 user 轮边界**——一轮不能从 assistant / tool
// 中间切开，否则压缩后首条是工具结果，模型看不懂自己在干什么。
export function computeCompactCutoff(messages, keepTail) {
    const list = Array.isArray(messages) ? messages : [];
    const keep = Math.max(1, Number(keepTail) || COMPACT_KEEP_TAIL);
    let cutoff = Math.max(0, list.length - keep);
    while (cutoff > 0 && list[cutoff] && list[cutoff].role !== 'user') cutoff--;
    return cutoff;
}

// summary 形状：磁盘 meta 与 buildApiMessages 的 `<conversation_summary>` 注入都认这个形状。
export function buildCompactSummary(text, cutoff, trigger, totalMessages) {
    return {
        text: String(text == null ? '' : text).trim(),
        upTo: cutoff,
        createdAt: Date.now(),
        trigger: trigger || null,
        before: {messages: Number(totalMessages) || 0, archived: cutoff},
    };
}

// 应用：裁剪 messages 并写回 summary，返回被归档的那段（调用方决定是否落盘 / 推送归档列表）。
export function applyCompactToSession(session, summary, cutoff) {
    if (!session) return {archived: [], kept: 0};
    const limit = Math.max(0, Math.min(Number(cutoff) || 0, session.messages.length));
    const archived = session.messages.slice(0, limit);
    session.messages = session.messages.slice(limit);
    session.summary = summary;
    return {archived, kept: session.messages.length};
}

// 压缩转录：喂给摘要模型的对话记录（工具结果也带上，否则摘要会丢掉关键事实）。
export function compactTranscriptOf(session) {
    const source = session || {};
    const parts = [];
    if (source.summary && aiTextOf(source.summary.text).trim()) {
        parts.push('此前摘要：\n' + aiTextOf(source.summary.text).trim());
    }
    for (const message of source.messages || []) {
        if (!message) continue;
        if (message.role === 'tool') {
            if (aiTextOf(message.content).trim()) {
                parts.push('[工具 ' + (message.name || '') + ' 结果]\n' + aiTextOf(message.content).trim());
            }
            continue;
        }
        const text = aiTextOf(message.content).trim();
        const imageCount = Array.isArray(message.images) ? message.images.length : 0;
        if (!text && !imageCount) continue;
        parts.push((message.role === 'user' ? '用户' : 'AI') + '：\n' + (text || '（仅图片）') +
            (imageCount ? '\n（附图 ' + imageCount + ' 张）' : ''));
    }
    let transcript = parts.join('\n\n');
    if (transcript.length > TRANSCRIPT_MAX) transcript = '…（较早内容已截断）\n\n' + transcript.slice(-TRANSCRIPT_MAX);
    return transcript;
}

// 压缩请求的消息体（system = 摘要器约束；user = 转录 + 可选焦点指令）。
export function buildCompactMessages(session, systemPrompt, instruction) {
    const focus = aiTextOf(instruction).slice(0, 500);
    return [
        {role: 'system', content: systemPrompt},
        {
            role: 'user',
            content: '请压缩以下对话记录：\n\n' + compactTranscriptOf(session) +
                (focus ? '\n\n用户压缩指令（摘要须优先落实）：' + focus : ''),
        },
    ];
}

// 自动压缩阈值（0.5–0.95，默认 0.8）：主会话与子代理共用同一口径。
export function compactThresholdOf(config) {
    const value = Number(config && config.autoCompactThreshold) || 0.8;
    return Math.min(0.95, Math.max(0.5, value));
}
