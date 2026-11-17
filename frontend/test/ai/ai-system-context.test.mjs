// ai-system-context 组装域测试：段顺序（稳定 → 动态）、注入开关、附件块格式化、
// workspace_rules 按档位给守则。面板闭包状态全部经 ctx getter 注入，这里用假 ctx。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAISystemContext, buildSkillsIndexEntries, truncateSkillDescription} from '../../src/ai/ai-system-context.js';

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

test('基座在最前，系统提示词只含稳定段（动态块不进系统提示词）', async () => {
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
    const {text, turnBlock} = await mod.assembleSystemContext({todos: []}, []);
    // 段与段以空行分隔；按「块以 <tag> 开头」定位，避免标签在守则正文里被提及干扰 indexOf
    const chunks = text.split('\n\n');
    const pos = (tag) => chunks.findIndex((chunk) => chunk.startsWith('<' + tag + '>'));
    const order = ['tool_catalog', 'workspace_rules', 'output_language'].map(pos);
    assert.ok(order.every((p) => p >= 0), '缺段：' + order.join(','));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), '段顺序不稳定');
    assert.equal(chunks[0], 'BASE-PROMPT');
    // 动态块（工作区状态 / 清单 / 提醒 / 附件）不再进系统提示词，改由 turnBlock 随用户消息注入
    for (const tag of ['workspace_context', 'task_todos', 'task_reminders', 'attachments']) {
        assert.equal(sectionOf(text, tag), null, '系统提示词不应含动态块 ' + tag);
    }
    assert.ok(turnBlock.startsWith('<system-reminder>'));
    assert.ok(turnBlock.includes('<workspace_context>\n当前活动文件：/w/demo.txt（视图：code）'));
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

test('技能 / 环境变量在系统提示词，任务清单 / 提醒随环境块', async () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectSkills: true, aiInjectEnvVars: true},
        ctx: {listEnvVarsForAI: async () => [{name: 'OFF_VAR', description: '关闭', enabled: false}]},
    }));
    const session = {todos: [{content: '写测试', status: 'in_progress'}, {content: '跑测试', status: 'pending'}], reminders: [{id: 'r1', title: '别忘发版', detail: ''}]};
    const {text, meta, turnBlock} = await mod.assembleSystemContext(session, []);
    const skills = sectionOf(text, 'skills');
    assert.ok(skills.includes('- demo-skill：演示技能（内置）'));
    assert.deepEqual(meta.skills.names, ['demo-skill']);
    assert.equal(sectionOf(text, 'env_vars'), null, '禁用变量不应注入');
    // 清单与提醒随环境块注入，系统提示词里没有
    const todos = sectionOf(turnBlock, 'task_todos');
    assert.ok(todos.includes('共 2 项') && todos.includes('1 项进行中（写测试）') && todos.includes('1 项待处理'));
    const reminders = sectionOf(turnBlock, 'task_reminders');
    assert.ok(reminders.includes('- [r1] 别忘发版'));
    assert.equal(sectionOf(text, 'task_todos'), null);
    assert.equal(sectionOf(text, 'task_reminders'), null);
});

test('附件块：随环境块注入（skill_manual / file_reference / selection_reference / attachment 四种格式）', async () => {
    const mod = createAISystemContext(makeCtx());
    const {text, meta, turnBlock} = await mod.assembleSystemContext({todos: []}, [
        {kind: 'skill', label: 'cadt-ui', content: '动作表'},
        {kind: 'reference', label: 'a.txt', path: '/w/a.txt'},
        {kind: 'selection_reference', label: 'a.txt', path: '/w/a.txt', start: {line: 2, column: 3}, end: {line: 4, column: 6}},
        {kind: 'file', label: 'data.csv', path: '/w/data.csv', content: 'x,y'},
    ]);
    assert.equal(sectionOf(text, 'attachments'), null, '附件不再进系统提示词');
    const block = sectionOf(turnBlock, 'attachments');
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
    // 修订语义：补充意见 = 基于原计划修订，不另起炉灶（继续规划场景的模型行为护栏）
    assert.ok(block.includes('修订当前计划'));
    // 纯净文档语义：计划走 submit_plan 参数（正文不承载计划），对话性内容禁入
    assert.ok(block.includes('submit_plan'));
    assert.ok(block.includes('结尾问句'));
    // 澄清语义：意图/方案有歧义时先用 ask_user，疑问不写进计划、也不用普通文本提问
    assert.ok(block.includes('先用 ask_user 澄清'));
    assert.ok(block.includes('核对用户意图'));
});

