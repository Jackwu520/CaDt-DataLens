// 运行代码的纯函数测试：配方表完整性、扩展名解析、版本门禁、ANSI 上色与位置引用识别。
// 用法：npm test（package.json 的 test 脚本里显式列出本文件）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RECIPES, extOf, stemOf, joinPath, cmdText, versionOf, versionAtLeast,
    ansiSegments, splitRefs, splitRunArgs, applyRunTemplate, SELF_TEST, SELF_TEST_MARK,
    buildRunAnalysisPrompt, runTimeoutRemaining, timeoutLabel,
    activeRunConfig, configRowSubtitle, recentConfigs, resolveRunTarget, resolveRunWidgetLabel,
    findReusableRunSession,
} from '../../src/terminal/run.js';

test('配方表：每项都有 run，编译型必须有 build 与 outExt', () => {
    for (const [ext, recipe] of Object.entries(RECIPES)) {
        assert.equal(typeof recipe.run, 'function', ext + ' 缺少 run');
        assert.ok(recipe.lang, ext + ' 缺少 lang');
        assert.ok(recipe.label, ext + ' 缺少 label');
        if (recipe.build) {
            assert.equal(typeof recipe.build, 'function', ext + ' 的 build 不是函数');
            assert.equal(recipe.outExt, '.exe', ext + ' 的编译产物后缀应为 .exe');
        } else {
            assert.ok(recipe.tool || recipe.shell, ext + ' 需要 tool 或 shell');
        }
        assert.equal(ext, ext.toLowerCase(), ext + '：配方键必须小写');
    }
});

test('配方表：C/C++/Rust 走两段式，语言与工具对应', () => {
    assert.equal(RECIPES.c.tool, 'c');
    assert.equal(RECIPES.cpp.tool, 'cpp');
    assert.equal(RECIPES.rs.tool, 'rust');
    assert.ok(RECIPES.c.build && RECIPES.cpp.build && RECIPES.rs.build);
    const build = RECIPES.c.build({file: 'a.c', out: 'C:\\tmp\\a.exe'});
    assert.deepEqual(build, ['-O0', '-g', '-o', 'C:\\tmp\\a.exe', 'a.c']);
    const run = RECIPES.c.run({args: ['x'], out: 'C:\\tmp\\a.exe'});
    assert.deepEqual(run, ['C:\\tmp\\a.exe', 'x']);
});

test('配方表：解释型参数顺序正确', () => {
    assert.deepEqual(RECIPES.py.run({file: 'a.py', args: ['1']}), ['-u', 'a.py', '1']);
    assert.deepEqual(RECIPES.go.run({file: 'a.go', args: []}), ['run', 'a.go']);
    assert.deepEqual(RECIPES.java.run({file: 'A.java', args: []}), ['A.java']);
    assert.deepEqual(RECIPES.ps1.run({file: 'a.ps1', args: []}), ['-NoLogo', '-NoProfile', '-File', 'a.ps1']);
});

test('extOf / stemOf 处理 Windows 路径与大小写', () => {
    assert.equal(extOf('D:\\data\\Main.PY'), 'py');
    assert.equal(extOf('a.b.cpp'), 'cpp');
    assert.equal(extOf('noext'), '');
    assert.equal(stemOf('D:\\x\\hello.world.py'), 'hello.world');
    assert.equal(stemOf('.gitignore'), '.gitignore');
});

test('joinPath / cmdText 处理路径分隔符与带空格参数', () => {
    assert.equal(joinPath('C:\\temp\\run-1', 'main.c'), 'C:\\temp\\run-1\\main.c');
    assert.equal(joinPath('C:/temp/', 'main.c'), 'C:/temp/main.c');
    assert.equal(joinPath('', 'main.c'), 'main.c');
    assert.equal(cmdText('gcc', ['-o', 'C:\\a b\\x.exe', 'm.c']), 'gcc -o "C:\\a b\\x.exe" m.c');
});

test('versionOf / versionAtLeast 取第一组 x.y 做门禁', () => {
    assert.deepEqual(versionOf('Python 3.12.1'), [3, 12]);
    assert.deepEqual(versionOf('v20.11.0'), [20, 11]);
    assert.deepEqual(versionOf('openjdk version "17.0.2" 2022-01-18'), [17, 0]);
    assert.equal(versionOf('无版本'), null);
    assert.equal(versionAtLeast([22, 6], [22, 6]), true);
    assert.equal(versionAtLeast([22, 5], [22, 6]), false);
    assert.equal(versionAtLeast([20, 11], [22, 6]), false);
    assert.equal(versionAtLeast(null, [11, 0]), true, '版本未知时不拦');
});

