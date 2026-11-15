// ai-constants.test.mjs：正文图片 data URL 反解（aiImageFromSrc）与 aiImageSrc 的往返。
import test from 'node:test';
import assert from 'node:assert/strict';
import {aiImageExt, aiImageFromSrc, aiImageSrc} from './ai-constants.js';

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