test('worktree 块：会话持活跃 worktree 时注入，ctx 未提供或无 worktree 时不注入', async () => {
    const wt = {name: 'demo-ab12', branch: 'cadt/wt/demo-ab12', path: 'D:/repo/.cadt/worktree/demo-ab12', baseSha: 'abc', createdAt: 1};
    // ctx 提供 worktreeBlock（ai-panel 注入 worktreeMod.blockFor）→ 注入且 meta 带名
    const withMod = createAISystemContext(makeCtx({
        ctx: {worktreeBlock: async (session) => (session && session.worktree ? '<worktree>WT-BLOCK ' + session.worktree.name + '</worktree>' : '')},
    }));
    const {text, meta} = await withMod.assembleSystemContext({todos: [], worktree: wt}, []);
    assert.ok(text.includes('<worktree>WT-BLOCK demo-ab12</worktree>'));
    assert.equal(meta.worktree.name, 'demo-ab12');
    // 会话没有 worktree → 块函数返回空串 → 不注入
    const none = await withMod.assembleSystemContext({todos: []}, []);
    assert.ok(!none.text.includes('<worktree>'));
    assert.equal(none.meta.worktree, undefined);
    // ctx 没有该 getter（旧宿主）→ 直接跳过不报错
    const legacy = createAISystemContext(makeCtx());
    const plain = await legacy.assembleSystemContext({todos: [], worktree: wt}, []);
    assert.ok(!plain.text.includes('<worktree>'));
    // 块函数抛错只进 meta.errors，不阻断组装
    const broken = createAISystemContext(makeCtx({
        ctx: {worktreeBlock: async () => { throw new Error('boom'); }},
    }));
    const res = await broken.assembleSystemContext({todos: [], worktree: wt}, []);
    assert.ok(res.meta.errors.some((line) => line.includes('worktree 块：boom')));
});

test('技能索引预算：内置全量必列、用户技能截取上限并报溢出、hidden 过滤', async () => {
    const skills = [
        {name: 'b2', description: '内置 B', source: 'builtin', builtin: true},
        {name: 'u1', description: '用户 1', source: 'workspace', builtin: false},
        {name: 'u2', description: '用户 2', source: 'workspace', builtin: false},
        {name: 'u3', description: '用户 3', source: 'workspace', builtin: false, hidden: true},
        {name: 'u4', description: '用户 4', source: 'workspace', builtin: false},
    ];
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectSkills: true},
        config: {skillIndexMaxUser: 2},
        ctx: {listSkills: async () => skills},
    }));
    const {text, meta} = await mod.assembleSystemContext({todos: []}, []);
    const skillsBlock = sectionOf(text, 'skills');
    assert.ok(skillsBlock.includes('- b2：内置 B（内置）'), '内置技能必须全量列出');
    assert.ok(skillsBlock.includes('- u1：用户 1（workspace）'));
    assert.ok(!skillsBlock.includes('u3'), 'hidden 技能不应出现在索引');
    assert.ok(!skillsBlock.includes('u4'), '超出上限的用户技能不应出现在索引');
    assert.ok(skillsBlock.includes('另有 1 个技能未列出：用 skill_list 查看全部'));
    assert.deepEqual(meta.skills.names, ['b2', 'u1', 'u2']);
    assert.equal(meta.skills.overflow, 1);
});

test('技能索引：上限 clamp 1–100，非法值回落 100；内置不占预算', () => {
    const many = [];
    for (let i = 0; i < 105; i += 1) many.push({name: 'u' + i, description: 'd' + i, source: 'workspace', builtin: false});
    assert.equal(buildSkillsIndexEntries(many, 999).overflow, 5);
    assert.equal(buildSkillsIndexEntries(many, 0).listed.length, 100);
    assert.equal(buildSkillsIndexEntries(many, undefined).listed.length, 100);
    assert.equal(buildSkillsIndexEntries(many, 1).listed.length, 1);
    const withBuiltins = many.map((skill, index) => ({...skill, builtin: index % 2 === 0}));
    const res = buildSkillsIndexEntries(withBuiltins, 1);
    // 内置全量保留（53 个），用户技能只取 1 个
    assert.equal(res.listed.filter((skill) => skill.builtin).length, 53);
    assert.equal(res.listed.filter((skill) => !skill.builtin).length, 1);
});

test('技能描述截断：≤120 原样，超长头 70 + 尾 50，空白折叠', () => {
    assert.equal(truncateSkillDescription('短描述'), '短描述');
    assert.equal(truncateSkillDescription('  a\n b  '), 'a b');
    const head = 'H'.repeat(80);
    const tail = '当用户需要时使用。'.repeat(10); // 90 字
    const cut = truncateSkillDescription(head + tail);
    assert.equal(cut, head.slice(0, 70) + '…' + tail.slice(-50));
    assert.equal(cut.length, 121);
    assert.equal(truncateSkillDescription(null), '');
});

