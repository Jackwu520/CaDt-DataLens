// ai-tool-defs 工具表测试：按档位 / 计划模式决定哪些工具下发。
// 重点锁住「计划模式只给 propose_patch 的预检形态、不给任何写工具」这条约定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIToolDefs} from './ai-tool-defs.js';

const {toolsForScope} = createAIToolDefs({appControlOn: () => false});
const names = (scope, planMode) => toolsForScope(scope, planMode).map((t) => t.name);

test('计划模式：只读/写档都给 propose_patch（预检用），但不给任何写工具', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        const list = names(scope, true);
        assert.ok(list.includes('propose_patch'), scope + ' 计划模式应可用 propose_patch');
        for (const tool of ['write_file', 'edit_file', 'run_command', 'background_command', 'browser_click']) {
            assert.ok(!list.includes(tool), scope + ' 计划模式不应下发 ' + tool);
        }
    }
});

test('非计划模式：写工具与 propose_patch 按档位下发', () => {
    for (const scope of ['edit', 'auto', 'full']) {
        const list = names(scope, false);
        for (const tool of ['write_file', 'edit_file', 'propose_patch', 'run_command']) {
            assert.ok(list.includes(tool), scope + ' 应下发 ' + tool);
        }
    }
    const readOnly = names('read', false);
    for (const tool of ['write_file', 'edit_file', 'propose_patch']) {
        assert.ok(!readOnly.includes(tool), '只读档不应下发 ' + tool);
    }
});

test('计划模式仍保留只读探索与子代理', () => {
    const list = names('read', true);
    for (const tool of ['list_dir', 'read_file', 'search_text', 'spawn_agent']) {
        assert.ok(list.includes(tool), '计划模式应保留 ' + tool);
    }
});
