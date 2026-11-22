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

// windows-mcp 0.8.9 的 21 个工具 + 本地补丁（0.8.9+p3）新增的 Find，共 22 个。
// 权威清单在 Go 侧 internal/desktopmcp.AllTools（安装时按它写 enabledTools），这里保留一份
// 只用于「还没拿到后端 plan 时的预览 / 浏览器 mock 降级」；两侧一致性由
// internal/desktopmcp/desktopmcp_test.go 与 test/ai/ai-desktop-control.test.mjs 对账。
export const DESKTOP_ALL_TOOLS = Object.freeze([
    'Snapshot', 'Screenshot', 'DisplayInventory', 'Click', 'Type', 'Scroll', 'Move',
    'Shortcut', 'Wait', 'WaitFor', 'Find', 'Clipboard', 'Scrape', 'MultiSelect', 'MultiEdit',
    'App', 'Notification', 'Process', 'PowerShell', 'FileSystem', 'Registry', 'ControlStatus',
]);

// 高风险工具：能执行命令、改系统、批量写或弹系统级提示。
// 2026-11-22 用户裁决：默认**全部勾选**（装好即可用），所以风险不靠默认值兜，
// 而是靠设置页逐项开关 + 一句标注，让「取消勾选」这件事可发现。
export const DESKTOP_HIGH_RISK_TOOLS = Object.freeze([
    'PowerShell', 'FileSystem', 'Registry', 'Process', 'App', 'Clipboard', 'MultiEdit', 'Notification',
]);

// 上游默认 env（原始方案 §2）；人机争用走上游默认 USER_CONTROL（10s 内物理输入优先）。
export const DESKTOP_SERVER_ENV = Object.freeze({
    WINDOWS_MCP_SCREENSHOT_SCALE: '0.75',
    WINDOWS_MCP_DISABLE_FLASH: '1',
    WINDOWS_MCP_SCREENSHOT_BACKEND: 'auto',
    WINDOWS_MCP_MAX_TREE_ELEMENTS: '500',
    WINDOWS_MCP_WATCHDOG: 'off',
    ANONYMIZED_TELEMETRY: 'false',
});

// 写入 mcp.json 的服务器行（2026-11-22 二次改造：内置 wheel + 默认全选）。
// 命令用 uvx --from <内置 wheel>：代码来源固定为随 exe 分发的 0.8.9 wheel，
// 依赖仍由 uv 解析下载（首次约 100–190 MB）；--from 的实现见 internal/desktopmcp。
// plan 来自后端 MCPDesktopPlan()（含真实 wheel 绝对路径、上游工具清单与 notes）；
// 没拿到 plan 时（浏览器 mock / 首帧预览）用 DESKTOP_ALL_TOOLS 与占位路径降级。
// --no-control（2026-11-22 实机裁决）：上游 --control 用 WH_KEYBOARD_LL/WH_MOUSE_LL
// 低级钩子做「桌面所有权」，AI 操作期间吞全部物理输入，实测会把 Alt+Tab /
// Win+Shift+S 等系统组合键卡死到 server 进程退出；授权语义由本应用的会话开关承担。
// 不再传 --tools：工具可见性统一由 enabledTools（应用侧勾选）控制，用户才能逐项开关。
export function desktopServerConfigRow(plan) {
    const tools = Array.isArray(plan && plan.tools) && plan.tools.length
        ? plan.tools.map((tool) => (typeof tool === 'string' ? tool : String(tool && tool.name || ''))).filter(Boolean)
        : DESKTOP_ALL_TOOLS.slice();
    const wheelPath = String((plan && plan.wheelPath) || '').trim();
    const from = wheelPath || '<内置组件路径>';
    return {
        command: String((plan && plan.command) || 'uvx'),
        args: Array.isArray(plan && plan.args) && plan.args.length && wheelPath
            ? plan.args.slice()
            : ['--from', from, 'windows-mcp', 'serve', '--no-control'],
        env: Object.assign({}, DESKTOP_SERVER_ENV),
        enabled: true,
        enabledTools: Array.isArray(plan && plan.enabledTools) && plan.enabledTools.length
            ? plan.enabledTools.slice()
            : tools.slice(),
        startupTimeoutMs: Number((plan && plan.startupTimeoutMs) || 600000),
        notes: String((plan && plan.notes) || '').trim() || DESKTOP_SERVER_NOTES,
    };
}

// 无 plan 时的 notes 兜底（权威文案在 Go 侧 internal/desktopmcp.serverNotes）。
const DESKTOP_SERVER_NOTES = '桌面控制（Computer Use）：第三方原生窗口的 GUI 自动化，工具在用户开启会话授权并'
    + '进入控制模式后才可用。看画面用 Screenshot 或 Snapshot(use_vision=True)（元素带编号，'
    + 'Click/Type/Scroll 传 label=编号 比坐标稳），页面正文用 Scrape(use_dom=True)。'
    + '宿主会把返回的图片存成 PNG 并给出绝对路径，用 read_image 打开即可看到画面。'
    + '只操作用户明确要求的目标窗口，一次任务结束就停，并调 windows_control_mode 退出交还控制权。';

// desktopConfigNeedsUpgrade：已有 mcp.json 行是否是旧形态，需要就地升级。
// 触发条件（任一）：
//   · args 缺 --no-control —— 上游 --control 的 LL 键鼠钩子会吞系统组合键，且会弹
//     「AI is about to take control of this computer」接管确认窗（2026-11-22 用户实测）；
//   · args 缺 --from —— 旧形态从 PyPI 现拉 windows-mcp，而不是用随 exe 分发的内置 wheel；
//   · command 不是 uvx；
//   · enabledTools 为空 —— 空数组语义是「一个都不给」，等于装了却不能用；
//   · --from 指向的 wheel 与后端 plan 给的当前版本路径不一致 —— 版本升级后配置没跟上
//     （2026-11-23 审查：只靠 Go 侧自愈补不回旧路径，必须引导用户更新配置）。
// 注意：**不**拿「是否等于全量清单」当升级条件——用户逐项取消勾选是正常操作，不能被反复判脏。
export function desktopConfigNeedsUpgrade(row, plan) {
    if (!row || typeof row !== 'object') return false;
    const args = Array.isArray(row.args) ? row.args : [];
    if (!args.includes('--no-control')) return true;
    if (!args.includes('--from')) return true;
    if (String(row.command || '') !== 'uvx') return true;
    const have = Array.isArray(row.enabledTools) ? row.enabledTools : [];
    if (have.length === 0) return true;
    // 版本比对只在后端给出 wheelPath 时做（浏览器 mock / 旧后端拿不到 plan 时跳过）
    const expected = String((plan && plan.wheelPath) || '').trim();
    if (expected) {
        const index = args.indexOf('--from');
        const from = index >= 0 ? String(args[index + 1] || '').trim() : '';
        if (from && from !== expected) return true;
    }
    return false;
}

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
