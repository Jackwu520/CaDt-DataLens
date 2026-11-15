import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    applyOutputWindowLimit,
    clampNumber,
    configForModel,
    CTX_LIMIT_TIERS,
    ctxLimitTiersFor,
    defaultModalities,
    effectiveContextWindow,
    findModelEntry,
    formatTokenAmount,
    migrateAccountModels,
    modelEntryOf,
    modelRefLabel,
    normalizeCtxLimit,
    normalizeModalities,
    normalizeModelEntry,
    parseTokenAmount,
    reasoningLevelInfo,
    resolveModelId,
    resolveModelRef,
} from './ai-config-model.js';

test('parseTokenAmount：支持 K / M / 纯数字 / 小数 / 千分位，非法返回 null', () => {
    assert.equal(parseTokenAmount('256K'), 262144);
    assert.equal(parseTokenAmount('131K'), 134144);
    assert.equal(parseTokenAmount('1M'), 1048576);
    assert.equal(parseTokenAmount('1.5M'), 1572864);
    assert.equal(parseTokenAmount('2m'), 2097152);
    assert.equal(parseTokenAmount('8k'), 8192);
    assert.equal(parseTokenAmount('4096'), 4096);
    assert.equal(parseTokenAmount(' 1,048,576 '), 1048576);
    assert.equal(parseTokenAmount(65536), 65536);
    assert.equal(parseTokenAmount(''), null);
    assert.equal(parseTokenAmount('abc'), null);
    assert.equal(parseTokenAmount('-5K'), null);
    assert.equal(parseTokenAmount('12KB'), null);
    assert.equal(parseTokenAmount('0'), null);
});

test('formatTokenAmount：整 K / M 用单位显示，否则原样', () => {
    assert.equal(formatTokenAmount(262144), '256K');
    assert.equal(formatTokenAmount(131072), '128K');
    assert.equal(formatTokenAmount(1048576), '1M');
    assert.equal(formatTokenAmount(1572864), '1536K', '不整除 1M 时退回 K 显示');
    assert.equal(formatTokenAmount(4096), '4K');
    assert.equal(formatTokenAmount(5000), '5000');
    assert.equal(formatTokenAmount(0), '');
    assert.equal(formatTokenAmount('bad'), '');
});

test('normalizeModalities：默认勾选文本+图像，非法输入收敛', () => {
    assert.deepEqual(normalizeModalities(null), defaultModalities());
    assert.deepEqual(normalizeModalities({}), {text: true, image: true, video: false, audio: false});
    assert.deepEqual(
        normalizeModalities({text: false, image: true, video: true, audio: 'yes'}),
        {text: false, image: true, video: true, audio: false});
});

test('normalizeModelEntry：字段 clamp 与回退', () => {
    const entry = normalizeModelEntry({
        id: 'm1',
        model: ' deepseek-chat ',
        contextWindow: '256K',
        outputWindow: 99999999,
        modalities: {image: false},
        reasoningEffort: 'ultra',
        thinkingBudget: 0,
    }, () => 'gen-1');
    assert.equal(entry.model, 'deepseek-chat');
    assert.equal(entry.contextWindow, 262144);
    assert.equal(entry.outputWindow, 2097152, '超限输出窗口收敛到上限');
    assert.deepEqual(entry.modalities, {text: true, image: false, video: false, audio: false});
    assert.equal(entry.reasoningEffort, '');
    assert.equal(entry.thinkingBudget, 1024);
    const fallback = normalizeModelEntry(null, () => 'gen-2');
    assert.equal(fallback.id, 'gen-2');
    assert.equal(fallback.contextWindow, 128000);
    assert.equal(fallback.outputWindow, 4096);
});

test('migrateAccountModels：旧版单模型 profile 迁移为首条目并镜像旧字段', () => {
    const account = {
        id: 'p1',
        model: 'deepseek-chat',
        maxTokens: 8192,
        contextWindow: 128000,
        reasoningEffort: 'high',
        thinking: false,
        thinkingBudget: 8000,
    };
    const models = migrateAccountModels(account, '', () => 'gen-1');
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'p1-m1');
    assert.equal(models[0].model, 'deepseek-chat');
    assert.equal(models[0].outputWindow, 8192);
    assert.equal(models[0].contextWindow, 128000);
    assert.deepEqual(models[0].modalities, {text: true, image: true, video: false, audio: false});
    // 旧字段镜像 = 激活（缺省首）条目
    assert.equal(account.model, 'deepseek-chat');
    assert.equal(account.maxTokens, 8192);
    assert.equal(account.contextWindow, 128000);
});

