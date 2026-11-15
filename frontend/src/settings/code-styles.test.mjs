// 代码主题 / 软件主题双通道的静态护栏。
//
// 2026-11-15：settings.theme 一个开关拆成 data-theme（界面）与 data-code-style
//（代码着色）两条通道。2026-11-16 主题体系重构：软件主题只维护深色 / 浅色两套，
// 原九套界面主题降级并入代码通道，且从「只管 token」升级为完整编辑器配色方案
//（--editor-bg / --editor-text / --ace-* 随代码主题走）。
// 这些断言锁住四件容易漂移的事：列表与 CSS 块一一对应、每套 token + 编辑器观感
// 定义齐全且不越界改界面变量、auto 时仍回退到软件主题、旧主题迁移映射完整。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    CODE_STYLE_AUTO, CODE_STYLES, CODE_TOKEN_VARS, EDITOR_CHROME_VARS, LEGACY_THEMES,
    effectiveCodeStyleId, isValidCodeStyleId, currentCodeStyleName, migrateLegacyTheme,
} from './code-styles.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'style.css'), 'utf8');
const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');
const main = readFileSync(join(here, '..', 'main.js'), 'utf8');
const settingsUi = readFileSync(join(here, 'settings-ui.js'), 'utf8');

test('代码主题列表：id 唯一、明暗分组与来源齐全', () => {
    assert.equal(CODE_STYLES.length, 9, '代码主题套数与方案约定不一致');
    assert.equal(new Set(CODE_STYLES.map((s) => s.id)).size, CODE_STYLES.length);
    for (const style of CODE_STYLES) {
        assert.ok(style.name && style.from, style.id + ' 缺名称或来源');
        assert.ok(['dark', 'light'].includes(style.group), style.id + ' 明暗分组非法');
    }
    assert.ok(CODE_STYLES.filter((s) => s.group === 'dark').length >= 2);
    assert.ok(CODE_STYLES.filter((s) => s.group === 'light').length >= 5);
});

