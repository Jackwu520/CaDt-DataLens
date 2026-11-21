// ai-desktop-control.js：桌面控制（Computer Use）——会话级启用 + 控制模式声明。
//
// 2026-11-22 用户重设计（取代 desktop-mcp.md §5.2 的「应用级单飞 + 懒加载揭示」）：
//   ① 安装（应用级）：外部工具页一个「启用桌面控制」开关，安装按钮一键写入 mcp.json 行
//      并勾选白名单工具（未安装时开关呈禁用态）；
//   ② 会话启用（session.desktopEnabled，与 planMode / worktree 同族的会话字段）：用户点
//      权限面板开关（二次确认）或 AI 经 app_control 的 request_desktop_control 申请
//      （危险审批卡，全档必弹）后置真；关闭不弹；
//   ③ 控制模式（windows_control_mode 工具，进出都不审批）：模型声明进入后，白名单桌面
//      工具才全量注入工具表，面板顶部挂「AI 正在控制你的电脑」跑马灯；退出即移除。
//
// 相对旧模型的两点简化（用户裁决）：
//   · 取消应用级单飞：授权按会话独立，允许多个会话同时启用；
//   · 取消 windows_desktop 懒加载揭示：控制模式本身就是显式闸，再叠一层两次往返的揭示只会
//     让模型多看一个前置、并吃到「同一条消息并行调用必被拒一次」的坑。成本只在控制模式期间
//     支付（7 份 schema），退出即从工具表移除。
//
// 控制模式状态只存内存（不落盘）：应用重启即清空——「AI 正在控制你的电脑」不允许跨重启
// 静默延续。会话启用状态落 session 字段，随会话存档。
// 判定只认 server 名（def.mcpServer === 'windows'），绝不读 annotations、不猜描述。

export const DESKTOP_MCP_SERVER = 'windows';

// 桌面工具公开名前缀：mcp__<server>__<raw>（internal/mcp/mcp_name.go 的纯函数映射）。
export function isDesktopToolName(name) {
    return typeof name === 'string' && name.startsWith('mcp__' + DESKTOP_MCP_SERVER + '__');
}

// MCP 快照工具 def（ai-mcp.js mcpToolToDef 形态）判定：只认 server 字段。
export function isDesktopToolDef(def) {
    return !!(def && def.mcpServer === DESKTOP_MCP_SERVER);
}

// 服务器行白名单（§10 决策 3 + §12.9 决策 5）：观察组 + 输入组，砍 Screenshot
// （MCP 客户端把 image 结果降级成占位文本，§12.1），排除 Registry / Process /
// App / PowerShell / FileSystem（dsh 同款默认排除 + 本项目 MCP 参数不过路径闸）。
export const DESKTOP_TOOLS_WHITELIST = ['Snapshot', 'Click', 'Move', 'Scroll', 'Type', 'Shortcut', 'Clipboard'];

// dsh 同款默认 env（§2）；人机争用走上游默认 USER_CONTROL（10s 内物理输入优先）。
export const DESKTOP_SERVER_ENV = Object.freeze({
    WINDOWS_MCP_SCREENSHOT_SCALE: '0.75',
    WINDOWS_MCP_DISABLE_FLASH: '1',
    WINDOWS_MCP_SCREENSHOT_BACKEND: 'auto',
    WINDOWS_MCP_MAX_TREE_ELEMENTS: '500',
    WINDOWS_MCP_WATCHDOG: 'off',
    ANONYMIZED_TELEMETRY: 'false',
});

// 安装按钮写入 mcp.json 的服务器行：命令用 uvx 直跑（首次自动下载解释器与依赖）。
// 与旧形态（enabled:false + enabledTools:[]，装完还要用户手动勾选）不同，这里一步到位——
// 用户要的是「安装完就能用」，工具白名单已由 --tools 限定，勾选清单与它同源。
// startupTimeoutMs 给到上限 600000（10 分钟）：默认 30s 容不下 uvx 首次下载
// Python 3.14 解释器 + 依赖；之后缓存命中，大值无害（mcp_config.go 上限即此值）。
// --no-control（2026-11-22 实机裁决）：上游 --control 用 WH_KEYBOARD_LL/WH_MOUSE_LL
// 低级钩子做「桌面所有权」，AI 操作期间吞全部物理输入，实测会把 Alt+Tab /
// Win+Shift+S 等系统组合键卡死到 server 进程退出；授权语义由本应用的会话开关承担。
// notes 是给模型的使用约定（≤1000 字，mcpNotesBlock 注入），写清边界与首次启动耗时。
export function desktopServerConfigRow() {
    return {
        command: 'uvx',
        args: ['windows-mcp@0.8.9', 'serve', '--tools', DESKTOP_TOOLS_WHITELIST.join(','), '--no-control'],
        env: Object.assign({}, DESKTOP_SERVER_ENV),
        enabled: true,
        enabledTools: DESKTOP_TOOLS_WHITELIST.slice(),
        startupTimeoutMs: 600000,
        notes: '桌面控制（Computer Use）：第三方原生窗口的 GUI 自动化。工具白名单只含观察组与输入组'
            + '（无 Screenshot：宿主客户端暂不能显示 MCP 图像结果；无 Registry/Process/App/PowerShell/FileSystem）。'
            + '首次启动 uvx 会下载 Python 3.14 解释器与依赖（约 100 MB，耗时数分钟，启动超时已放宽到 10 分钟；'
            + '下载完成后启动只需几秒）。'
            + '只操作用户明确要求的目标窗口，一次任务结束就停，不要顺手点别的东西；'
            + '任务结束时调 windows_control_mode 退出，让用户知道控制已交还。',
    };
}

