// ai-context-slim.js：实时瘦身的纯判定函数（组装视角剔除，会话历史原样保留）。
// 轮次口径比列表边界（ai-session-store.js isTurnBoundaryMessage）更严：只有用户亲手
// 键入的消息才算一轮；systemNote / steer / notice / app 都是连续过程中的注入，不推窗。

export const SLIM_KEEP_TURNS = 2;
export const SLIM_PRUNE_THRESHOLD = 8192;
export const SLIM_HEAD_CHARS = 4096;
export const SLIM_PRUNABLE_TOOLS = ['read_file', 'web_fetch', 'run_command', 'background_command', 'search_text'];

// 命令输出的结论（失败统计 / 测试结果）不一定压在最尾——结尾可能是长堆栈或编译警告，
// 尾部预算比纯文本工具放宽一倍，降低「失败摘要落在被裁中段」的概率。
const TAIL_CHARS_DEFAULT = 1024;
const TAIL_CHARS_COMMAND = 2048;

// 瘦身视角的「真实用户轮」：
// - systemNote：轮次提醒 / 待办检查等系统注记
// - steer：插话是本轮补充指示
// - notice：信箱折叠注入（子代理结算 / 计时器到点 / 终端退出 / 会话投递）
// - app：应用发起消息与工具中途自动附加的图片/视频（read_image / 截图 / generate_image
//   review）；后台唤醒轮（wakeWith）也带 app 标记。对模型而言这些都是同一任务的延续，
//   计轮会把保留窗口往前挤、裁掉仍在用的上下文。宁可少裁，不可误裁。
export function isRealUserTurn(message) {
    return !!message && message.role === 'user' &&
        !message.systemNote && !message.steer && !message.notice && !message.app;
}

// 保留窗口起点：倒数第 keepTurns+1 条真实用户轮之后的下标；不足则返回 0（全保留）。
// limit 之后的消息不参与判定（压缩预览 / 截断重发按 endIndex 组装）。
export function recentTurnStart(messages, limit, keepTurns = SLIM_KEEP_TURNS) {
    const end = limit == null ? messages.length : limit;
    let seen = 0;
    for (let i = end - 1; i >= 0; i--) {
        if (!isRealUserTurn(messages[i])) continue;
        seen += 1;
        if (seen === keepTurns + 1) return i + 1;
    }
    return 0;
}

// 瘦身已省量的分类明细（浮层自解释用）：固定顺序、过滤零项。
// token 格式化留在面板层（纯模块不依赖 UI 模块）。
export const SLIM_SAVED_LABELS = {
    reasoning: '旧轮思考',
    transient: '重复注入',
    notes: '过期注记',
    toolPrune: '工具结果中段',
};

export function slimBreakdownParts(saved) {
    const src = saved || {};
    return ['reasoning', 'transient', 'notes', 'toolPrune']
        .map((key) => ({key, label: SLIM_SAVED_LABELS[key], tokens: Math.max(0, Number(src[key]) || 0)}))
        .filter((part) => part.tokens > 0);
}

// 过时大工具结果修剪：返回修剪后文本；不在白名单或未超阈值返回 null（不修剪）。
// 头部上下文重要（read_file 的结构信息在头部），命令/搜索的结论常在尾部。
export function pruneToolResult(name, content) {
    const text = String(content == null ? '' : content);
    if (SLIM_PRUNABLE_TOOLS.indexOf(name) < 0 || text.length <= SLIM_PRUNE_THRESHOLD) return null;
    const tail = (name === 'run_command' || name === 'background_command')
        ? TAIL_CHARS_COMMAND : TAIL_CHARS_DEFAULT;
    return text.slice(0, SLIM_HEAD_CHARS) +
        '\n\n[... 中间内容已修剪：原文 ' + text.length + ' 字符，读取于较早轮次、大概率已过时。' +
        '不要凭记忆引用被修剪的中段内容；如需完整内容请重新调用该工具获取 ...]\n\n' +
        text.slice(-tail);
}