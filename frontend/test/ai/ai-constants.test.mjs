// ai-constants.test.mjs：正文图片 data URL 反解（aiImageFromSrc）与 aiImageSrc 的往返。
import test from 'node:test';
import assert from 'node:assert/strict';
import {aiCtxBannerShow, aiImageExt, aiImageFromSrc, aiImageSrc, aiMsgActionsStepMode} from '../../src/ai/ai-constants.js';

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
