// 应用消息的通用元数据与图标：AI 面板里的「应用消息」卡片由任何功能复用，
// 调用方只需给 {kind, label, icon?, content}，不必自己拼消息结构或图标。
import {ICONS} from '../core/icons.js';

// kind -> 默认图标；未登记或未知 kind 一律回落到 info。
export const APP_MESSAGE_ICONS = {
    git: 'git',
    schedule: 'clock',
    browser: 'camera',
    app: 'camera',
    notice: 'info',
    update: 'refresh',
    plugin: 'agents',
    error: 'warn',
    // 子代理结算通知（完成 / 失败）与子代理提问：同一张卡片形态，图标区分「汇报」与「要你拍板」
    subagent: 'agents',
    'subagent-ask': 'bell',
    // 会话间投递（共享信箱）与支线对话带回。
    // session = 其他会话的模型消息（参考信息）；session-user = 用户本人投递/广播（用户指令）——
    // 两者在接收方语义完全相反，卡片页脚文案也跟着分开。
    session: 'bell',
    'session-user': 'bell',
    sidechat: 'bookmark',
};

export function normalizeAppMessage(raw) {
    const app = raw && typeof raw === 'object' ? raw : {};
    const kind = String(app.kind == null ? '' : app.kind).trim().slice(0, 32);
    const label = String(app.label == null ? '' : app.label).trim().slice(0, 80);
    const icon = String(app.icon == null ? '' : app.icon).trim().slice(0, 32);
    return {kind, label: label || '应用消息', icon};
}

export function appMessageIcon(app) {
    const custom = String((app && app.icon) || '').trim();
    if (custom && ICONS[custom]) return custom;
    return APP_MESSAGE_ICONS[String((app && app.kind) || '').trim()] || 'info';
}

// 旧会话没有 app 元数据时，按注入指令的固定前缀识别应用消息。
// 子代理通知 / 提问的卡片由「会话消息化」注入（docs/unfinished-plans/session-messaging.md §4.6），
// 前缀是它们唯一的归属依据：重放旧会话时也要能正确归类，所以 prefix 与 buildSettlementNotice 同源约定。
export function detectAppMessage(content) {
    const text = String(content || '').trim();
    const git = text.match(/^［Git 快捷操作 · ([^］]+)］/);
    if (git) return {kind: 'git', label: 'Git 快捷操作 · ' + git[1].trim(), icon: ''};
    const scheduled = text.match(/^\[定时任务 · ([^\]]+)\]/);
    if (scheduled) return {kind: 'schedule', label: '定时任务 · ' + scheduled[1].trim(), icon: ''};
    if (/^\[浏览器截图（browser_screenshot 工具自动附加）\]/.test(text)) {
        return {kind: 'browser', label: '浏览器截图', icon: 'camera'};
    }
    const ask = text.match(/^［子代理提问 · ([^］]+)］/);
    if (ask) return {kind: 'subagent-ask', label: '子代理提问 · ' + ask[1].trim(), icon: ''};
    const settled = text.match(/^［子代理通知 · ([^］]+)］/);
    if (settled) return {kind: 'subagent', label: '子代理通知 · ' + settled[1].trim(), icon: ''};
    const side = text.match(/^［支线结论 · ([^］]+)］/);
    if (side) return {kind: 'sidechat', label: '支线结论 · ' + side[1].trim(), icon: ''};
    // 用户本人投递（面板里自己写的内容）：是用户指令，与模型投递的「参考信息」区分开
    const userSend = text.match(/^［用户消息 · (?:会话 )?([^］]+)］/);
    if (userSend) return {kind: 'session-user', label: '用户消息 · ' + userSend[1].trim(), icon: ''};
    if (/^［用户消息 · 来自你］/.test(text)) return {kind: 'session-user', label: '用户消息 · 来自你', icon: ''};
    if (/^［系统通知 · 来自你］/.test(text)) return {kind: 'session-user', label: '系统通知 · 来自你', icon: ''};
    // 模型投递（session_send）：身份以会话 id 为准，标题只是补充
    const session = text.match(/^［会话消息 · (?:会话 )?([^］]+)］/);
    if (session) return {kind: 'session', label: '会话消息 · ' + session[1].trim(), icon: ''};
    return null;
}