test('每套代码主题定义齐全 token + 编辑器观感变量，且没有越界的界面变量块', () => {
    assert.equal(CODE_TOKEN_VARS.length, 18);
    assert.equal(EDITOR_CHROME_VARS.length, 7);
    assert.equal(new Set([...CODE_TOKEN_VARS, ...EDITOR_CHROME_VARS]).size, 25);
    const blocks = [...css.matchAll(/html\[data-theme\]\[data-code-style="([^"]+)"\]\s*\{([^}]*)\}/g)];
    assert.equal(blocks.length, CODE_STYLES.length, 'CSS 代码主题块数量与列表不一致');
    const ids = new Set(CODE_STYLES.map((s) => s.id));
    for (const [, id, body] of blocks) {
        assert.ok(ids.has(id), 'CSS 里有列表未登记的代码主题：' + id);
        for (const variable of [...CODE_TOKEN_VARS, ...EDITOR_CHROME_VARS]) {
            assert.ok(body.includes(variable + ':'), id + ' 缺少 ' + variable);
        }
        // 界面变量仍归软件主题；--editor-text / --editor-bg 含「-text/-bg」但都不是裸 --text: / --bg:
        assert.ok(
            !/--(bg|chat-bg|panel|panel2|border|text|muted|accent|on-accent|hover|placeholder|faint|chip-bg|tree-|qs-|find-|word-|field-|git-|scroll-|shadow|mask|banner|icons|fold-|diff-|ai-lv|orange|red|green|warn):/.test(body),
            id + ' 越界改了界面变量');
    }
    // 软件主题块必须有 --editor-bg/--editor-text 默认定义（auto 时编辑器跟随界面）
    assert.ok(css.includes('--editor-bg: var(--bg);'), '软件主题缺少 --editor-bg 默认值');
    assert.ok(css.includes('--editor-text: var(--text);'), '软件主题缺少 --editor-text 默认值');
    // 编辑器本体消费 --editor-bg / --editor-text
    assert.ok(css.includes('background: var(--editor-bg, var(--bg));'), '.ace_editor 未接 --editor-bg');
    assert.ok(css.includes('color: var(--editor-text, var(--text));'), '.ace_editor 未接 --editor-text');
});

test('auto 回退：深浅两套软件主题都有映射，显式风格可覆盖，非法值安全回落', () => {
    for (const theme of ['dark', 'light']) {
        const id = effectiveCodeStyleId(theme, CODE_STYLE_AUTO);
        assert.ok(CODE_STYLES.some((s) => s.id === id), theme + ' 的 auto 映射无效：' + id);
    }
    assert.equal(effectiveCodeStyleId('dark', 'darcula'), 'darcula');
    assert.equal(effectiveCodeStyleId('unknown-theme', CODE_STYLE_AUTO), 'jetbrains-dark');
    assert.equal(effectiveCodeStyleId('light', 'bad-id'), 'jetbrains-light');
    assert.ok(isValidCodeStyleId(CODE_STYLE_AUTO));
    assert.ok(isValidCodeStyleId('pixyll'));
    assert.ok(!isValidCodeStyleId('idea-dark'), '旧界面主题 id 不得再作为代码主题 id');
    assert.ok(!isValidCodeStyleId('nope'));
    assert.match(currentCodeStyleName('dark', CODE_STYLE_AUTO), /跟随软件主题/);
    assert.equal(currentCodeStyleName('light', 'github-light'), 'GitHub Light');
});

test('旧界面主题迁移：9 条映射齐全、显式 codeStyle 不被覆盖、未知 id 返回 null', () => {
    assert.equal(Object.keys(LEGACY_THEMES).length, 9);
    const expected = {
        darcula: ['dark', 'darcula'],
        'idea-dark': ['dark', 'jetbrains-dark'],
        night: ['dark', 'tokyo-night'],
        'idea-light': ['light', 'jetbrains-light'],
        github: ['light', 'github-light'],
        newsprint: ['light', 'newsprint'],
        harness: ['light', 'shiki'],
        pixyll: ['light', 'pixyll'],
        whitey: ['light', 'whitey'],
    };
    for (const [oldId, [theme, codeStyle]] of Object.entries(expected)) {
        assert.deepEqual(migrateLegacyTheme(oldId, CODE_STYLE_AUTO), {theme, codeStyle},
            oldId + ' 的 auto 迁移结果不对');
        // 显式选过代码主题：只迁 UI 主题，保留用户自己的选择
        assert.deepEqual(migrateLegacyTheme(oldId, 'shiki'), {theme, codeStyle: 'shiki'},
            oldId + ' 不应覆盖显式 codeStyle');
    }
    assert.equal(migrateLegacyTheme('dark', CODE_STYLE_AUTO), null);
    assert.equal(migrateLegacyTheme('light', CODE_STYLE_AUTO), null);
    assert.equal(migrateLegacyTheme('plugin-demo', CODE_STYLE_AUTO), null, '插件主题不能被误迁');
    // 迁移在 main.js 设置加载段接线；index.html 启动脚本有防闪错底色的同表副本
    assert.ok(main.includes('migrateLegacyTheme(settings.theme'), 'main.js 未接迁移');
    assert.ok(html.includes("pixyll: 'light'") && html.includes("darcula: 'dark'"),
        'index.html 启动脚本缺少旧主题防闪映射');
});

test('代码高亮读 --code-val-* 并回退 --val-*；UI 消费仍归软件主题', () => {
    const uses = [...css.matchAll(/var\(--code-val-[a-z]+,\s*var\(--val-[a-z]+\)\)/g)];
    assert.ok(uses.length >= 15, '取值色改造数量异常：' + uses.length);
    assert.ok(css.includes('.jsoneditor .ace_string { color: var(--code-val-string, var(--val-string)); }'));
    assert.ok(css.includes('.ai-md .hljs-string'), 'AI 回答代码块缺少高亮规则');
    assert.ok(css.includes('--val-key:'), '软件主题仍须定义 --val-*（UI 消费）');
    assert.ok(css.includes('--ace-selection:'), '软件主题仍须定义 --ace-*（auto 时回退）');
});

test('双通道接线：设置页、默认值、AI 白名单、主题菜单、applySettings 都到位', () => {
    assert.ok(html.includes('id="opt-code-style"'), '设置页缺少代码主题下拉');
    assert.ok(main.includes('codeStyle: CODE_STYLE_AUTO'), 'defaultSettings 缺少 codeStyle');
    assert.ok(main.includes("codeStyle: {type: 'enum'"), 'set_setting 白名单缺少 codeStyle');
    assert.ok(main.includes("codeStyle: settings.codeStyle || CODE_STYLE_AUTO"), 'get_state 未返回 codeStyle');
    assert.ok(main.includes("{label: '代码主题', submenu: codeItems}"), '主题菜单缺少代码主题入口');
    assert.ok(settingsUi.includes('delete document.documentElement.dataset.codeStyle'), 'auto 必须移除属性');
    assert.ok(settingsUi.includes('document.documentElement.dataset.codeStyle = id'), '显式风格必须写属性');
    assert.ok(settingsUi.includes('applyCodeStyle();'), 'applySettings 未接上独立通道');
});