// controlModeInputNorm：windows_control_mode 的 action 归一（容忍大小写与常见别名）。
export function controlModeActionOf(input) {
    const raw = String((input && input.action) || '').trim().toLowerCase();
    if (raw === 'exit' || raw === 'leave' || raw === 'stop' || raw === 'off' || raw === '退出') return 'exit';
    if (raw === 'status' || raw === 'state' || raw === '状态') return 'status';
    if (raw === 'enter' || raw === 'start' || raw === 'on' || raw === '进入') return 'enter';
    return '';
}

export function createAIDesktopControl(ctx) {
    // ctx: mcpToolDefs（快照 defs 读口）· onControlChange（进入/退出后通知面板重绘跑马灯与胶囊）
    const mcpToolDefs = () => ((ctx && typeof ctx.mcpToolDefs === 'function') ? ctx.mcpToolDefs() : []);
    const onControlChange = (session) => {
        if (ctx && typeof ctx.onControlChange === 'function') ctx.onControlChange(session);
    };

    // 控制模式只存内存：sessionId -> {since, reason}。重启即清空（安全默认）。
    const live = new Map();

    // 快照里属于桌面 server 的工具定义（受 MCP 勾选影响：未勾选的不在快照里）。
    function desktopDefs() {
        return mcpToolDefs().filter(isDesktopToolDef);
    }

    // 桌面能力是否「已安装可用」：外部工具页开关的可用性判定（false = 禁用态）。
    function installedCount() {
        return desktopDefs().length;
    }

    // 会话级启用（session.desktopEnabled 由面板读写，这里只做判定）。
    function enabledOn(session) {
        return !!(session && session.desktopEnabled === true);
    }

    function activeOn(session) {
        return !!(session && session.id && live.has(session.id));
    }

    function activeInfo(session) {
        if (!session || !session.id) return null;
        const entry = live.get(session.id);
        return entry ? {since: entry.since, reason: entry.reason} : null;
    }

    // 进入控制模式：三道前置（会话启用 / 桌面 server 有工具）任一不满足就返回结构化原因，
    // 由执行层翻译成人话。**不审批**——授权已在启用那一步过过审批卡，这里只是声明。
    function enter(session, reason) {
        if (!session || !session.id) return {ok: false, reason: 'no-session'};
        if (!enabledOn(session)) return {ok: false, reason: 'not-enabled'};
        if (!installedCount()) return {ok: false, reason: 'not-installed', tools: []};
        const already = live.has(session.id);
        if (!already) {
            live.set(session.id, {since: Date.now(), reason: String(reason || '').trim()});
            onControlChange(session);
        }
        return {ok: true, already, tools: desktopDefs().map((def) => def.name)};
    }

    // 退出控制模式：幂等、不审批（用户明确要求 AI 可主动退出）。
    function exit(session) {
        if (!session || !session.id) return {ok: false, reason: 'no-session'};
        const had = live.delete(session.id);
        if (had) onControlChange(session);
        return {ok: true, wasActive: had};
    }

    // 会话关闭 / 归档 / 删除时收尾（面板调用）：控制模式不允许留在无人查看的会话上。
    function clearSession(sessionId) {
        if (sessionId) live.delete(String(sessionId));
    }

    // toolsForScope 注入口：只有「会话启用 + 正在控制模式 + 写权限档非计划模式」才注入
    // 白名单桌面工具（档位/计划模式判定在 toolsForScope 侧，这里只回答会话态）。
    function defsForSession(session) {
        return activeOn(session) ? desktopDefs() : [];
    }

    return {
        installedCount,
        enabledOn,
        activeOn,
        activeInfo,
        enter,
        exit,
        clearSession,
        defsForSession,
        // 只读快照副本（诊断 / 设置页显示用）
        snapshot: () => ({installed: installedCount(), sessions: [...live.keys()]}),
    };
}
