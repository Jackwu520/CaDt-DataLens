// ai-head-hud 后台作业状态图标护栏：停止必须是 stop 字形（实心方块，与输入区停止按钮同源），
// 不能退回 || 暂停——后者读作「暂停、还能继续」，而后台作业停下就结束了。
// 同时锁住「退出码参与成功/失败判定」与失败态颜色，防止再退回「非 0 退出也画绿勾」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const hud = readFileSync(new URL('../../src/ai/ai-head-hud.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');

test('已停止用 stop 字形，不再与暂停共用图标', () => {
    assert.match(hud, /state === 'stopped'\) return iconSvg\('stop', 12\)/);
    assert.doesNotMatch(hud, /state === 'stopped' \|\| state === 'notfound'/);
    assert.doesNotMatch(hud, /iconSvg\('pause', 12\)/);
});

test('退出码参与图标：0 成功勾、非 0 失败叉', () => {
    assert.match(hud, /state === 'exited'\) return Number\(code\) \? iconSvg\('close', 12\) : iconSvg\('check', 12\)/);
});

test('查不到的作业用中性信息图标（不是任何终态图标）', () => {
    assert.match(hud, /state === 'notfound'\) return iconSvg\('info', 12\)/);
});

test('非 0 退出的行挂 failed 类，样式表用红色', () => {
    assert.match(hud, /failedExit \? 'failed' : state/);
    assert.match(css, /\.ai-status-failed \{ color: var\(--red\); \}/);
});