test('ansiSegments：普通文本、颜色、加粗与重置', () => {
    const plain = ansiSegments('hello');
    assert.equal(plain.length, 1);
    assert.equal(plain[0].text, 'hello');
    assert.match(plain[0].cls, /run-t/);

    const colored = ansiSegments('\u001b[31mred\u001b[0m normal');
    assert.equal(colored[0].text, 'red');
    assert.match(colored[0].cls, /run-fg-1/);
    assert.equal(colored[1].text, ' normal');
    assert.doesNotMatch(colored[1].cls, /run-fg/);

    const bold = ansiSegments('\u001b[1mb\u001b[22mc');
    assert.match(bold[0].cls, /run-bold/);
    assert.doesNotMatch(bold[1].cls, /run-bold/);
});

test('ansiSegments：非 SGR 转义序列被丢弃，不污染文本', () => {
    const segs = ansiSegments('\u001b[2K\u001b[1Gdone');
    assert.equal(segs.map((s) => s.text).join(''), 'done');
});

test('splitRefs：gcc / node / rustc 的 path:line:col', () => {
    const parts = splitRefs('D:\\work\\main.c:12:5: error: expected');
    const ref = parts.find((p) => p.ref);
    assert.ok(ref, '应识别出位置引用');
    assert.equal(ref.ref.path, 'D:\\work\\main.c');
    assert.equal(ref.ref.line, 12);
    assert.equal(ref.ref.col, 5);
});

test('splitRefs：Python traceback 的 File "x", line N', () => {
    const parts = splitRefs('  File "C:\\a\\b.py", line 7, in <module>');
    const ref = parts.find((p) => p.ref);
    assert.ok(ref, '应识别出 traceback 位置');
    assert.equal(ref.ref.path, 'C:\\a\\b.py');
    assert.equal(ref.ref.line, 7);
});

test('splitRefs：普通文本不误判为路径', () => {
    const parts = splitRefs('hello world: 3 items');
    assert.equal(parts.filter((p) => p.ref).length, 0);
    assert.equal(parts.map((p) => p.text).join(''), 'hello world: 3 items');
});

test('splitRunArgs：空白分隔、引号成组、转义引号', () => {
    assert.deepEqual(splitRunArgs('a b  c'), ['a', 'b', 'c']);
    assert.deepEqual(splitRunArgs('--name "hello world" --n 3'), ['--name', 'hello world', '--n', '3']);
    assert.deepEqual(splitRunArgs("--path 'C://my docs\\a.txt'"), ['--path', 'C://my docs\\a.txt']);
    assert.deepEqual(splitRunArgs('say \\"hi\\"'), ['say', '"hi"']);
});

test('splitRunArgs：Windows 路径里的反斜杠原样保留', () => {
    assert.deepEqual(splitRunArgs('D://data//2026//in.csv --out out.csv'),
        ['D://data//2026//in.csv', '--out', 'out.csv']);
});

test('splitRunArgs：空串与未闭合引号不抛错', () => {
    assert.deepEqual(splitRunArgs(''), []);
    assert.deepEqual(splitRunArgs('   \t '), []);
    assert.deepEqual(splitRunArgs('"half open'), ['half open']);
    assert.deepEqual(splitRunArgs('a "" b'), ['a', '', 'b']);
});

test('配方：运行参数只进执行步骤，不进编译步骤', () => {
    const ctx = {file: 'main.c', dir: '.', out: 'main.exe', args: ['one', 'two']};
    assert.deepEqual(RECIPES.c.build(ctx), ['-O0', '-g', '-o', 'main.exe', 'main.c']);
    assert.deepEqual(RECIPES.c.run(ctx), ['main.exe', 'one', 'two']);
    assert.deepEqual(RECIPES.rs.run(ctx), ['main.exe', 'one', 'two']);
    assert.deepEqual(RECIPES.py.run(ctx), ['-u', 'main.c', 'one', 'two']);
});

test('配方：脚本解释器同样接收运行参数', () => {
    const ctx = {file: 'a.sh', dir: '.', out: '', args: ['x']};
    assert.deepEqual(RECIPES.sh.run(ctx), ['a.sh', 'x']);
    assert.deepEqual(RECIPES.bat.run(ctx), ['/c', 'a.sh', 'x']);
    assert.deepEqual(RECIPES.ps1.run(ctx), ['-NoLogo', '-NoProfile', '-File', 'a.sh', 'x']);
});

test('applyRunTemplate：占位符是单个 argv，路径含空格不被切开', () => {
    const ctx = {
        tool: 'C://py//python.exe', file: 'C://my docs\\a.py', dir: 'C://my docs',
        base: 'a.py', stem: 'a', ext: 'py', out: 'a.exe', args: ['--x', 'hello world'],
    };
    assert.deepEqual(applyRunTemplate('$TOOL -u $FILE $ARGS', ctx),
        ['C://py//python.exe', '-u', 'C://my docs\\a.py', '--x', 'hello world']);
    assert.deepEqual(applyRunTemplate('"$TOOL" "--in=$FILE" $ARGS', ctx),
        ['C://py//python.exe', '--in=C://my docs\\a.py', '--x', 'hello world']);
});

