// ai-patch-policy 纯函数测试：完全权限下是否弹补丁审批卡、最后一条用户消息取文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {patchAllowApply, lastUserTextOf} from './ai-patch-policy.js';

const user = (text) => ({role: 'user', content: text});
const assistant = (text) => ({role: 'assistant', content: text});

test('lastUserTextOf：取最后一条用户消息，跳过 assistant/tool', () => {
    const messages = [user('第一句'), assistant('回'), user('第二句'), assistant('再回')];
    assert.equal(lastUserTextOf(messages), '第二句');
    // 多段内容（图片 + 文本）拼接
    assert.equal(lastUserTextOf([{role: 'user', content: [{type: 'text', text: '看图'}, {type: 'image'}]}]), '看图');
    assert.equal(lastUserTextOf([]), '');
    assert.equal(lastUserTextOf(null), '');
    assert.equal(lastUserTextOf([assistant('只有助手')]), '');
});

test('patchAllowApply：模型显式 apply:false 永远只产出文件', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        assert.equal(patchAllowApply({apply: false}, scope, '应用这个补丁'), false, scope);
    }
});

test('patchAllowApply：非完全权限档保持弹卡', () => {
    for (const scope of ['edit', 'auto']) {
        assert.equal(patchAllowApply({apply: true}, scope, ''), true, scope);
        assert.equal(patchAllowApply({}, scope, '随便改'), true, scope);
    }
});

test('patchAllowApply：完全权限档只有明确要求「应用」才弹卡', () => {
    const cases = [
        ['把补丁应用上去', true],
        ['先给 patch，然后 apply 一下', true],
        ['这个补丁合入吧', true],
        ['给我一份 patch 我要转给同事', false], // 要分享 → 只产出文件
        ['顺手改掉就行', false],
        ['', false],
    ];
    for (const [text, want] of cases) {
        assert.equal(patchAllowApply({apply: true}, 'full', text), want, text);
    }
    assert.equal(patchAllowApply({}, 'full', null), false);
});
