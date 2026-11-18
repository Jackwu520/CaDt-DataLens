// shift-double-tap.js：全局搜索的「双击 Shift」判定（单一来源，纯逻辑，无 DOM 依赖）。
//
// 背景：旧实现在 keydown 里数 600ms 内的 Shift 次数，凑够 3 次就开搜索。它只看 keydown、
// 不看配对、更不看中间按了什么——中文输入法下切中英文 / 打字时夹几次 Shift 就被误触发。
//
// 判定改成 JetBrains Search Everywhere 的口径：两次「干净」的 Shift 轻按（按下 + 抬起），
// 间隔极短，且两次之间没有任何其它按键。四条防线缺一不可：
//   1. 完整 tap：必须有对应 keyup，按住 Shift 不放 / 长按自动重复都不算；
//   2. 短窗口：两次 tap 完成间隔 <= windowMs（默认 400ms，比系统双击阈值更严）；
//   3. 中间无其它键：任意其它 keydown（含打字字母、带修饰键的 Shift）立刻清零配对；
//   4. 输入法隔离：isComposing / keyCode 229（组字中的 Process 键）直接清零。
//
// 时间源可注入（now），便于在 node 里确定性地测各种时序，不用 sleep。

export const DOUBLE_TAP_WINDOW_MS = 400;

/**
 * 建一个「双击 Shift」判定器（JetBrains 口径：两次干净 tap 且间隔极短）。
 * 状态机只保存两个时刻，无定时器；reset() 可在失焦时手动清空。
 * @param {object} [opts] 选项
 * @param {number} [opts.windowMs] 两次 tap 的允许间隔（默认 DOUBLE_TAP_WINDOW_MS）
 * @param {() => number} [opts.now] 时间源，便于测试注入假时钟
 * @returns {{onKeyDown: Function, onKeyUp: Function, reset: Function, pendingDown: boolean, armed: boolean}}
 *          事件入口与两个只读状态
 */
export function createShiftDoubleTap({windowMs = DOUBLE_TAP_WINDOW_MS, now = () => Date.now()} = {}) {
    let pendingDownAt = 0; // >0 表示一个干净 Shift keydown 正等待自己的 keyup
    let firstTapAt = 0;    // >0 表示第一次完整 tap 的完成时刻，等待第二次配对

    function isComposing(e) {
        return !!(e && (e.isComposing || e.keyCode === 229));
    }

    function isCleanShiftDown(e) {
        return !!e && e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey &&
            !e.repeat && !isComposing(e);
    }

    function reset() {
        pendingDownAt = 0;
        firstTapAt = 0;
    }

    // keydown：只登记候选，真正触发在 keyup。返回恒 false，保留返回值只为对称。
    function onKeyDown(e) {
        if (isComposing(e)) {
            reset();
            return false;
        }
        if (isCleanShiftDown(e)) {
            if (!pendingDownAt) pendingDownAt = now();
            return false;
        }
        // 任意其它 keydown（打字字母、带修饰键的 Shift、长按 repeat、输入法 Process）
        // 都说明这不是一次孤立的 Shift 轻按，整段配对作废。
        reset();
        return false;
    }

    // keyup：一次完整的 Shift 轻按在此结算；返回 true 表示双击成立。
    function onKeyUp(e) {
        if (isComposing(e)) {
            reset();
            return false;
        }
        if (!e || e.key !== 'Shift' || e.ctrlKey || e.altKey || e.metaKey) {
            reset();
            return false;
        }
        if (!pendingDownAt) {
            // 没有对应的 keydown（可能被输入法吞掉），不成 tap
            reset();
            return false;
        }
        const at = now();
        pendingDownAt = 0;
        if (firstTapAt && at - firstTapAt <= windowMs) {
            reset();
            return true;
        }
        firstTapAt = at;
        return false;
    }

    return {
        onKeyDown,
        onKeyUp,
        reset,
        get pendingDown() { return pendingDownAt > 0; },
        get armed() { return firstTapAt > 0; },
    };
}