test('migrateAccountModels：已有 models 数组去重归一，镜像跟随激活条目', () => {
    const account = {
        id: 'p1',
        models: [
            {id: 'm1', model: 'deepseek-chat', contextWindow: '128K', outputWindow: '8K'},
            {id: 'm2', model: 'deepseek-reasoner', contextWindow: 131072, outputWindow: 65536, reasoningEffort: 'high'},
            'junk',
            {id: 'm1', model: 'dup'},
        ],
    };
    const models = migrateAccountModels(account, 'm2', () => 'gen-1');
    assert.equal(models.length, 2);
    assert.equal(models[0].contextWindow, 131072);
    assert.equal(models[0].outputWindow, 8192);
    assert.equal(models[1].reasoningEffort, 'high');
    // 镜像 = 激活条目 m2
    assert.equal(account.model, 'deepseek-reasoner');
    assert.equal(account.maxTokens, 65536);
    assert.equal(account.contextWindow, 131072);
    assert.equal(account.reasoningEffort, 'high');
});

test('modelEntryOf：精确匹配激活条目，缺省退回首条目', () => {
    const account = {models: [{id: 'm1', model: 'a'}, {id: 'm2', model: 'b'}]};
    assert.equal(modelEntryOf(account, 'm2').model, 'b');
    assert.equal(modelEntryOf(account, 'ghost').model, 'a');
    assert.equal(modelEntryOf(account, ''), modelEntryOf(account, ''));
    assert.equal(modelEntryOf(null, ''), null);
});

test('configForModel：连接字段取账号、模型字段取条目，Anthropic 强制 reasoning 为空', () => {
    const account = {
        provider: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        apiKey: 'sk-1',
        temperature: 0.5,
        proxy: 'direct',
        extraHeaders: {'X-A': '1'},
    };
    const entry = {
        model: 'claude-x',
        outputWindow: 16384,
        thinking: true,
        thinkingBudget: 8000,
        reasoningEffort: 'high',
    };
    const cfg = configForModel(account, entry);
    assert.equal(cfg.provider, 'anthropic');
    assert.equal(cfg.baseURL, 'https://api.anthropic.com');
    assert.equal(cfg.model, 'claude-x');
    assert.equal(cfg.maxTokens, 16384);
    assert.equal(cfg.thinking, true);
    assert.equal(cfg.thinkingBudget, 8000);
    assert.equal(cfg.reasoningEffort, '');
    assert.deepEqual(cfg.extraHeaders, {'X-A': '1'});
    const openai = configForModel({provider: 'openai', baseURL: '', apiKey: ''}, {model: 'm', outputWindow: 4096, reasoningEffort: 'low'});
    assert.equal(openai.reasoningEffort, 'low');
    assert.equal(openai.thinking, false);
});