test('记忆占位：MEMORY.md 读不到或为空时注入引导块并标记 placeholder', async () => {
    const missing = createAISystemContext(makeCtx({
        settings: {aiInjectMemory: true},
        ctx: {readTextFile: async () => { throw new Error('not found'); }},
    }));
    const a = await missing.assembleSystemContext({todos: []}, []);
    const memA = sectionOf(a.text, 'memory');
    assert.ok(memA && memA.startsWith('<memory mode="workspace" path="/mem">'));
    assert.ok(memA.includes('（记忆区暂为空）') && memA.includes('MEMORY.md 作为索引'));
    assert.equal(a.meta.memory.placeholder, true);
    assert.equal(a.meta.memory.loaded, true);
    assert.ok(!a.meta.memory.error, '文件不存在不算错误');
    const empty = createAISystemContext(makeCtx({
        settings: {aiInjectMemory: true},
        ctx: {readTextFile: async () => ({text: '   \n'})},
    }));
    const b = await empty.assembleSystemContext({todos: []}, []);
    assert.equal(b.meta.memory.placeholder, true);
    // 有内容：注入原文，不标 placeholder
    const withFile = createAISystemContext(makeCtx({settings: {aiInjectMemory: true}}));
    const c = await withFile.assembleSystemContext({todos: []}, []);
    assert.ok(sectionOf(c.text, 'memory').includes('FILE-CONTENT'));
    assert.ok(!c.meta.memory.placeholder);
});

test('范围根只在 workspace_rules 注入一次；aiInjectRoot 关闭时不再出现', async () => {
    const on = createAISystemContext(makeCtx({
        settings: {aiInjectRoot: true, aiInjectActiveFile: true},
        ctx: {
            getScopeRoot: () => '/w',
            getWorkspaceContext: () => ({activeFile: {path: '/w/a.md', mode: 'code'}, openFiles: []}),
        },
    }));
    const t1 = await on.assembleSystemContext({todos: []}, []);
    const rules = sectionOf(t1.text, 'workspace_rules');
    assert.ok(rules.includes('范围根：/w（工具路径相对此根）'), 'rules 应含范围根（唯一出处）');
    assert.ok(!t1.turnBlock.includes('范围根：'), '环境块不应重复范围根');
    const off = createAISystemContext(makeCtx({
        settings: {aiInjectRoot: false},
        ctx: {getScopeRoot: () => '/w'},
    }));
    const t2 = await off.assembleSystemContext({todos: []}, []);
    assert.ok(!t2.text.includes('范围根：/w（工具路径相对此根）'));
});

test('无工作区 / 无清单 / 无提醒 / 无附件：不生成环境块', async () => {
    const mod = createAISystemContext(makeCtx());
    const {turnBlock, meta} = await mod.assembleSystemContext({todos: []}, []);
    assert.equal(turnBlock, '');
    assert.equal(meta.workspace.loaded, false);
    assert.equal(meta.attachments.count, 0);
});

test('turnContextBundle 可直接调用（起轮路径，同步产出 turnBlock）', () => {
    const mod = createAISystemContext(makeCtx({
        settings: {aiInjectActiveFile: true},
        ctx: {
            getWorkspaceContext: () => ({activeFile: {path: '/w/a.md', mode: 'code'}, openFiles: []}),
            getScopeRoot: () => '/w',
        },
    }));
    const turn = mod.turnContextBundle({todos: []}, []);
    assert.ok(turn.text.startsWith('<system-reminder>\n<workspace_context>'));
    assert.ok(turn.text.endsWith('</system-reminder>'));
    assert.equal(turn.meta.workspace.loaded, true);
});

test('auto 档审批语义收敛进 scopeText：防拆单句保留，重复段已删', async () => {
    const mod = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'auto'}}));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    assert.ok(text.includes('不要把危险操作拆成多条普通命令来规避审批'));
    assert.equal((text.match(/自动审批档：/g) || []).length, 0, 'workspace_rules 里不应再有第二份完整审批表述');
});

test('workspace_rules：memory 守则与涉密引导在，env/spawn 重复行已删', async () => {
    const mod = createAISystemContext(makeCtx({ctx: {currentScopeOf: () => 'edit'}}));
    const {text} = await mod.assembleSystemContext({todos: []}, []);
    const rules = sectionOf(text, 'workspace_rules');
    assert.ok(rules.includes('memory_* 读写跨会话持久记忆'));
    assert.ok(rules.includes('涉密值（API key、令牌、密码等）'));
    assert.ok(!rules.includes('env_list 只返回环境变量的名称与描述'));
    assert.ok(!rules.includes('spawn_agent 派出只读子代理'));
    assert.ok(!rules.includes('write_file 用于新建文件或整体覆盖'), '覆盖前必读语义已收敛到工具描述');
    assert.ok(rules.includes('不要修改 .git 等版本库内部文件'), '.git 红线保留（写档守则）');
});
