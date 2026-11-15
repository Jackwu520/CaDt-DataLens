// ai-notify-policy.js：通知三通道的投放策略（纯函数，测试直接导入）。
//
// 三个通道各有各的前提，别混成一个「开不开」开关（2026-11-16 作者定稿）：
//
//   · 消息中心      —— 永远记，不在这里判断（可事后查、可点开跳转）。
//   · 应用内 toast  —— 「人在软件里，但看的不是这条会话」时弹；**任务完成不弹**。
//   · Windows 系统卡片 —— 「软件在后台」时弹；前台不打扰。
//   · 任务栏闪烁    —— 软件在后台时的低强度提示（跟着应用内通知开关走）。
//
// 输入：
//   inApp        设置里的「应用内通知」
//   system       设置里的「Windows 系统通知」
//   foreground   本进程有窗口在前台
//   viewingOther 这条通知的会话不是当前正在看的（面板关着也算 true）
//   completion   这是「任务完成」类通知（只在消息中心留痕）
export function desktopNotifyTargets(input) {
    const cfg = input || {};
    const background = cfg.foreground !== true;
    const elsewhere = cfg.viewingOther !== false;
    const silentEvent = cfg.completion === true;
    return {
        // 系统卡片只补「你看不到软件」的场景
        systemToast: cfg.system === true && background,
        // 应用内右下角弹层：人就在软件里、只是没停在那个会话上；任务完成不弹
        inAppToast: cfg.inApp === true && !silentEvent && elsewhere && !background,
        // 任务栏闪烁同理，只在人离开了软件时才有意义
        taskbarFlash: cfg.inApp === true && !silentEvent && background,
    };
}
