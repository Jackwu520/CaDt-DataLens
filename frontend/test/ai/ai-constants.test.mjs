// ai-constants.test.mjs：正文图片 data URL 反解（aiImageFromSrc）与 aiImageSrc 的往返。
import test from 'node:test';
import assert from 'node:assert/strict';
import {aiCtxBannerShow, aiCtxBannerState, aiImageExt, aiImageFromSrc, aiImageSrc, aiIsContextOverflowError, aiMsgActionsStepMode} from '../../src/ai/ai-constants.js';

test('aiImageFromSrc: 与 aiImageSrc 往返一致', () => {
    const image = aiImageFromSrc('data:image/png;base64,AAAA', 'seal.png');
    assert.deepEqual(image, {mime: 'image/png', data: 'AAAA', name: 'seal.png'});
    assert.equal(aiImageSrc(image), 'data:image/png;base64,AAAA');
});

test('aiImageFromSrc: mime 归一与空白剔除', () => {
    assert.equal(aiImageFromSrc('data:image/jpeg;base64, AA\r\nAA ', 'x').mime, 'image/jpeg');
    assert.equal(aiImageFromSrc('data:IMAGE/JPG;base64,AA', 'x').mime, 'image/jpeg');
    assert.equal(aiImageFromSrc('data:image/png;base64,AA AA', 'x').data, 'AAAA');
    assert.equal(aiImageExt(aiImageFromSrc('data:image/jpeg;base64,AA', 'x').mime), 'jpg');
});

test('aiImageFromSrc: 名称缺省为「图片」', () => {
    assert.equal(aiImageFromSrc('data:image/png;base64,AA', '').name, '图片');
    assert.equal(aiImageFromSrc('data:image/png;base64,AA', '   ').name, '图片');
    assert.equal(aiImageFromSrc('data:image/png;base64,AA').name, '图片');
});

test('aiImageFromSrc: 非 data URL 一律返回 null', () => {
    for (const src of [
        '',
        '   ',
        null,
        undefined,
        'https://example.com/a.png',
        'blob:dvfs://abc',
        'D:/data/shot.png',
        'data:image/png',
        'data:;base64,AA',
        'data:image/png;charset=utf8;base64,AA',
    ]) {
        assert.equal(aiImageFromSrc(src, 'x'), null, '应判为不可复制/保存：' + src);
    }
});

test('aiImageFromSrc: 空 base64 载荷返回 null', () => {
    assert.equal(aiImageFromSrc('data:image/png;base64,', 'x'), null);
});

test('aiCtxBannerShow: 达阈值提醒，关闭后按 +5% 档位重新提醒', () => {
    // 阈值内不提醒
    assert.equal(aiCtxBannerShow(0.79, 0.8, null), false);
    assert.equal(aiCtxBannerShow(0.8, 0.8, null), true, '正好踩线即提醒');
    // 未关闭过：达阈值即提醒
    assert.equal(aiCtxBannerShow(0.83, 0.8, null), true);
    // 关闭时 83%：83–87% 不再打扰，88% 起重新提醒（Math.round(87.5)=88，87.4 才取整 87）
    assert.equal(aiCtxBannerShow(0.83, 0.8, 83), false);
    assert.equal(aiCtxBannerShow(0.874, 0.8, 83), false, '87.4% 取整 87，仍在静默档');
    assert.equal(aiCtxBannerShow(0.875, 0.8, 83), true, '87.5% 取整 88，越过静默档');
    assert.equal(aiCtxBannerShow(0.88, 0.8, 83), true);
    // 压缩后回落到阈值下自然隐藏（关闭态不影响显隐判定本身）
    assert.equal(aiCtxBannerShow(0.5, 0.8, 83), false);
    // 非法输入兜底：percent 非数值视为不达阈值
    assert.equal(aiCtxBannerShow(NaN, 0.8, null), false);
    assert.equal(aiCtxBannerShow(undefined, 0.8, null), false);
});

