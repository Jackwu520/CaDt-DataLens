// ai-system-context 组装域测试：段顺序（稳定 → 动态）、注入开关、附件块格式化、
// workspace_rules 按档位给守则。面板闭包状态全部经 ctx getter 注入，这里用假 ctx。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAISystemContext} from '../../src/ai/ai-system-context.js';

function makeCtx(overrides = {}) {
    const settings = {
        aiInjectPersona: false,
        aiInjectAgentsMd: false,
        aiInjectMemory: false,
        aiInjectPreferences: false,
        aiInjectSkills: false,
        aiInjectEnvVars: false,
        aiInjectRoot: false,
        aiInjectActiveFile: false,
        aiInjectCaret: false,
        aiInjectViewport: false,
        aiInjectOpenFiles: false,
        ...(overrides.settings || {}),
    };
    const config = {outputLanguage: 'zh', persona: {}, preferences: [], ...(overrides.config || {})};
    return {
        get settings() { return settings; },
        get config() { return config; },
        effectiveSystemPrompt: () => 'BASE-PROMPT',
        aiProjectRoot: () => '',
        aiJoinPath: (root, rel) => root + '/' + rel,
        readTextFile: async () => ({text: 'FILE-CONTENT'}),
        resolveMemoryDir: async () => ({dir: '/mem', mode: 'workspace'}),
        aiDisplayPath: (path) => path,
        aiDisplayRootLabel: (root) => root,
        aiNormalizePath: (path) => path,
        listSkills: async () => [{name: 'demo-skill', description: '演示技能', source: 'builtin'}],
        skillSourceLabel: (source) => (source === 'builtin' ? '内置' : source),
        listEnvVarsForAI: async () => [{name: 'DEMO_VAR', description: '演示变量', enabled: true}],
        toolCatalogText: () => '<tool_catalog>CATALOG</tool_catalog>',
        currentScopeOf: () => 'read',
        getWorkspaceContext: () => ({activeFile: null, openFiles: []}),
        getScopeRoot: () => '',
        ...overrides.ctx,
    };
}

function sectionOf(text, tag) {
    const match = text.match(new RegExp('<' + tag + '[\\s\\S]*?</' + tag + '>'));
    return match ? match[0] : null;
}

test('基座在最前，静态段按稳定 → 动态顺序，动态段收尾', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {
            aiInjectPersona: true, aiInjectSkills: true, aiInjectEnvVars: true,
            aiInjectActiveFile: true,
        },
        ctx: {
            getWorkspaceContext: () => ({activeFile: {path: '/w/demo.txt', mode: 'code', cursor: {line: 3, column: 5}}, openFiles: []}),
            getScopeRoot: () => '/w',
        },
    }));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    // 段与段以空行分隔；按「块以 <tag> 开头」定位，避免标签在守则正文里被提及干扰 indexOf
    const chunks = text.split('\n\n');
    const pos = (tag) => chunks.findIndex((chunk) => chunk.startsWith('<' + tag + '>'));
    const order = ['tool_catalog', 'workspace_rules', 'output_language', 'workspace_context'].map(pos);
    assert.ok(order.every((p) => p >= 0), '缺段：' + order.join(','));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), '段顺序不是稳定 → 动态');
    assert.equal(chunks[0], 'BASE-PROMPT');
    assert.ok(text.endsWith('<workspace_context>\n当前活动文件：/w/demo.txt（视图：code）\n</workspace_context>'));
});

test('注入开关逐段生效，关闭时不留空壳', async () => {
    const mod = createAISystemContext(makeCtx());
    const {text, meta} = await mod.assembleSystemContext({todos: []}, []);
    for (const tag of ['skills', 'memory', 'user_preferences', 'env_vars', 'agents_md', 'task_reminders']) {
        assert.equal(sectionOf(text, tag), null, '开关关闭仍注入了 ' + tag);
    }
    assert.equal(meta.skills.count, 0);
    assert.equal(meta.workspace.loaded, false);
});

test('技能 / 环境变量 / 任务清单 / 提醒段按来源格式化', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectSkills: true, aiInjectEnvVars: true},
        ctx: {listEnvVarsForAI: async () => [{name: 'OFF_VAR', description: '关闭', enabled: false}]},
    }));
    const session = {todos: [{content: '写测试', status: 'in_progress'}, {content: '跑测试', status: 'pending'}], reminders: [{id: 'r1', title: '别忘发版', detail: ''}]};
    const {text, meta} = await mod.assembleSystemContext(session, []);
    const skills = sectionOf(text, 'skills');
    assert.ok(skills.includes('- demo-skill：演示技能（内置）'));
    assert.deepEqual(meta.skills.names, ['demo-skill']);
    assert.equal(sectionOf(text, 'env_vars'), null, '禁用变量不应注入');
    const todos = sectionOf(text, 'task_todos');
    assert.ok(todos.includes('共 2 项') && todos.includes('1 项进行中（写测试）') && todos.includes('1 项待处理'));
    const reminders = sectionOf(text, 'task_reminders');
    assert.ok(reminders.includes('- [r1] 别忘发版'));
});

test('附件块：skill_manual / file_reference / selection_reference / attachment 四种格式', async () => {
    const mod = createAISystemContext(makeCtx());
    const {text, meta} = await mod.assembleSystemContext({todos: []}, [
        {kind: 'skill', label: 'cadt-ui', content: '动作表'},
        {kind: 'reference', label: 'a.txt', path: '/w/a.txt'},
        {kind: 'selection_reference', label: 'a.txt', path: '/w/a.txt', start: {line: 2, column: 3}, end: {line: 4, column: 6}},
        {kind: 'file', label: 'data.csv', path: '/w/data.csv', content: 'x,y'},
    ]);
    const block = sectionOf(text, 'attachments');
    assert.ok(block.includes('<skill_manual name="cadt-ui">\n动作表\n</skill_manual>'));
    assert.ok(block.includes('<file_reference name="a.txt" path="/w/a.txt" />'));
    assert.ok(block.includes('startLine="2" startColumn="3" endLine="4" endColumn="6"'));
    assert.ok(block.includes('<attachment name="data.csv" path="/w/data.csv">\nx,y\n</attachment>'));
    assert.equal(meta.attachments.count, 4);
    assert.equal(meta.attachments.chars, 6); // 动作表(3) + x,y(3)，其余附件无正文
});

test('workspace_rules 按档位给守则，计划模式附加只读约束', async () => {
    const mod = createAISystemContext(makeCtx());
    const read = await mod.assembleSystemContext({todos: []}, []);
    assert.ok(read.text.includes('只读访问：可列目录、读文件、搜索文本'), 'read 档守则缺失');
    const mod2 = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'full'}}));
    const full = await mod2.assembleSystemContext({todos: []}, []);
    assert.ok(full.text.includes('完全权限：可读取与修改工作区内外文件'));
    const mod3 = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'edit'}}));
    const plan = await mod3.assembleSystemContext({todos: [], planMode: true}, []);
    assert.ok(plan.text.includes('（当前为计划模式：不提供 write_file / edit_file，只做只读探索并输出计划）'));
});

test('planModeBlock 输出计划约定块', () => {
    const mod = createAISystemContext(makeCtx());
    const block = mod.planModeBlock();
    assert.ok(block.startsWith('<plan_mode>') && block.endsWith('</plan_mode>'));
    assert.ok(block.includes('等待用户批准'));
});
