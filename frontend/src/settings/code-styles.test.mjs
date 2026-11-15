// 代码风格 / 软件主题双通道的静态护栏。
//
// 2026-11-15：原先 settings.theme 一个开关同时驱动 UI 变量与语法 token，
// 主题列表里还混着 Darcula / IDEA 这类纯代码配色方案。现在拆成
// data-theme（界面）与 data-code-style（代码着色）两条通道。
// 这些断言锁住三件容易漂移的事：列表与 CSS 块一一对应、每套 token 定义齐全
// 且不越界改 UI 变量、auto 时仍回退到软件主题（老用户观感零变化）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    CODE_STYLE_AUTO, CODE_STYLES, CODE_TOKEN_VARS,
    effectiveCodeStyleId, isValidCodeStyleId, currentCodeStyleName,
} from './code-styles.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'style.css'), 'utf8');
const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');
const main = readFileSync(join(here, '..', 'main.js'), 'utf8');
const settingsUi = readFileSync(join(here, 'settings-ui.js'), 'utf8');

test('代码风格列表：id 唯一、明暗分组与来源齐全', () => {
    assert.equal(CODE_STYLES.length, 7, '风格套数与方案约定不一致');
    assert.equal(new Set(CODE_STYLES.map((s) => s.id)).size, CODE_STYLES.length);
    for (const style of CODE_STYLES) {
        assert.ok(style.name && style.from, style.id + ' 缺名称或来源');
        assert.ok(['dark', 'light'].includes(style.group), style.id + ' 明暗分组非法');
    }
    assert.ok(CODE_STYLES.filter((s) => s.group === 'dark').length >= 2);
    assert.ok(CODE_STYLES.filter((s) => s.group === 'light').length >= 2);
});

test('每套风格都定义齐全 token 变量，且没有多余或越界的 CSS 块', () => {
    assert.equal(CODE_TOKEN_VARS.length, 18);
    assert.equal(new Set(CODE_TOKEN_VARS).size, CODE_TOKEN_VARS.length);
    const blocks = [...css.matchAll(/html\[data-theme\]\[data-code-style="([^"]+)"\]\s*\{([^}]*)\}/g)];
    assert.equal(blocks.length, CODE_STYLES.length, 'CSS 风格块数量与列表不一致');
    const ids = new Set(CODE_STYLES.map((s) => s.id));
    for (const [, id, body] of blocks) {
        assert.ok(ids.has(id), 'CSS 里有列表未登记的风格：' + id);
        for (const variable of CODE_TOKEN_VARS) {
            assert.ok(body.includes(variable + ':'), id + ' 缺少 ' + variable);
        }
        assert.ok(!/--(bg|panel|panel2|border|text|muted|accent):/.test(body), id + ' 越界改了 UI 变量');
        assert.ok(!/--ace-/.test(body), id + ' 越界改了编辑器框架色（--ace-* 归软件主题）');
    }
});

test('auto 回退：11 个软件主题都有映射，显式风格可覆盖，非法值安全回落', () => {
    const themeIds = ['dark', 'light', 'darcula', 'idea-dark', 'idea-light', 'github',
        'newsprint', 'night', 'pixyll', 'whitey', 'harness'];
    for (const theme of themeIds) {
        const id = effectiveCodeStyleId(theme, CODE_STYLE_AUTO);
        assert.ok(CODE_STYLES.some((s) => s.id === id), theme + ' 的 auto 映射无效：' + id);
    }
    assert.equal(effectiveCodeStyleId('harness', 'darcula'), 'darcula');
    assert.equal(effectiveCodeStyleId('unknown-theme', CODE_STYLE_AUTO), 'jetbrains-dark');
    assert.equal(effectiveCodeStyleId('light', 'bad-id'), 'jetbrains-light');
    assert.ok(isValidCodeStyleId(CODE_STYLE_AUTO));
    assert.ok(isValidCodeStyleId('shiki'));
    assert.ok(!isValidCodeStyleId('nope'));
    assert.match(currentCodeStyleName('harness', CODE_STYLE_AUTO), /跟随软件主题/);
    assert.equal(currentCodeStyleName('light', 'github-light'), 'GitHub Light');
});

test('代码高亮读 --code-val-* 并回退 --val-*；UI 消费仍归软件主题', () => {
    const uses = [...css.matchAll(/var\(--code-val-[a-z]+,\s*var\(--val-[a-z]+\)\)/g)];
    assert.ok(uses.length >= 15, '取值色改造数量异常：' + uses.length);
    assert.ok(css.includes('.jsoneditor .ace_string { color: var(--code-val-string, var(--val-string)); }'));
    assert.ok(css.includes('.ai-md .hljs-string'), 'AI 回答代码块缺少高亮规则');
    assert.ok(css.includes('--val-key:'), '软件主题仍须定义 --val-*（UI 消费）');
    assert.ok(css.includes('--ace-selection:'), '编辑器框架色仍归软件主题');
});

test('双通道接线：设置页、默认值、AI 白名单、主题菜单、applySettings 都到位', () => {
    assert.ok(html.includes('id="opt-code-style"'), '设置页缺少代码风格下拉');
    assert.ok(main.includes('codeStyle: CODE_STYLE_AUTO'), 'defaultSettings 缺少 codeStyle');
    assert.ok(main.includes("codeStyle: {type: 'enum'"), 'set_setting 白名单缺少 codeStyle');
    assert.ok(main.includes("codeStyle: settings.codeStyle || CODE_STYLE_AUTO"), 'get_state 未返回 codeStyle');
    assert.ok(main.includes("{label: '代码风格', submenu: codeItems}"), '主题菜单缺少代码风格入口');
    assert.ok(settingsUi.includes('delete document.documentElement.dataset.codeStyle'), 'auto 必须移除属性');
    assert.ok(settingsUi.includes('document.documentElement.dataset.codeStyle = id'), '显式风格必须写属性');
    assert.ok(settingsUi.includes('applyCodeStyle();'), 'applySettings 未接上独立通道');
});
