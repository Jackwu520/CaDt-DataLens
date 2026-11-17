// ai-session-ui-sync 接线守卫：当前查看会话的 chrome（消息区 / 输入区 / 发送停止按钮 /
// 提醒徽标 / 计时胶囊 / 隔离 worktree 芯片 / 系统提示词估算）统一走 syncActiveSessionUI，
// 凡「当前会话可能变了」的路径都必须调它，不许手写清单。
// 背景：switchSession 有一份完整清单，newSession 不走 switchSession 又手写了一份，
// 漏了隔离芯片——从隔离区会话点「新建对话」会残留「隔离 · 开」（2026-11-18）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../src/ai/ai-panel.js', import.meta.url)), 'utf8');

// 按函数声明切片：从 `function NAME(` 到下一个同缩进（4 空格）的兄弟函数声明。
// 模块惯例：createAIPanel 体内函数声明一律 4 空格缩进，嵌套箭头函数不会命中。
function fnBody(name) {
    const marker = 'function ' + name + '(';
    const start = src.indexOf(marker);
    assert.ok(start >= 0, 'ai-panel.js 缺少 function ' + name + '(');
    const next = src.slice(start + marker.length).search(/\n    (?:async )?function /);
    return next < 0 ? src.slice(start) : src.slice(start, start + marker.length + next + 1);
}

// 统一入口必须覆盖全部会话级 chrome——以后给面板加新的会话级芯片时，这里的清单要同步补
test('syncActiveSessionUI：包含全部会话级 chrome 刷新', () => {
    const body = fnBody('syncActiveSessionUI');
    const calls = [
        'syncStreamView()',
        'renderMessages(',
        'updateComposerState()',
        'setStreamingUI()',
        'syncRemindersUI(',
        'timerMod.render()',
        'worktreeMod.syncChip(',
        'refreshSystemPromptEstimate(',
    ];
    for (const call of calls) {
        assert.ok(body.includes(call), 'syncActiveSessionUI 缺少 ' + call + '（新增会话级芯片要统一收进这里）');
    }
});

// 「当前会话可能变了」的路径：切会话 / 新建 / 删除兜底 / 跨窗口重载兜底 / 启动加载与 init
test('当前会话可能变化的路径一律走 syncActiveSessionUI', () => {
    for (const name of ['switchSession', 'newSession', 'deleteSession', 'refreshSessionUI', 'applyLoadedSessions', 'init']) {
        assert.ok(fnBody(name).includes('syncActiveSessionUI('), name + ' 缺少 syncActiveSessionUI 调用');
    }
});

// switchSession 不再手写会话级清单：往里加第 N 个芯片刷新而不动统一入口，
// 其他路径就会各漏一份（本守卫的来历）
test('switchSession 不再手写会话级芯片清单', () => {
    const body = fnBody('switchSession');
    for (const call of ['worktreeMod.syncChip', 'timerMod.render', 'syncRemindersUI(']) {
        assert.ok(!body.includes(call), 'switchSession 里出现裸的 ' + call + '（应统一走 syncActiveSessionUI）');
    }
});
