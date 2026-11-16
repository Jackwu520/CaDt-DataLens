// AI 面板显示形态（停靠分屏 / 全屏 / 悬浮）的改动权护栏。
//
// 用户硬规则（2026-11-17）：形态只能由用户在面板 […] 菜单 / 设置页 / 视图菜单切换。
// 曾出现过的两条越权路径都已删除，别再请回来：
//   1) 标题栏双击 → applyMode(..., true)：双击会话标题想选字都会静默把全屏写进设置；
//      现在没有这个手势。
//   2) 子代理详情 / 支线对话开标签页时 setMode('dock')：程序替用户改布局。
//      「编辑区收起 → 新标签页出现就展开」是 main.js 的 revealEditorForContent 的事，
//      与面板形态无关（判定与接线见 ai-auto-collapse.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

test('形态切换只剩菜单一条路：没有标题栏双击，也没有自动调用', () => {
    const panel = read('ai/ai-panel.js');
    assert.doesNotMatch(panel, /addEventListener\('dblclick'/, '标题栏双击切形态已删除，不许回归');
    assert.doesNotMatch(panel, /toggleFullscreen\(/, 'toggleFullscreen 已删除');
    // 5 处：定义、导出到 main.js、[…] 菜单三项（停靠 / 全屏 / 悬浮窗）
    assert.equal([...panel.matchAll(/setMode\(/g)].length, 5,
        'setMode 只该有定义 / 导出 / 菜单三项');
});

test('标签页出口不按面板形态改行为（全屏 / 停靠都照常打开）', () => {
    const panel = read('ai/ai-panel.js');
    assert.match(panel, /sideChatTabOutlet = !openSideChatTab \|\| window\.__aiFloatWindow \? null : \(spec\) => openSideChatTab\(spec\);/);
    assert.match(panel, /openAgentTab: !openAgentTab \|\| window\.__aiFloatWindow \? null : \(spec\) => openAgentTab\(spec\)/);
    assert.doesNotMatch(panel, /mode === 'fullscreen' \? null/, '不许再按形态改成面板内展示');
});

test('AI 侧不可写：动作与设置白名单都没有面板形态键', () => {
    const main = read('main.js');
    const start = main.indexOf('const APP_SETTING_RULES = {');
    const rules = main.slice(start, main.indexOf('\n};', start));
    assert.doesNotMatch(rules, /^\s*aiFloatMode\s*:/m, '显示方式不许进 AI 可写白名单');
    assert.doesNotMatch(rules, /^\s*aiPanelSide\s*:/m, '停靠侧同样不许由 AI 改动');
    const actions = main.slice(main.indexOf('const APP_ACTIONS = ['), main.indexOf('];', main.indexOf('const APP_ACTIONS = [')));
    assert.doesNotMatch(actions, /ai_panel_mode|set_ai_panel_mode/, '不许把形态切换做成 AI 动作');
});
