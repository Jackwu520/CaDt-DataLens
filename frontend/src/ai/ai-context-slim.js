// ai-context-slim.js：实时瘦身的纯判定函数（组装视角剔除，会话历史原样保留）。
// 轮次口径比列表边界（ai-session-store.js isTurnBoundaryMessage）更严：只有用户亲手
// 键入的消息才算一轮；systemNote / steer / notice / app 都是连续过程中的注入，不推窗。

export const SLIM_KEEP_TURNS = 2;
export const SLIM_PRUNE_THRESHOLD = 8192;
// 外部工具（MCP / 第三方插件）的中等结果值得留在上下文里：8–50 K 的查询结果往往正是
// 模型接下来要直接引用的数据，落盘再读回来要多花一轮工具调用。ZCode 对普通 MCP 给的
// 模型预算就是 50 000 字节（`mcp/index.ts` 的 `maxModelBytes: 50_000`），这里沿用它作为
// 「落盘门槛」，`mcp__` 与 `plugin__` 同档——两者都是「返回体量不受我们控制」的第三方实现。
// 内置工具仍按 8 192 走——它们的输出多是「看一眼就够」的命令日志与网页正文。
export const SLIM_EXTERNAL_PRUNE_THRESHOLD = 50000;
export const SLIM_HEAD_CHARS = 4096;
// 永不过预算判定的工具（黑名单）。这里列的是「自带窗口」或「结果就是操作回执、
// 不可重得」的工具；**其余一律按体量判定，包括 MCP 工具**。
// 旧实现是白名单（只列 5 个内置工具），MCP 全被漏在外面——实测一个会话里
// aici/aoci 这类 MCP 的 553K 回显原样进了上下文，四家参考 harness 没有一个这么干
// （ZCode 给 MCP 单列 resultBudget，dsh/opencode 走通用管道）。
export const SLIM_SKIP_TOOLS = [
    // 自带行窗口：64KB 截断 + startLine 续读，再削只会让模型多跑一轮
    'read_file',
    // 写/改/补丁/派单/待办/提问的结果是操作回执，体积小且重跑有副作用
    'write_file', 'edit_file', 'apply_patch', 'propose_patch', 'patch_manage',
    'spawn_agent', 'agent_send', 'agent_stop', 'agent_compact', 'todo_write', 'ask_user',
];

// 命令输出的结论（失败统计 / 测试结果）不一定压在最尾——结尾可能是长堆栈或编译警告，
// 尾部预算比纯文本工具放宽一倍，降低「失败摘要落在被裁中段」的概率。
const TAIL_CHARS_DEFAULT = 1024;
const TAIL_CHARS_COMMAND = 2048;

function tailBudgetOf(name) {
    return (name === 'run_command' || name === 'background_command')
        ? TAIL_CHARS_COMMAND : TAIL_CHARS_DEFAULT;
}

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
    argsPrune: '过期工具参数',
};

export function slimBreakdownParts(saved) {
    const src = saved || {};
    return ['reasoning', 'transient', 'notes', 'toolPrune', 'argsPrune']
        .map((key) => ({key, label: SLIM_SAVED_LABELS[key], tokens: Math.max(0, Number(src[key]) || 0)}))
        .filter((part) => part.tokens > 0);
}

// 这个工具结果是否该移出上下文（落盘 + 指针，或修剪中段）。判据只有两条：
// 不在跳过表里、且超过该工具的阈值。不看读或写——写入类的结果通常只是 ack，
// 天然到不了阈值；真到了（如 MCP 回吐全量），按「模型后面还需不需要原文」处理即可，
// 由调用方决定给不给落盘路径。
export function spillWanted(name, content) {
    const text = String(content == null ? '' : content);
    if (SLIM_SKIP_TOOLS.indexOf(name) >= 0) return false;
    return text.length > pruneThresholdOf(name);
}

