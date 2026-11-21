// ai-constants.test.mjs：正文图片 data URL 反解（aiImageFromSrc）与 aiImageSrc 的往返。
import test from 'node:test';
import assert from 'node:assert/strict';
import {aiCtxBannerShow, aiCtxBannerState, aiFormatDuration, aiFormatLiveDuration, aiImageExt, aiImageFromSrc, aiImageSrc, aiIsContextOverflowError, aiMsgActionsStepMode} from '../../src/ai/ai-constants.js';

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
    // ≥100%：整体压缩请求发不出去（compactBlocked 为 true），但 startCompact 有超窗兜底，
    // 压缩仍可用——文案提示「摘要略粗」而不是禁用按钮/只让切模型
    const beyond = aiCtxBannerState(1.21, 317645, 262144);
    assert.equal(beyond.state, 'over');
    assert.equal(beyond.blocked, true);
    assert.equal(beyond.compactBlocked, true);
    assert.equal(beyond.text, '上下文 121%（约 317,645 / 262,144 tokens，估算），已超过模型上限：可压缩（摘要略粗）或切换更大上下文的模型');
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

test('aiFormatDuration: 天/小时/分/秒四档，显示到整数秒，0 值单位跳过', () => {
    // 秒档
    assert.equal(aiFormatDuration(0), '不到 1 秒');
    assert.equal(aiFormatDuration(499), '不到 1 秒');
    assert.equal(aiFormatDuration(500), '1 秒'); // Math.round 进位
    assert.equal(aiFormatDuration(1000), '1 秒');
    assert.equal(aiFormatDuration(59400), '59 秒');
    // 分档
    assert.equal(aiFormatDuration(60000), '1 分');
    assert.equal(aiFormatDuration(90000), '1 分 30 秒');
    assert.equal(aiFormatDuration(3599000), '59 分 59 秒');
    // 小时档（秒要保留）
    assert.equal(aiFormatDuration(3600000), '1 小时');
    assert.equal(aiFormatDuration(3720000), '1 小时 2 分');
    assert.equal(aiFormatDuration(3723000), '1 小时 2 分 3 秒');
    assert.equal(aiFormatDuration(86399000), '23 小时 59 分 59 秒');
    // 天档（秒要保留）
    assert.equal(aiFormatDuration(86400000), '1 天');
    assert.equal(aiFormatDuration(90000000), '1 天 1 小时');
    assert.equal(aiFormatDuration(183600000), '2 天 3 小时');
    assert.equal(aiFormatDuration(183603000), '2 天 3 小时 3 秒');
    // 非法输入兜底
    assert.equal(aiFormatDuration(NaN), '不到 1 秒');
    assert.equal(aiFormatDuration(-1000), '不到 1 秒');
});

test('aiFormatLiveDuration: 不到 1 小时带十分位小数，小时/天档整数秒', () => {
    // 秒档带十分位
    assert.equal(aiFormatLiveDuration(0), '0.0 秒');
    assert.equal(aiFormatLiveDuration(40200), '40.2 秒');
    // 分档带十分位
    assert.equal(aiFormatLiveDuration(220200), '3 分 40.2 秒');
    // 59.96 秒按 0.1s 取整进位到 1 分，不出现非法的「60.0 秒」
    assert.equal(aiFormatLiveDuration(59960), '1 分 0.0 秒');
    // 图片里的 82 分 56.3 秒 → 到小时档，去小数
    assert.equal(aiFormatLiveDuration(4976300), '1 小时 22 分 56 秒');
    // 小时档（整数秒）
    assert.equal(aiFormatLiveDuration(3600000), '1 小时');
    assert.equal(aiFormatLiveDuration(3720000), '1 小时 2 分');
    assert.equal(aiFormatLiveDuration(86399000), '23 小时 59 分 59 秒');
    // 天档（整数秒）
    assert.equal(aiFormatLiveDuration(86400000), '1 天');
    assert.equal(aiFormatLiveDuration(183603000), '2 天 3 小时 3 秒');
    // 非法输入兜底
    assert.equal(aiFormatLiveDuration(NaN), '0.0 秒');
    assert.equal(aiFormatLiveDuration(-1000), '0.0 秒');
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
