// memo 贴图引用归一：便签里图片的 data-memo-img / data-ai-src 属性值五花八门
// （粘贴生成的 img/…、手写或导入的 ./img/…、Windows 反斜杠），这里统一成
// 「只认 img/ 开头的相对引用」，其余（绝对路径、../ 越界、空值）一律返回空串，
// 由调用方退回用图片自身的 src 放大，不再静默进编辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMemoRel, imageExtFromSrc} from '../../src/bridge/bridge-memo-view.js';

test('粘贴生成的引用原样通过', () => {
    assert.equal(normalizeMemoRel('img/img-dmygwy0op3ys.png'), 'img/img-dmygwy0op3ys.png');
});

test('去 ./ 前缀后仍认作贴图引用', () => {
    assert.equal(normalizeMemoRel('./img/a.png'), 'img/a.png');
    assert.equal(normalizeMemoRel('  ./img/a.png  '), 'img/a.png');
});

test('反斜杠路径按正斜杠归一', () => {
    assert.equal(normalizeMemoRel('img\\a.png'), 'img/a.png');
    assert.equal(normalizeMemoRel('.\\img\\a.png'), 'img/a.png');
});

test('越界与绝对路径一律拒绝（不允许逃出 memo 作用域目录）', () => {
    assert.equal(normalizeMemoRel('../img/a.png'), '');
    assert.equal(normalizeMemoRel('../../secret.png'), '');
    assert.equal(normalizeMemoRel('C:/Users/x/a.png'), '');
    assert.equal(normalizeMemoRel('/abs/img/a.png'), '');
});

test('非贴图引用与空值返回空串', () => {
    assert.equal(normalizeMemoRel(''), '');
    assert.equal(normalizeMemoRel(null), '');
    assert.equal(normalizeMemoRel(undefined), '');
    assert.equal(normalizeMemoRel('https://example.com/a.png'), '');
    assert.equal(normalizeMemoRel('attachment/a.png'), '');
});

test('另存为的默认扩展名跟 data URL 的 mime 走', () => {
    assert.equal(imageExtFromSrc('data:image/png;base64,AAA'), 'png');
    assert.equal(imageExtFromSrc('data:image/jpeg;base64,AAA'), 'jpg');
    assert.equal(imageExtFromSrc('data:image/jpg;base64,AAA'), 'jpg');
    assert.equal(imageExtFromSrc('data:image/webp;base64,AAA'), 'webp');
    assert.equal(imageExtFromSrc('data:image/svg+xml;base64,AAA'), 'svg');
});

test('拿不到 mime 时不给扩展名（由调用方回落 .png）', () => {
    assert.equal(imageExtFromSrc(''), '');
    assert.equal(imageExtFromSrc(null), '');
    assert.equal(imageExtFromSrc('https://example.com/a.png'), '');
    assert.equal(imageExtFromSrc('data:image/tiff;base64,AAA'), '');
});
