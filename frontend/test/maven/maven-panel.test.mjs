// maven-panel.test.mjs —— Maven 侧边栏面板的接线/生命周期守卫（源码文本级，无 DOM 依赖）。
// 面板强依赖 document，node 环境无 jsdom；这里用源码断言钉住评审修复的关键不变量：
//   · H1 工作区切换清缓存（dataCache 的 id 不含 root，不清会串味）
//   · M4 异步数据加载的 root/seq 竞态守卫
//   · 执行通道复用 runCommand、goal 弹层走 overlay-stack、表单走工厂
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const panelSrc = readFileSync(join(root, 'src/maven/maven-panel.js'), 'utf8');

test('H1：工作区切换清缓存（syncTrigger 检测 key 变化 → resetCaches）', () => {
    assert.ok(/function resetCaches\(\)/.test(panelSrc), '必须有统一的 resetCaches 清缓存入口');
    assert.ok(/if \(trigger\.key !== before\) resetCaches\(\)/.test(panelSrc),
        'syncTrigger 必须在工作区 key 变化时清 dataCache/errors（否则新项目显示旧项目数据）');
    const reset = panelSrc.slice(panelSrc.indexOf('function resetCaches()'), panelSrc.indexOf('function syncButton()'));
    assert.ok(/dataCache\.clear\(\)/.test(reset) && /errors\.clear\(\)/.test(reset),
        'resetCaches 必须清 dataCache 与 errors');
    assert.ok(/projectInfo = null/.test(reset) && /infoKey = ''/.test(reset),
        'resetCaches 必须清项目结构缓存（按 root 缓存）');
});

test('M4：loadData 异步回调有 root/seq 竞态守卫', () => {
    const load = panelSrc.slice(panelSrc.indexOf('async function loadData('), panelSrc.indexOf('// ---------- 执行 ----------'));
    assert.ok(/const root = trigger\.root/.test(load) && /const seq = renderSeq/.test(load),
        'loadData 发起前必须捕获 root 与 seq');
    assert.ok(/root !== trigger\.root \|\| seq !== renderSeq/.test(load),
        'await 后必须校验 root/seq 未变，否则丢弃旧响应（不写缓存、不重绘）');
    assert.ok(/finally[\s\S]*loading\.delete\(id\)/.test(load), 'loading 标记必须在 finally 清理（异常路径不泄漏）');
});

test('执行通道复用 runCommand；goal 走 overlay-stack；表单走工厂', () => {
    assert.ok(/deps\.runCommand\(\{/.test(panelSrc), '生存期命令必须走运行通道（继承门禁/超时杀树/GBK）');
    assert.ok(/overlayStack\.open\(\{/.test(panelSrc), 'goal 弹层必须注册 overlay-stack（Esc 栈序）');
    assert.ok(/createInput\(\{/.test(panelSrc) && /createSwitch\(\{/.test(panelSrc),
        'goal 输入框与执行开关必须走 form-controls 工厂');
    assert.ok(!/window\.addEventListener\('keydown|document\.addEventListener\('keydown/.test(panelSrc),
        '不得自挂 window/document 级 Esc 监听（弹层硬规范）');
});

test('数据命令用固定 kind 白名单，不给任意 goal 开口子', () => {
    assert.ok(/kind === 'dependency-tree'/.test(panelSrc) &&
        /kind === 'effective-pom'/.test(panelSrc), '前端只发固定三种数据 kind');
    assert.ok(/DATA_TIMEOUT_MS/.test(panelSrc), '数据命令必须有超时');
});