test('reasoningLevelInfo：openai 系按 reasoningEffort 推导，非法/缺省归自动', () => {
    const account = {provider: 'openai'};
    assert.deepEqual(
        {...reasoningLevelInfo(account, {reasoningEffort: 'medium'})},
        {value: 'medium', label: '中', options: [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']], tone: 'mid'});
    assert.equal(reasoningLevelInfo(account, {reasoningEffort: 'low'}).label, '低');
    assert.equal(reasoningLevelInfo(account, {reasoningEffort: 'high'}).tone, 'high');
    assert.equal(reasoningLevelInfo(account, {reasoningEffort: ''}).value, 'auto');
    assert.equal(reasoningLevelInfo(account, {reasoningEffort: 'ultra'}).value, 'auto');
    assert.equal(reasoningLevelInfo(account, {reasoningEffort: 'auto'}).label, '自动');
    assert.equal(reasoningLevelInfo(account, {reasoningEffort: 'auto'}).tone, 'auto');
    assert.equal(reasoningLevelInfo(account, null).value, 'auto', '无条目兜底自动');
    assert.equal(reasoningLevelInfo(null, null).value, 'auto', '无账号兜底自动');
    // Responses 协议同 openai 系
    assert.equal(reasoningLevelInfo({provider: 'responses'}, {reasoningEffort: 'high'}).value, 'high');
});

test('reasoningLevelInfo：anthropic 按 thinking/thinkingBudget 反推档位，档位表含「关」', () => {
    const account = {provider: 'anthropic'};
    const info = reasoningLevelInfo(account, {thinking: false, thinkingBudget: 8000});
    assert.equal(info.value, 'off');
    assert.equal(info.label, '关');
    assert.equal(info.tone, 'auto');
    assert.deepEqual(info.options, [['off', '关'], ['low', '低'], ['medium', '中'], ['high', '高']]);
    // 预算反推沿用旧边界：≤2048 低、≤10000 中、其余高（缺省 8000 = 中）
    assert.equal(reasoningLevelInfo(account, {thinking: true, thinkingBudget: 1024}).value, 'low');
    assert.equal(reasoningLevelInfo(account, {thinking: true, thinkingBudget: 2048}).value, 'low');
    assert.equal(reasoningLevelInfo(account, {thinking: true, thinkingBudget: 8000}).value, 'medium');
    assert.equal(reasoningLevelInfo(account, {thinking: true, thinkingBudget: 10000}).value, 'medium');
    assert.equal(reasoningLevelInfo(account, {thinking: true, thinkingBudget: 16000}).value, 'high');
    assert.equal(reasoningLevelInfo(account, {thinking: true}).value, 'medium', '无预算按缺省 8000 归中');
    assert.equal(reasoningLevelInfo(account, null).value, 'off', '无条目兜底关');
});

test('resolveModelRef：新格式校验双 id，旧格式解析为首条目，失效回空', () => {
    const profiles = [
        {id: 'p1', models: [{id: 'm1', model: 'a'}, {id: 'm2', model: 'b'}]},
        {id: 'p2', models: [{id: 'm3', model: 'c'}]},
    ];
    assert.equal(resolveModelRef('p1|m2', profiles), 'p1|m2');
    assert.equal(resolveModelRef('p2', profiles), 'p2|m3', '旧格式解析为账号首条目');
    assert.equal(resolveModelRef('p1|ghost', profiles), '');
    assert.equal(resolveModelRef('ghost|m1', profiles), '');
    assert.equal(resolveModelRef('', profiles), '');
    assert.equal(resolveModelRef('p1|m2', null), '');
    assert.equal(resolveModelRef(null, profiles), '');
});

test('modelRefLabel：模型名 · 账号名；缺模型名退回账号名', () => {
    assert.equal(modelRefLabel({name: 'DeepSeek 账号'}, {model: 'deepseek-chat'}), 'deepseek-chat · DeepSeek 账号');
    assert.equal(modelRefLabel({name: 'deepseek-chat'}, {model: 'deepseek-chat'}), 'deepseek-chat');
    assert.equal(modelRefLabel({name: '备用'}, {model: ''}), '备用');
});

test('clampNumber：非数字回退、越界收敛', () => {
    assert.equal(clampNumber('128', 1, 100, 50), 100);
    assert.equal(clampNumber('bad', 1, 100, 50), 50);
    assert.equal(clampNumber('3.6', 1, 100, 50), 4);
});

test('normalizeCtxLimit：非有限数 / ≤0 归 0，其余取整并 clamp 到窗口上限', () => {
    assert.equal(normalizeCtxLimit(0), 0);
    assert.equal(normalizeCtxLimit(-5), 0);
    assert.equal(normalizeCtxLimit(null), 0);
    assert.equal(normalizeCtxLimit(undefined), 0);
    assert.equal(normalizeCtxLimit(''), 0);
    assert.equal(normalizeCtxLimit('bad'), 0);
    assert.equal(normalizeCtxLimit('256K'), 262144, '支持 K/M 字符串（读回旧 meta 时的容错）');
    assert.equal(normalizeCtxLimit(262143.6), 262144);
    assert.equal(normalizeCtxLimit(CTX_LIMIT_TIERS[2]), 1048576);
    assert.equal(normalizeCtxLimit(99999999), 8388608, '超过 CONTEXT_WINDOW_MAX 收敛');
});

test('effectiveContextWindow：上限只收窄不放大，0 = 不设限', () => {
    assert.equal(effectiveContextWindow(1048576, 0), 1048576);
    assert.equal(effectiveContextWindow(1048576, undefined), 1048576);
    assert.equal(effectiveContextWindow(1048576, 262144), 262144, '上限低于模型窗口时收窄');
    assert.equal(effectiveContextWindow(262144, 524288), 262144, '上限高于模型窗口时取模型窗口');
    assert.equal(effectiveContextWindow(262144, 262144), 262144, '上限等于模型窗口 = 不设限效果');
    assert.equal(effectiveContextWindow(128000, 'bad'), 128000, '非法上限回退模型窗口');
    assert.equal(effectiveContextWindow(0, 0), 0, '异常基线不放大为正数');
});

test('applyOutputWindowLimit：只降不升，超限时同步压低思考预算', () => {
    const entry = {model: 'sensenova-6.8-flash', outputWindow: 134144, thinkingBudget: 8000};
    assert.equal(applyOutputWindowLimit(entry, 131072), true);
    assert.equal(entry.outputWindow, 131072);
    assert.equal(entry.thinkingBudget, 8000, '预算未越界时保持原值');
    assert.equal(applyOutputWindowLimit(entry, 131072), false, '已在上界内不再改动');
    assert.equal(applyOutputWindowLimit(entry, 262144), false, '只降不升');

    const small = {outputWindow: 65536, thinkingBudget: 8000};
    assert.equal(applyOutputWindowLimit(small, 4096), true);
    assert.equal(small.outputWindow, 4096);
    assert.equal(small.thinkingBudget, 4095, '预算必须小于 maxTokens');

    assert.equal(applyOutputWindowLimit(null, 131072), false);
    assert.equal(applyOutputWindowLimit({outputWindow: 134144}, 0), false, '无效上限不回写');
    assert.equal(applyOutputWindowLimit({outputWindow: 134144}, 'bad'), false);
    assert.equal(applyOutputWindowLimit({}, 131072), false, '条目没有窗口值时不回写');
    const clamped = {outputWindow: 99999999};
    assert.equal(applyOutputWindowLimit(clamped, 99999999), true);
    assert.equal(clamped.outputWindow, 2097152, '超过 UI 上限时夹到 OUTPUT_WINDOW_MAX');
});

test('接线护栏：max_tokens 自动降档事件跨 Go / main.js / ai-panel.js 一致', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(read('../../../ai_types.go'), /aiEventParamAdjust\s*=\s*"ai-param-adjust"/);
    assert.match(read('../main.js'), /'ai-param-adjust'/,
        'main.js 必须订阅降档事件，否则 Go 侧 emit 无人接收');
    assert.match(read('./ai-panel.js'), /case 'ai-param-adjust':/);
    assert.match(read('./ai-panel.js'), /applyOutputWindowLimit\(/,
        '输出窗口回写必须走单一纯函数');
});

test('接线护栏：Go 侧每个 AI 流式事件都有 main.js 订阅与面板分支', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const names = [...read('../../../ai_types.go').matchAll(/\baiEvent\w+\s*=\s*"([^"]+)"/g)]
        .map((m) => m[1]);
    assert.ok(names.length >= 7, '至少应解析出 chunk/think/toolcall/done/error/retry/param-adjust');
    const main = read('../main.js');
    const list = /for \(const eventName of \[([^\]]+)\]\)\s*\{\s*rt\.EventsOn\(eventName/.exec(main);
    assert.ok(list, 'main.js 的 AI 事件订阅数组应存在');
    const panel = read('./ai-panel.js');
    for (const name of names) {
        assert.ok(list[1].includes(`'${name}'`), `main.js 未订阅 ${name}，Go 侧 emit 无人接收`);
        assert.ok(panel.includes(`case '${name}':`), `ai-panel.js 缺少 ${name} 的处理分支`);
    }
});

test('ctxLimitTiersFor：只保留严格小于模型窗口的档位，≤最小档时为空', () => {
    assert.deepEqual(CTX_LIMIT_TIERS, [262144, 524288, 1048576], '固定档位表：256K / 512K / 1M');
    assert.deepEqual(ctxLimitTiersFor(1048576), [262144, 524288], '1M 模型出 256K/512K 两档（1M=默认不重复出）');
    assert.deepEqual(ctxLimitTiersFor(524288), [262144], '512K 模型只出 256K 档');
    assert.deepEqual(ctxLimitTiersFor(262144), [], '256K 模型无可选档位 → 隐藏整个设置');
    assert.deepEqual(ctxLimitTiersFor(128000), [], '128K 默认窗口同样隐藏');
    assert.deepEqual(ctxLimitTiersFor(384 * 1024), [262144], '窗口在档位之间时保留更小的档');
    assert.deepEqual(ctxLimitTiersFor(0), []);
    assert.deepEqual(ctxLimitTiersFor('bad'), []);
});

test('findModelEntry：严格按 id 命中，失效/空 id 返回 null（不做静默回落）', () => {
    const account = {models: [{id: 'a', model: 'm1'}, {id: 'b', model: 'm2'}]};
    assert.equal(findModelEntry(account, 'b').model, 'm2');
    assert.equal(findModelEntry(account, 'a').model, 'm1');
    assert.equal(findModelEntry(account, 'ghost'), null, '失效 id 必须返回 null，否则兜底恒真');
    assert.equal(findModelEntry(account, ''), null);
    assert.equal(findModelEntry(account, undefined), null);
    assert.equal(findModelEntry(null, 'a'), null);
    assert.equal(findModelEntry({}, 'a'), null);
    // 对照：modelEntryOf 保留「取可用条目」的回落语义，不能拿它做校验
    assert.equal(modelEntryOf(account, 'ghost').id, 'a');
});

test('resolveModelId：preferred → fallback → 首条目，失效 id 不写回', () => {
    const account = {models: [{id: 'a'}, {id: 'b'}, {id: 'c'}], lastModelId: 'b'};
    assert.equal(resolveModelId(account, 'c', 'b'), 'c', 'preferred 有效时优先');
    assert.equal(resolveModelId(account, 'ghost', 'b'), 'b', 'preferred 失效回账号记住的条目');
    assert.equal(resolveModelId(account, 'ghost', 'also-ghost'), 'a', '两者都失效回首条目');
    assert.equal(resolveModelId(account, '', 'b'), 'b');
    assert.equal(resolveModelId({models: []}, 'x', 'y'), '', '无条目返回空串');
    assert.equal(resolveModelId(null, 'x', 'y'), '');
});

test('新会话模型继承接线：继承当前会话在用的模型，切会话同步窗口默认', () => {
    const src = readFileSync(new URL('./ai-panel.js', import.meta.url), 'utf8');
    const createBlock = /function createSessionData\(title\)[\s\S]*?ctxLimit:/.exec(src);
    assert.ok(createBlock, 'createSessionData 应存在');
    assert.match(createBlock[0], /profileId:\s*inherited\.profileId/, '新会话应继承继承出来的账号');
    assert.match(createBlock[0], /modelId:\s*inherited\.modelId/, '新会话应继承继承出来的模型');
    assert.doesNotMatch(createBlock[0], /profileId:\s*aiTextOf\(config\.activeProfileId\)/,
        '不能只读窗口默认：config.active* 只是「上次显式切换」的结果，会与实际在用的模型脱节');
    // 继承来源：当前会话实际生效的账号+条目，缺失才回落窗口默认
    const inheritBlock = /function inheritModelRef\(\)[\s\S]*?\n    \}/.exec(src);
    assert.ok(inheritBlock, 'inheritModelRef 应存在');
    assert.match(inheritBlock[0], /sessionModelRef\(\)/, '继承来源必须是当前会话的模型引用');
    assert.match(inheritBlock[0], /aiTextOf\(config\.activeProfileId\)/, '无会话时回落窗口默认账号');
    assert.match(inheritBlock[0], /aiTextOf\(config\.activeModelId\)/, '无会话时回落窗口默认模型');
    // 切会话把窗口默认同步成该会话的模型，否则下一次新建又拿到旧值
    const syncBlock = /function syncActiveFromSession\(session\)[\s\S]*?\n    \}/.exec(src);
    assert.ok(syncBlock, 'syncActiveFromSession 应存在');
    assert.match(syncBlock[0], /sessionModelRef\(session\)/);
    assert.match(syncBlock[0], /config\.activeProfileId = ref\.profile\.id/);
    assert.match(syncBlock[0], /config\.activeModelId = ref\.entry\.id/);
    assert.match(syncBlock[0], /pluginAI/, '插件虚拟账号不能写进窗口默认（落盘就是悬空 id）');
    assert.match(src, /config\.activeSessionId = id;[\s\S]{0,400}?syncActiveFromSession\(target\);\s*\n\s*saveAIConfig\(\);/,
        'switchSession 里必须在保存配置前同步窗口默认');
    assert.match(src, /out\.activeModelId = resolveModelId\(activeAccount, out\.activeModelId, activeAccount\.lastModelId\)/,
        '配置归一化的激活模型兜底必须走 resolveModelId');
    assert.doesNotMatch(src, /if \(!modelEntryOf\([^)]*\)\)/, '不得再用恒假的 modelEntryOf 做校验');
});

test('设置页模型选择接线：chip 点击同步 lastModelId，兜底用严格查找', () => {
    const src = readFileSync(new URL('./ai-model-settings.js', import.meta.url), 'utf8');
    const chipBlock = /chip\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);/.exec(src);
    assert.ok(chipBlock, '条目 chip 点击处理应存在');
    assert.match(chipBlock[0], /profile\.lastModelId = entry\.id/, '选条目必须同时写账号记忆');
    assert.match(chipBlock[0], /activeModelId = entry\.id/, '选条目必须写窗口选择');
    assert.doesNotMatch(src, /if \(!modelEntryOf\([^)]*\)\)/, '设置页不得再用恒假校验');
});