// 阈值按来源分档：外部工具（mcp__<server>__<tool> / plugin__<id>）50 K，内置 8 192。
// 两者同档的理由是「返回体量不受我们控制」，与是不是走 MCP 协议无关。
export function pruneThresholdOf(name) {
    const value = String(name == null ? '' : name);
    const external = value.startsWith('mcp__') || value.startsWith('plugin__');
    return external ? SLIM_EXTERNAL_PRUNE_THRESHOLD : SLIM_PRUNE_THRESHOLD;
}

// 落盘版：头 + 指针 + 尾。指针必须回答三件事——文件在哪、怎么读、什么时候不必读。
export function spillPointerText(name, content, path) {
    const text = String(content == null ? '' : content);
    return text.slice(0, SLIM_HEAD_CHARS) +
        '\n\n[... 结果过长：原文 ' + text.length + ' 字符，已存盘。完整内容：' + path +
        '\n  需要时用 read_file 读该路径（支持 offset 续读）；不需要就别读，' +
        '按上面的预览作答即可。]\n\n' +
        text.slice(-tailBudgetOf(name));
}

// 没有落盘路径时的老路：丢掉中段，提示重新调用（不可重得的结果就别调用，按头部作答）。
// 头部上下文重要（结构信息在头部），命令/搜索的结论常在尾部。
export function pruneToolResult(name, content) {
    const text = String(content == null ? '' : content);
    if (!spillWanted(name, text)) return null;
    return text.slice(0, SLIM_HEAD_CHARS) +
        '\n\n[... 中间内容已修剪：原文 ' + text.length + ' 字符，读取于较早轮次、大概率已过时。' +
        '不要凭记忆引用被修剪的中段内容；如需完整内容请重新调用该工具获取 ...]\n\n' +
        text.slice(-tailBudgetOf(name));
}

// 组装请求时的统一入口：有落盘路径走指针，没有就走修剪，都不需要返回 null（不改动）。
export function slimToolResult(name, content, artifactPath) {
    if (artifactPath) return spillPointerText(name, content, artifactPath);
    return pruneToolResult(name, content);
}

// ---------- 应急收缩（按压力，不调模型） ----------
// 常规修剪按「龄」走（倒数第 2 轮以前），够用是因为旧轮次自然变远。但当窗口快满、
// 而最近两轮恰好塞了几个大结果时，按龄的规则帮不上忙——这时要么硬着头皮调模型做摘要
// （贵、且丢细节），要么本地先降载。ZCode 的 microcompact 就是这一档（0.9 触发、
// 保留最近 5 个工具结果、空闲 60 分钟也触发），codex 的 token-budget 压缩同理。
// 我们把它做成组装视角的「放宽老化窗口」：只改发出去的内容，会话历史原样不动。
export const SHRINK_PRESSURE_RATIO = 0.9;
// 压力模式下不动的最近工具结果数：模型正在用的数据被清掉，它得重跑一遍工具，
// 那个往返比省下的 token 更贵（ZCode 同样是 5）。
export const SHRINK_KEEP_TOOL_RESULTS = 5;

// 占用是否已经到「该应急降载」的程度。windowSize 未知（未配模型）时恒 false。
export function underContextPressure(usedTokens, windowSize) {
    const window = Number(windowSize) || 0;
    if (!(window > 0)) return false;
    return (Number(usedTokens) || 0) / window >= SHRINK_PRESSURE_RATIO;
}

// 最近 N 个「已落定」工具结果的下标：压力模式下这些不修剪。
export function recentToolIndexes(messages, limit, keep) {
    const out = new Set();
    const end = limit == null ? (Array.isArray(messages) ? messages.length : 0) : limit;
    const want = Math.max(0, Number(keep) || 0);
    if (!want) return out;
    for (let i = end - 1; i >= 0 && out.size < want; i--) {
        const m = messages[i];
        if (m && m.role === 'tool' && m.status !== 'running') out.add(i);
    }
    return out;
}

