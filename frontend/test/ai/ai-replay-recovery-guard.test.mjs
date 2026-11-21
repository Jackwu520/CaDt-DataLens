// 重放降级护栏：应用重启时挂起的卡片（ask / 审批 / 变量），工具结果正文必须整句换成 *_LOST_TEXT。
// 事故背景：这些工具的正文是注册时的「等待…」占位，而重放分支一度只在正文为空时才替换，
// 导致占位原样进模型上下文——模型把「还在等」读成「已有结果」，替用户拍板。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ai');
const PANEL = readFileSync(join(SRC, 'ai-panel.js'), 'utf8');

test('重放降级：三类挂起卡片的正文走 *_LOST_TEXT 常量', () => {
    for (const name of ['ASK_LOST_TEXT', 'APPROVAL_LOST_TEXT', 'ENV_ASK_LOST_TEXT']) {
        assert.ok(PANEL.includes(`message.content = ${name};`), `${name} 没有用于重放降级`);
        assert.ok(PANEL.includes(`${name},`), `${name} 没有从 ai-constants 导入`);
    }
});

test('重放降级：不再留旧的「会话重新加载 / 页面已关闭」文案', () => {
    // 这三句是旧版降级文案：说「取消了」但没交代副作用，且只在正文为空时生效（等于多数情况不生效）
    const legacy = ['审批已取消（会话重新加载）', '用户未回答（页面已关闭）', '变量创建已取消（会话重新加载）'];
    for (const text of legacy) {
        assert.ok(!PANEL.includes(text), `旧降级文案仍在：${text}（应改成 *_LOST_TEXT 常量）`);
    }
});
