// 补丁的呈现策略（纯函数）：决定 propose_patch 是否弹审批卡，还是只产出 .patch 文件。
//
// 背景：完全权限档的语义是「别打断我」，但补丁本身是可分享/可转交的交付物，
// 用户也常需要它。两者兼顾的做法是——完全权限下默认只落盘一份 .patch 并给出路径，
// 不弹审批接管卡；只有用户明确说要「应用」时才走审批卡。其他档位一切照旧。
import {aiTextOf} from './ai-constants.js';

// 用户明确要求「把补丁应用上去」的措辞（只有这些才值得在完全权限下打断用户）
const PATCH_APPLY_REQUEST_RE = /(应用|apply|落地|打上|合入|改上去|用这个补丁|就用这个|直接打)/i;

// lastUserTextOf 取最后一条用户消息的纯文本（兼容字符串与多段内容数组）。
export function lastUserTextOf(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'user') continue;
        const content = message.content;
        if (Array.isArray(content)) {
            return content
                .map((part) => (part && typeof part === 'object' ? aiTextOf(part.text) : aiTextOf(part)))
                .join(' ')
                .trim();
        }
        return aiTextOf(content).trim();
    }
    return '';
}

// patchAllowApply 是否在审批卡上提供「应用」按钮（= 是否弹卡）。
// - 模型显式 apply:false：只产出文件，永远不弹卡
// - 非完全权限档：保持原行为（默认弹卡，用户当场决定）
// - 完全权限档：只有用户明确说「应用」才弹卡，否则只产出文件
export function patchAllowApply(input, scope, lastUserText) {
    if (input && input.apply === false) return false;
    if (scope !== 'full') return true;
    return PATCH_APPLY_REQUEST_RE.test(String(lastUserText || ''));
}
