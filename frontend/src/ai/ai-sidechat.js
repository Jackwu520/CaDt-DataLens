// ai-sidechat.js：支线对话（用户向旁路会话）。
// 形态：普通持久化会话 + `sideOf` 元数据（指向母会话），列表里紧跟母会话并带「支线」徽标。
// 与「分支会话」（branchSessionAt）的区别：分支是全量分叉、独立重演历史；支线是**轻关联旁路**
// ——不复制母会话历史，上下文靠用户主动引用带入（composer 预填 markdown 引用块），结论靠
// 「带回主对话」送回母会话的信箱（复用 ai-agent-notices 的注入通道）。
// `sideOf` 不嵌套（§4.9.3）：从支线再开支线时归到同一个母会话，永远只有一层。
import {aiTextOf} from './ai-constants.js';

// 引用块：把源消息压成 markdown 引用。太长就截断——支线要的是「从这句话接着问」，
// 不是把整段对话搬过去（搬历史是分支会话的事）。
export function sideChatQuote(title, text) {
    const body = String(text == null ? '' : text).trim();
    if (!body) return '';
    const all = body.split('\n');
    const lines = all.slice(0, 8).map((line) => '> ' + line.slice(0, 240));
    return '> 引用自「' + (String(title || '').trim() || '会话') + '」：\n' + lines.join('\n') +
        (all.length > 8 ? '\n> …' : '') + '\n\n';
}

export function isSideChat(session) {
    return !!(session && aiTextOf(session.sideOf).trim());
}

export function createAISidechat(ctx) {
    const getSessions = ctx.getSessions;
    const sessionById = ctx.sessionById;
    const currentSession = ctx.currentSession;
    const createSessionData = ctx.createSessionData;
    const persistSessions = ctx.persistSessions;
    const switchSession = ctx.switchSession;
    const renderSessionList = ctx.renderSessionList;
    const setDraft = ctx.setDraft;
    const deliverAgentNotice = ctx.deliverAgentNotice;
    const flash = ctx.flash;
    const logActivity = ctx.logActivity;

    // 支线归属的母会话（扁平到一层）：从支线再开支线时仍归到同一个母会话。
    function rootOf(session) {
        if (!session) return null;
        const sideOf = aiTextOf(session.sideOf).trim();
        if (!sideOf) return session;
        return sessionById(sideOf) || session;
    }

    // 新建支线并切过去。quote 非空时预填到新会话的输入草稿（切换后 loadComposerDraft 恢复）。
    function openSideChat(options) {
        const opts = options || {};
        const owner = rootOf(opts.session || currentSession());
        if (!owner) {
            flash('没有可挂靠的母会话', true);
            return null;
        }
        const child = createSessionData('支线 · ' + (owner.title || '新会话'));
        child.sideOf = owner.id;
        // 支线默认只读（同子代理的只读哲学）：用户可在会话里按现有权限档自行升级
        child.scope = 'read';
        if (owner.workspace) child.workspace = owner.workspace;
        const quote = sideChatQuote(owner.title, opts.quote);
        if (quote) setDraft(child.id, quote);
        getSessions().push(child);
        persistSessions();
        logActivity('ai.session', child.id, {op: 'create', title: child.title, sideOf: owner.id}, {actor: 'user', source: 'user'});
        switchSession(child.id);
        renderSessionList();
        flash('已新建支线对话（默认只读）：与「' + (owner.title || '母会话') +
            '」互相独立，可用「带回主对话」把结论送回去');
        return child;
    }

    // 带回主对话：走会话信箱投递（母会话忙→下轮边界，闲→唤醒新轮，删除→兜底提示）。
    function bringBackToParent(session, textOverride) {
        const side = session || currentSession();
        if (!side) return {ok: false, reason: 'no_session'};
        const ownerId = aiTextOf(side.sideOf);
        if (!ownerId) {
            flash('当前不是支线对话，没有母会话可带回', true);
            return {ok: false, reason: 'not_side'};
        }
        const owner = sessionById(ownerId);
        if (!owner) {
            flash('母会话已删除，无法带回这个结论', true);
            return {ok: false, reason: 'gone'};
        }
        const content = String(textOverride == null ? '' : textOverride).trim();
        if (!content) {
            flash('没有可带回的内容', true);
            return {ok: false, reason: 'empty'};
        }
        const title = side.title || '支线';
        const result = deliverAgentNotice(owner, {
            kind: 'sidechat',
            label: '支线结论 · ' + title,
            content: '［支线结论 · ' + title + '］来自支线对话「' + title + '」的结论：\n' + content,
        });
        if (result && result.ok) {
            flash(result.woke
                ? '已带回主对话「' + (owner.title || '母会话') + '」，并为它起了一轮'
                : '已投递到主对话「' + (owner.title || '母会话') + '」的信箱（它当前忙碌，下轮可见）');
            return result;
        }
        flash('带回失败：' + ((result && result.reason) || '未知原因'), true);
        return result || {ok: false, reason: 'unknown'};
    }

    // 提升为独立会话：清掉 sideOf，列表里不再缩进/带徽标，母会话删除也不影响它。
    function promoteSideChat(session) {
        const side = session || currentSession();
        if (!isSideChat(side)) return false;
        side.sideOf = '';
        persistSessions();
        renderSessionList();
        flash('已提升为独立会话');
        return true;
    }

    return {rootOf, openSideChat, bringBackToParent, promoteSideChat, isSideChat};
}
