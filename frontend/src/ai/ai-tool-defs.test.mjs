// ai-tool-defs 工具表测试：按档位 / 计划模式决定哪些工具下发。
// 重点锁住「计划模式只给 propose_patch 的预检形态、不给任何写工具」这条约定，
// 以及「新增工具必须写进目录」的作者规则（.cadt/memory/ai-tool-catalog-rule.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_TOOL_CATALOG, AI_TOOL_DEFS, AI_TOOL_GROUPS, createAIToolDefs} from './ai-tool-defs.js';

const {toolsForScope} = createAIToolDefs({appControlOn: () => false});
const names = (scope, planMode) => toolsForScope(scope, planMode).map((t) => t.name);

test('目录一致性：每个工具定义必须写进目录，目录条目必须指向存在的工具', () => {
    const defs = Object.keys(AI_TOOL_DEFS);
    const catalog = Object.keys(AI_TOOL_CATALOG);
    const missing = defs.filter((name) => !catalog.includes(name));
    assert.deepEqual(missing, [], 'AI_TOOL_DEFS 有工具漏写 <tool_catalog> 目录：' + missing.join(', '));
    const orphan = catalog.filter((name) => !defs.includes(name));
    assert.deepEqual(orphan, [], 'AI_TOOL_CATALOG 有条目指向不存在的工具：' + orphan.join(', '));
});

test('目录一致性：组键必须在注册表里且唯一，每个条目有文案', () => {
    const keys = AI_TOOL_GROUPS.map((group) => group.key);
    assert.equal(new Set(keys).size, keys.length, 'AI_TOOL_GROUPS 组键重复');
    for (const group of AI_TOOL_GROUPS) {
        assert.ok(group.title, '组 ' + group.key + ' 缺标题');
    }
    for (const [name, entry] of Object.entries(AI_TOOL_CATALOG)) {
        assert.ok(keys.includes(entry.group), name + ' 的组键 ' + entry.group + ' 不在注册表');
        assert.ok(entry.blurb && entry.blurb.trim(), name + ' 缺目录文案');
    }
});

test('载荷纯净：toolsForScope 下发的 def 只含 name/description/parameters', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            for (const def of toolsForScope(scope, planMode)) {
                assert.deepEqual(
                    Object.keys(def).sort(),
                    ['description', 'name', 'parameters'],
                    def.name + ' 的下发载荷混入额外字段（目录数据必须独立成表）',
                );
            }
        }
    }
});

test('generate_*：配置了启用条目才下发，计划模式不注入，check_gen 随同', () => {
    const on = createAIToolDefs({appControlOn: () => false, genModelsOn: () => true}).toolsForScope;
    const off = createAIToolDefs({appControlOn: () => false, genModelsOn: () => false}).toolsForScope;
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        const enabled = on(scope, false).map((t) => t.name);
        for (const name of ['generate_image', 'generate_video', 'check_gen']) {
            assert.ok(enabled.includes(name), scope + ' 档未下发 ' + name);
        }
        assert.deepEqual(off(scope, false).map((t) => t.name).filter((n) => n.startsWith('generate') || n === 'check_gen'),
            [], '未配置条目时不应下发生成工具：' + scope);
    }
    const plan = on('read', true).map((t) => t.name);
    assert.ok(!plan.includes('generate_image'), '计划模式不下发 generate_image');
    assert.ok(!plan.includes('generate_video'), '计划模式不下发 generate_video');
    assert.ok(!plan.includes('check_gen'), '计划模式不下发 check_gen');
});