test('aiCtxBannerState: 三档文案与门禁状态', () => {
    // suggest 档（≥压缩阈值、有发送余量）：千分位数字 + 建议压缩
    const suggest = aiCtxBannerState(0.85, 222822, 262144);
    assert.equal(suggest.state, 'suggest');
    assert.equal(suggest.blocked, false);
    assert.equal(suggest.compactBlocked, false);
    assert.equal(suggest.text, '上下文 85%（约 222,822 / 262,144 tokens，估算），建议压缩');
    // over 档（≥发送硬门槛 0.9、未达 100%）：红色门禁态，整体压缩仍可行
    const near = aiCtxBannerState(0.95, 249036, 262144);
    assert.equal(near.state, 'over');
    assert.equal(near.blocked, true);
    assert.equal(near.compactBlocked, false);
    assert.equal(near.text, '上下文 95%（约 249,036 / 262,144 tokens，估算），接近上限，请先压缩再发送');
    // ≥100%：压缩请求（摘要提示 + 整段会话）也发不出去——compactBlocked 为 true，
    // 文案指引切换更大上下文的模型（切模型后百分比回落自然解锁）
    const beyond = aiCtxBannerState(1.21, 317645, 262144);
    assert.equal(beyond.state, 'over');
    assert.equal(beyond.blocked, true);
    assert.equal(beyond.compactBlocked, true);
    assert.equal(beyond.text, '上下文 121%（约 317,645 / 262,144 tokens，估算），已超过模型上限：请切换更大上下文的模型');
    // 边界：正好 90% 即发送门禁；正好 100% 即压缩门禁
    assert.equal(aiCtxBannerState(0.9, 1000, 1000).blocked, true);
    assert.equal(aiCtxBannerState(0.899, 899, 1000).blocked, false);
    const at = aiCtxBannerState(1, 1000, 1000);
    assert.equal(at.compactBlocked, true);
    assert.equal(at.text.includes('已超过模型上限'), true);
    // windowSize 缺失不判门禁（估算兜底路径）
    const noWindow = aiCtxBannerState(1.5, 1000, 0);
    assert.equal(noWindow.blocked, false);
    assert.equal(noWindow.compactBlocked, false);
});

test('aiMsgActionsStepMode: 三档颗粒度只作用于中间步骤，最后一条恒完整', () => {
    // 最后一条消息任何档位都是完整操作行
    assert.equal(aiMsgActionsStepMode('full', true), 'full');
    assert.equal(aiMsgActionsStepMode('mid-basic', true), 'full');
    assert.equal(aiMsgActionsStepMode('last-only', true), 'full');
    // 中间步骤：full 完整 / mid-basic 只留复制+回退 / last-only 整行不出现
    assert.equal(aiMsgActionsStepMode('full', false), 'full');
    assert.equal(aiMsgActionsStepMode('mid-basic', false), 'basic');
    assert.equal(aiMsgActionsStepMode('last-only', false), 'none');
    // 非法档位回落 full
    assert.equal(aiMsgActionsStepMode('bogus', false), 'full');
    assert.equal(aiMsgActionsStepMode(undefined, false), 'full');
});

test('aiIsContextOverflowError: 只认超窗措辞，不误伤鉴权/限流错误', () => {
    // 各协议服务商的真实措辞
    assert.equal(aiIsContextOverflowError('This model\'s maximum context length is 128000 tokens'), true);
    assert.equal(aiIsContextOverflowError('context_length_exceeded'), true);
    assert.equal(aiIsContextOverflowError('Prompt is too long: 210000 tokens'), true);
    assert.equal(aiIsContextOverflowError('Input is too long for requested model'), true);
    assert.equal(aiIsContextOverflowError('上下文长度超过模型上限'), true);
    assert.equal(aiIsContextOverflowError('请求的上下文窗口已满'), true);
    // 非超窗错误不能被误判成「该压缩」
    assert.equal(aiIsContextOverflowError('HTTP 401: invalid api key'), false);
    assert.equal(aiIsContextOverflowError('429 rate limit exceeded'), false);
    assert.equal(aiIsContextOverflowError('invalid request: messages[2].role'), false);
    assert.equal(aiIsContextOverflowError(''), false);
    assert.equal(aiIsContextOverflowError(null), false);
});
