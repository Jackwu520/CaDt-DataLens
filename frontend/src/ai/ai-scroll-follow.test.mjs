// ai-scroll-follow 护栏：只有用户手势引起的上滚才解除贴底。
// 任务清单 / 审批卡出现后消息区靠 padding-bottom 让位（scrollHeight 变大、滚动条 thumb 被顶上
// 去），os 收起时 scrollTop 还会被钳小——这两种都不是用户在滚，旧判定会当成上翻，
// 之后（尤其流已结束、正在等审批时）就再也不跟随触底。
import test from 'node:test';
import assert from 'node:assert/strict';
import {BOTTOM_SLACK, SHRINK_BURST, STRICT_BOTTOM_PX, USER_SCROLL_GRACE_MS, createScrollGesture, createShrinkBurst, nextStickState, shouldRefollowGrowth} from './ai-scroll-follow.js';

test('贴底态：底部留白变高 / scrollTop 被钳小仍保持贴底，并要求补底', () => {
    const next = nextStickState({stickBottom: true, lastTop: 900, byUser: false}, {top: 700, distance: 400});
    assert.deepEqual(next, {stickBottom: true, refollow: true});
});

test('上翻态：布局变化不夺权也不补底，用户阅读位置保持', () => {
    const next = nextStickState({stickBottom: false, lastTop: 400, byUser: false}, {top: 300, distance: 800});
    assert.deepEqual(next, {stickBottom: false, refollow: false});
});

test('用户上滚：哪怕只滚 1px 也解除贴底', () => {
    const next = nextStickState({stickBottom: true, lastTop: 500, byUser: true}, {top: 499, distance: 6});
    assert.deepEqual(next, {stickBottom: false, refollow: false});
});

test('用户滚回近底：恢复到 BOTTOM_SLACK 以内就重新贴底，超出仍保持解除', () => {
    const near = nextStickState({stickBottom: false, lastTop: 100, byUser: true}, {top: 400, distance: BOTTOM_SLACK});
    assert.deepEqual(near, {stickBottom: true, refollow: false});
    const far = nextStickState({stickBottom: false, lastTop: 100, byUser: true}, {top: 400, distance: BOTTOM_SLACK + 1});
    assert.deepEqual(far, {stickBottom: false, refollow: false});
});

test('用户向下滚但还没到底：维持解除，不硬拽会底部', () => {
    const next = nextStickState({stickBottom: false, lastTop: 120, byUser: true}, {top: 300, distance: 600});
    assert.deepEqual(next, {stickBottom: false, refollow: false});
});

test('非用户原因落到近底（内容收缩 / 重排带回来）：恢复贴底且无需补底', () => {
    const next = nextStickState({stickBottom: false, lastTop: 300, byUser: false}, {top: 320, distance: 12});
    assert.deepEqual(next, {stickBottom: true, refollow: false});
});

test('distance 为负（顶部 overscroll）或缺失时按近底处理，不误判成上翻', () => {
    assert.equal(nextStickState({stickBottom: false, lastTop: 0, byUser: false}, {top: 0, distance: -3}).stickBottom, true);
    assert.equal(nextStickState({stickBottom: false, lastTop: 0, byUser: false}, {top: 0}).stickBottom, true);
});

test('手势窗口：note 覆盖整个宽限期，过期即失效', () => {
    let t = 1000;
    const g = createScrollGesture(() => t);
    assert.equal(g.active(), false);
    g.note();
    assert.equal(g.active(), true);
    t += USER_SCROLL_GRACE_MS - 1;
    assert.equal(g.active(), true);
    t += 2;
    assert.equal(g.active(), false);
});

test('拖滚动条：begin 后超过宽限期仍算用户手势，end 后留一段惯性宽限期', () => {
    let t = 0;
    const g = createScrollGesture(() => t);
    g.begin();
    t += USER_SCROLL_GRACE_MS * 5;
    assert.equal(g.active(), true);
    g.end();
    assert.equal(g.active(), true);
    t += USER_SCROLL_GRACE_MS + 1;
    assert.equal(g.active(), false);
});

test('未进入拖拽态时的 end 是空操作：点消息正文不会续上「用户在滚」', () => {
    let t = 0;
    const g = createScrollGesture(() => t);
    g.end();
    assert.equal(g.active(), false);
    g.note(100);
    t = 50;
    assert.equal(g.active(), true);
    g.end(); // 未 begin
    t = 150;
    assert.equal(g.active(), false);
});

test('严格贴底阈值远小于宽松阈值：只用于留白变化时的自愈，不参与上翻判定', () => {
    assert.ok(STRICT_BOTTOM_PX < BOTTOM_SLACK);
    assert.ok(STRICT_BOTTOM_PX >= 0);
});

test('内容异步长高：贴底态补底，上翻态 / 用户手势中一律不动', () => {
    assert.equal(shouldRefollowGrowth(true, 400, false), true);
    assert.equal(shouldRefollowGrowth(false, 400, false), false);
    assert.equal(shouldRefollowGrowth(true, 400, true), false);
    assert.equal(shouldRefollowGrowth(true, STRICT_BOTTOM_PX, false), false); // 本来就在底
    assert.equal(shouldRefollowGrowth(true, 0, false), false);
    assert.equal(shouldRefollowGrowth(true, undefined, false), false); // 量不到就别动
});

test('连续减小兜底：单发布局钳位不算用户拖动', () => {
    let t = 0;
    const burst = createShrinkBurst(() => t);
    assert.equal(burst.push(), false); // 1 次
    t += 1000;
    assert.equal(burst.push(), false); // 间隔过长，重新计数
});

test('连续减小兜底：短窗口内攒到 SHRINK_BURST 次即认定用户在拖', () => {
    let t = 0;
    const burst = createShrinkBurst(() => t);
    for (let i = 0; i < SHRINK_BURST - 1; i += 1) {
        assert.equal(burst.push(), false);
        t += 16; // 逐帧滚动
    }
    assert.equal(burst.push(), true);
    // 判定为用户后计数归零，下一次重新起步
    burst.reset();
    assert.equal(burst.push(), false);
});