// ---------- 过期工具参数折叠 ----------
// 场景：整批提交类 MCP（如 aoci_update_entry）只要有一条不合规就 applied=0 整批退回，
// 模型改完只能整批重发。旧那批 40+ 条的完整参数（JSON 阵列，动辄 20 K+ 字符）留在
// assistant 消息里已经没有任何复用价值——实测这类会话里同一工具调用 31 次，
// 失败批次的参数累计 35 万字符，全是重复内容。
//
// 判定只依赖两件可观测的事，不解析业务 schema：
// ① 该调用的结果带「服务端没有接收本次提交」的回执标记；
// ② 同一工具在其后又被调用过，且那次成功了（严格版：只折叠确已被后续成功取代的）。
// 保守起见不折叠「还没成功重试过」的批次——那种情况下旧参数仍可能是下一次重发的底稿。

// 参数折叠门槛：比工具结果阈值宽一些，小参数折叠没有收益还打扰模型。
export const SLIM_ARGS_FOLD_THRESHOLD = 8192;

// 「整批未接收」的回执标记。**这是唯一知道具体语义的地方**：目前已知来源是 aoci 的
// repair_required / stopped（JSON 两种空格写法都认）；接入新的整批提交类 MCP 时加一行即可。
export const SLIM_ROLLBACK_MARKERS = [
    '"status":"repair_required"',
    '"status": "repair_required"',
    '"status":"stopped"',
    '"status": "stopped"',
];

function isRollbackReceipt(content) {
    const text = String(content == null ? '' : content);
    if (!text) return false;
    return SLIM_ROLLBACK_MARKERS.some((marker) => text.indexOf(marker) >= 0);
}

// 返回「参数应被折叠」的 toolCallId 集合。
export function foldSupersededToolCalls(messages, limit) {
    const out = new Set();
    if (!Array.isArray(messages)) return out;
    const end = limit == null ? messages.length : limit;
    // toolCallId → 结果消息
    const resultOf = new Map();
    for (let i = 0; i < end; i++) {
        const m = messages[i];
        if (m && m.role === 'tool' && m.toolCallId) resultOf.set(m.toolCallId, m);
    }
    // 调用序列（按出现顺序），顺便把每个调用的结果性质判定一次：
    // rolledBack = 服务端整批未接收；success = 明确成功（非 running / 非 error / 无回退标记）。
    const calls = [];
    for (let i = 0; i < end; i++) {
        const m = messages[i];
        if (!m || m.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (const call of m.toolCalls) {
            if (!call || !call.id) continue;
            const args = typeof call.arguments === 'string' ? call.arguments : '';
            const result = resultOf.get(call.id);
            const settled = !!result && result.status !== 'running';
            calls.push({
                id: call.id,
                name: call.name || '',
                len: args.length,
                rolledBack: settled && isRollbackReceipt(result.content),
                success: settled && result.status !== 'error' && !isRollbackReceipt(result.content),
            });
        }
    }
    // 倒序扫一遍：lastSuccessByName 里放的是「k 之后」的同名成功调用，
    // 有就说明这批参数已经被后来的成功提交取代，可以折叠。O(n)。
    const lastSuccessByName = new Set();
    for (let k = calls.length - 1; k >= 0; k--) {
        const call = calls[k];
        if (call.len > SLIM_ARGS_FOLD_THRESHOLD && call.rolledBack && lastSuccessByName.has(call.name)) {
            out.add(call.id);
        }
        if (call.success) lastSuccessByName.add(call.name);
    }
    return out;
}

// 折叠后的参数：保留「这里发生过什么」的线索，明确禁止复用。
export function foldedToolArguments(originalLength) {
    return JSON.stringify({
        note: '此调用的参数已省略：服务端整批未接收（需整批重发），该工具其后已调用成功，' +
            '原参数 ' + originalLength + ' 字符不再保留。不要复用这批旧参数，以最近一次成功提交为准。',
    });
}