test('applyRunTemplate：全部占位符与编译型 $OUT', () => {
    const ctx = {tool: 'gcc', file: 'D://w//main.c', dir: 'D://w', base: 'main.c', stem: 'main', ext: 'c', out: 'D://tmp//main.exe', args: []};
    assert.deepEqual(applyRunTemplate('$OUT $STEM $EXT $BASE $DIR', ctx),
        ['D://tmp//main.exe', 'main', 'c', 'main.c', 'D://w']);
});

test('applyRunTemplate：空模板与未知占位符', () => {
    assert.deepEqual(applyRunTemplate('', {}), []);
    assert.deepEqual(applyRunTemplate('$TOOL $NOPE', {tool: 'py'}), ['py', '$NOPE']);
    assert.deepEqual(applyRunTemplate('$ARGS', {args: ['a', 'b']}), ['a', 'b']);
});

test('SELF_TEST：每个自检脚本都有配方、文件名与固定标记', () => {
    assert.ok(Object.keys(SELF_TEST).length >= 10);
    for (const [ext, info] of Object.entries(SELF_TEST)) {
        assert.ok(RECIPES[ext], ext + ' 缺少运行配方');
        assert.ok(info.name.endsWith('.' + ext), ext + ' 的文件名后缀不匹配');
        assert.ok(info.code.includes(SELF_TEST_MARK), ext + ' 没有打印固定标记');
    }
});

test('buildRunAnalysisPrompt：空输出返回空串，元数据进入提示词', () => {
    assert.equal(buildRunAnalysisPrompt('   \n  ', {}), '');
    const p = buildRunAnalysisPrompt('Traceback\nValueError: bad', {file: 'a.py', lang: 'Python', code: 1});
    assert.ok(p.includes('a.py') && p.includes('Python') && p.includes('退出码：1'));
    assert.ok(p.includes('ValueError: bad'));
});

test('buildRunAnalysisPrompt：尾部 200 行与 12000 字符双重截断', () => {
    const many = Array.from({length: 300}, (_, i) => 'line-' + i).join('\n');
    const p1 = buildRunAnalysisPrompt(many, {});
    assert.ok(p1.includes('line-299') && !p1.includes('line-0\n'), '只保留尾部 200 行');
    const huge = 'x'.repeat(20000) + '\nTHE_END';
    const p2 = buildRunAnalysisPrompt(huge, {});
    assert.ok(p2.includes('已省略') && p2.includes('THE_END'));
    assert.ok(p2.length < 13000, '提示词长度应受控');
});

test('runTimeoutRemaining：任务级截止时刻，不限时返回 0', () => {
    assert.equal(runTimeoutRemaining(1000, 0, 500), 0, '超时关闭时恒为 0');
    assert.equal(runTimeoutRemaining(1000, -5, 500), 0, '负数视为不限时');
    assert.equal(runTimeoutRemaining(1000, 3000, 2000), 2000, '剩余 = 上限 - 已耗时');
    assert.equal(runTimeoutRemaining(1000, 3000, 4500), -500, '已过截止时刻为负');
    assert.equal(runTimeoutRemaining(1000, 3000, 4000), 0, '正好到点为 0');
});

test('runTimeoutRemaining：编译耗时计入同一截止时刻（分步传剩余）', () => {
    const startedAt = 1000;
    const timeoutMs = 5000;
    // build 步吃掉 3000ms，run 步只能拿到剩余 2000ms
    assert.equal(runTimeoutRemaining(startedAt, timeoutMs, 4000), 2000);
    // build 步吃掉 5500ms，run 步开跑前就已超时
    assert.equal(runTimeoutRemaining(startedAt, timeoutMs, 6500), -500);
});

test('timeoutLabel：秒与分钟的人类可读格式', () => {
    assert.equal(timeoutLabel(0), '不限时');
    assert.equal(timeoutLabel(30000), '30 秒');
    assert.equal(timeoutLabel(60000), '1 分钟');
    assert.equal(timeoutLabel(300000), '5 分钟');
    assert.equal(timeoutLabel(90000), '1.5 分钟');
});

// ---- 运行配置模型（绑定文件的配置 + 旧版参数预设）----