test('toolCatalogText：按档位过滤、合并同文案相邻工具、含会话新组', () => {
    const catalogText = createAIToolDefs({appControlOn: () => false}).toolCatalogText;
    const read = catalogText('read', false);
    assert.ok(read.includes('- list_dir：列目录与文件大小，先摸清结构'));
    assert.ok(read.includes('- memory_list / memory_read / memory_write：跨会话事实与结论；写后更新 MEMORY.md 索引'));
    assert.ok(read.includes('【会话、提醒与通知】'));
    assert.ok(read.includes('- reminder_add / reminder_list / reminder_update / reminder_remove：'));
    assert.ok(!read.includes('【文件写入'), '只读档非计划模式不应出现写组');
    assert.ok(!read.includes('- write_file'));

    const plan = catalogText('read', true);
    assert.ok(plan.includes('【文件写入（先读后改，走审批）】'), '计划模式有 propose_patch 预检，写组应出现');
    assert.ok(plan.includes('- propose_patch：'));
    assert.ok(!plan.includes('- reminder_add'), '计划模式不下发 reminder_add');
    assert.ok(plan.includes('- reminder_list：'), '计划模式保留 reminder_list（只读）单列一行');
});

test('toolCatalogText：app_control 与 MCP 工具按可用性出现，结构段完整', () => {
    const withoutApp = createAIToolDefs({appControlOn: () => false}).toolCatalogText('full', false);
    assert.ok(!withoutApp.includes('【应用界面（当前窗口）】'));
    assert.ok(!withoutApp.includes('【外部 MCP 服务器（第三方工具）】'));
    const withAll = createAIToolDefs({
        appControlOn: () => true,
        mcpToolDefs: () => [{name: 'mcp__demo_lookup', description: '演示', input_schema: {type: 'object'}}],
    }).toolCatalogText('full', false);
    assert.ok(withAll.includes('【应用界面（当前窗口）】'));
    assert.ok(withAll.includes('【外部 MCP 服务器（第三方工具）】'));
    assert.ok(withAll.includes('调度原则：'));
    assert.ok(withAll.includes('典型任务 → 工具链：'));
    assert.ok(withAll.endsWith('</tool_catalog>'));
});

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

test('timer_list：所有权限档与计划模式都下发只读时钟，且不接受任何参数', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.ok(names(scope, planMode).includes('timer_list'), scope + ' / planMode=' + planMode + ' 应下发 timer_list');
        }
    }
    const def = toolsForScope('read', false).find((t) => t.name === 'timer_list');
    assert.deepEqual(Object.keys(def.parameters.properties), [], 'timer_list 是纯快照，不接受参数');
    assert.match(AI_TOOL_DEFS.timer_list.description, /只读/);
    assert.match(AI_TOOL_DEFS.timer_list.description, /不要靠反复调用/);
    assert.ok(AI_TOOL_CATALOG.timer_list, '工具目录必须登记 timer_list');
});

test('计划模式仍保留只读探索与子代理', () => {
    const list = names('read', true);
    for (const tool of ['list_dir', 'read_file', 'search_text', 'spawn_agent']) {
        assert.ok(list.includes(tool), '计划模式应保留 ' + tool);
    }
});

test('read_image：只读档与计划模式都下发，且必须登记目录', () => {
    for (const scope of ['read', 'edit', 'auto', 'full']) {
        for (const planMode of [false, true]) {
            assert.ok(names(scope, planMode).includes('read_image'),
                scope + ' / planMode=' + planMode + ' 应下发 read_image（只读能力，不该被档位挡住）');
        }
    }
    const def = toolsForScope('read', false).find((tool) => tool.name === 'read_image');
    assert.deepEqual(Object.keys(def.parameters.properties), ['path'], 'read_image 只接受 path');
    assert.match(AI_TOOL_DEFS.read_image.description, /read_file/, '描述里要点明与 read_file 的分工');
    assert.match(AI_TOOL_DEFS.read_image.description, /800–1600 token/, '描述里要写上下文成本');
    assert.equal(AI_TOOL_CATALOG.read_image.group, 'read', 'read_image 属于只读组');
    // 目录文案必须真的描述「看画面」，别退回成读文本
    assert.match(AI_TOOL_CATALOG.read_image.blurb, /图片/);
});