test('activeRunConfig：按 runActiveProfile 匹配，找不到或没选返回 null', () => {
    const profiles = [
        {id: 'a', name: 'run', file: 'D:/w/main.py', lang: 'python'},
        {id: 'b', name: '预设', lang: 'python'},
    ];
    assert.equal(activeRunConfig({runActiveProfile: 'a', runProfiles: profiles}), profiles[0]);
    assert.equal(activeRunConfig({runActiveProfile: 'b', runProfiles: profiles}), profiles[1]);
    assert.equal(activeRunConfig({runActiveProfile: 'x', runProfiles: profiles}), null);
    assert.equal(activeRunConfig({runActiveProfile: '', runProfiles: profiles}), null);
    assert.equal(activeRunConfig(undefined), null);
    assert.equal(activeRunConfig({runActiveProfile: 'a'}), null, 'runProfiles 缺省时返回 null');
});

test('resolveRunTarget：绑定文件决定 doc / disk，未绑定返回 null', () => {
    const same = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
    const cfg = {file: 'D:/w/main.py'};
    assert.equal(resolveRunTarget(cfg, 'D:/W/MAIN.PY', same), 'doc', '同一路径（大小写/分隔符无关）走内存流');
    assert.equal(resolveRunTarget(cfg, 'D:/w/other.py', same), 'disk');
    assert.equal(resolveRunTarget(cfg, '', same), 'disk');
    assert.equal(resolveRunTarget({name: '预设'}, 'D:/w/main.py', same), null, '旧预设不改变目标');
    assert.equal(resolveRunTarget(null, 'D:/w/main.py', same), null);
    assert.equal(resolveRunTarget({file: ''}, 'D:/w/main.py', same), null, '空 file 视为未绑定');
});

test('resolveRunWidgetLabel：配置名优先，否则文件名，再否则「当前文件」', () => {
    assert.equal(resolveRunWidgetLabel({name: 'run'}, 'main.py'), 'run');
    assert.equal(resolveRunWidgetLabel(null, 'main.py'), 'main.py');
    assert.equal(resolveRunWidgetLabel(null, ''), '当前文件');
    assert.equal(resolveRunWidgetLabel(null, null), '当前文件');
});

test('recentConfigs：lastUsedAt 降序、过滤未用过的、cap 截断', () => {
    const list = [
        {id: 'a', lastUsedAt: 100},
        {id: 'b', lastUsedAt: 300},
        {id: 'c'},
        {id: 'd', lastUsedAt: 200},
        {id: 'e', lastUsedAt: 400},
    ];
    assert.deepEqual(recentConfigs(list, 5).map((p) => p.id), ['e', 'b', 'd', 'a']);
    assert.deepEqual(recentConfigs(list, 2).map((p) => p.id), ['e', 'b']);
    assert.deepEqual(recentConfigs([], 5), []);
    assert.deepEqual(recentConfigs(null, 5), []);
});

test('configRowSubtitle：绑定文件显示路径，旧预设显示语言桶说明', () => {
    assert.equal(configRowSubtitle({file: 'D:/w/main.py'}), 'D:/w/main.py');
    assert.equal(configRowSubtitle({lang: 'python'}), '[python] 参数预设');
    assert.equal(configRowSubtitle({}), '参数预设（作用于当前文件）');
});

// ---- 运行标签复用（同一文件反复运行不新建标签）----

test('findReusableRunSession：同路径复用，不同路径各自新建', () => {
    const a = {path: 'D:/w/a.py', selfTest: false};
    const b = {path: 'D:/w/b.py', selfTest: false};
    const sessions = [a, b];
    assert.equal(findReusableRunSession(sessions, 'D:/w/a.py'), a, '命中同路径');
    assert.equal(findReusableRunSession(sessions, 'D:/w/b.py'), b);
    assert.equal(findReusableRunSession(sessions, 'D:/w/c.py'), null, '不同路径不命中');
});

test('findReusableRunSession：自检与无 path 会话不参与复用', () => {
    const selfTest = {path: 'D:/w/a.py', selfTest: true};
    const noPath = {path: '', selfTest: false};
    const project = {path: '', selfTest: false, recipe: {lang: 'project'}};
    const sessions = [selfTest, noPath, project];
    assert.equal(findReusableRunSession(sessions, 'D:/w/a.py'), null, '自检会话不参与复用');
    assert.equal(findReusableRunSession(sessions, ''), null, '空 path 不命中');
    assert.equal(findReusableRunSession(sessions, null), null);
});

test('findReusableRunSession：空会话表与异常输入不抛错', () => {
    assert.equal(findReusableRunSession([], 'D:/w/a.py'), null);
    assert.equal(findReusableRunSession(null, 'D:/w/a.py'), null);
    assert.equal(findReusableRunSession(undefined, 'D:/w/a.py'), null);
    assert.equal(findReusableRunSession([null, undefined], 'D:/w/a.py'), null, '坏条目跳过');
});
