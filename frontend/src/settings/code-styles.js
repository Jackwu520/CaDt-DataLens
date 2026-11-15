// code-styles.js：代码主题（编辑器配色方案）的单一来源，与软件主题解耦。
//
// 背景：原先 settings.theme → html[data-theme] 一个开关同时决定界面配色与代码高亮。
// 2026-11-15 拆为两条独立通道；2026-11-16 主题体系重构后软件主题只维护深色 / 浅色
// 两套，原 Darcula / IDEA 系 / Github / Newsprint / Night / Pixyll / Whitey / Harness
// 九套界面主题降级并入本通道，且每套从「只管语法 token」升级为完整的编辑器配色
// 方案（底色 --editor-bg / 正文 --editor-text / 行号槽等 --ace-* 随代码主题走）：
//   - 软件主题：settings.theme → data-theme → 界面 UI 变量
//   - 代码主题：settings.codeStyle → data-code-style → token + 编辑器观感变量
// 具体色值仍只在 style.css 里维护，这里只放列表与映射，不维护第二份 JS 色板。
//
// 兼容约定：codeStyle='auto'（默认）时不写 data-code-style 属性，CSS 里没有匹配块，
// 于是变量回落到软件主题块的既有定义。显式选择时
// html[data-theme][data-code-style="X"] 覆盖（特异性更高）。

export const CODE_STYLE_AUTO = 'auto';

// token 变量清单：代码主题块必须逐套定义齐全（护栏测试按此断言）。
// --val-* 不在此列：它同时给 UI（文件图标 / 结构面板 / 运行输出）着色，归软件主题；
// 代码高亮改用 --code-val-*，并写 var(--code-val-x, var(--val-x)) 回退到主题的取值色。
export const CODE_TOKEN_VARS = [
    '--syn-keyword', '--syn-operator', '--syn-comment', '--syn-tag', '--syn-attr',
    '--syn-attr-value', '--syn-yaml-key', '--syn-json-key', '--syn-function', '--syn-heading',
    '--py-builtin', '--py-doc', '--py-self',
    '--code-val-key', '--code-val-string', '--code-val-number', '--code-val-bool', '--code-val-null',
];

// 编辑器观感变量清单（2026-11-16 起）代码主题接管：底色 / 正文 / 选区 / 当前行 /
// 缩进线 / 行号槽。深色 UI 配浅色代码主题时编辑器区完整变浅（对齐 IDEA 的
// 「UI 主题与编辑器配色方案分离」）。
export const EDITOR_CHROME_VARS = [
    '--editor-bg', '--editor-text',
    '--ace-selection', '--ace-active', '--ace-indent', '--ace-punct', '--ace-gutter',
];

// 9 套完整编辑器配色方案：色值从原九套界面主题块原样迁入 style.css。
// jetbrains-dark / jetbrains-light 即原 IDEA Dark / IDEA Light 主题（expUI 官方值）。
export const CODE_STYLES = [
    {id: 'jetbrains-dark', name: 'IDEA Dark', group: 'dark', from: 'dark / idea-dark'},
    {id: 'darcula', name: 'Darcula', group: 'dark', from: 'darcula'},
    {id: 'tokyo-night', name: 'Tokyo Night', group: 'dark', from: 'night'},
    {id: 'jetbrains-light', name: 'IDEA Light', group: 'light', from: 'light / idea-light'},
    {id: 'github-light', name: 'GitHub Light', group: 'light', from: 'github'},
    {id: 'shiki', name: 'Shiki（DeepSeek）', group: 'light', from: 'harness'},
    {id: 'newsprint', name: 'Newsprint 暖纸', group: 'light', from: 'newsprint'},
    {id: 'pixyll', name: 'Pixyll', group: 'light', from: 'pixyll'},
    {id: 'whitey', name: 'Whitey', group: 'light', from: 'whitey'},
];

// auto 时软件主题实际对应的代码主题。仅用于界面展示（「跟随软件主题（当前：X）」）与
// 测试；CSS 的 auto 回退不依赖这张表，它靠「不写 data-code-style」自然落回主题块。
export const THEME_CODE_STYLE = {
    dark: 'jetbrains-dark',
    light: 'jetbrains-light',
};

// 旧版软件主题 id → 新双主题 + 对应代码主题（2026-11-16 重构迁移表）。
// 老用户 settings.theme 存的是降级主题 id：迁移成 深色/浅色 UI 主题，
// 编辑器观感由对应代码主题保留。codeStyle 已显式选择（非 auto）时不动。
export const LEGACY_THEMES = {
    darcula: {theme: 'dark', codeStyle: 'darcula'},
    'idea-dark': {theme: 'dark', codeStyle: 'jetbrains-dark'},
    night: {theme: 'dark', codeStyle: 'tokyo-night'},
    'idea-light': {theme: 'light', codeStyle: 'jetbrains-light'},
    github: {theme: 'light', codeStyle: 'github-light'},
    newsprint: {theme: 'light', codeStyle: 'newsprint'},
    harness: {theme: 'light', codeStyle: 'shiki'},
    pixyll: {theme: 'light', codeStyle: 'pixyll'},
    whitey: {theme: 'light', codeStyle: 'whitey'},
};

// 旧主题迁移：返回 {theme, codeStyle} 或 null（null = 无需迁移；插件注册的主题
// id 不在表内，不会被误伤）。codeStyle 为 auto / 缺省时填入映射的代码主题，
// 显式选择过则保留用户自己的选择。
export function migrateLegacyTheme(themeId, codeStyle) {
    const legacy = LEGACY_THEMES[themeId];
    if (!legacy) return null;
    const out = {theme: legacy.theme, codeStyle: String(codeStyle || CODE_STYLE_AUTO)};
    if (out.codeStyle === CODE_STYLE_AUTO) out.codeStyle = legacy.codeStyle;
    return out;
}

export function isValidCodeStyleId(id) {
    return id === CODE_STYLE_AUTO || CODE_STYLES.some((s) => s.id === id);
}

export function effectiveCodeStyleId(themeId, codeStyle) {
    const id = String(codeStyle || CODE_STYLE_AUTO);
    if (id !== CODE_STYLE_AUTO && CODE_STYLES.some((s) => s.id === id)) return id;
    return THEME_CODE_STYLE[themeId] || 'jetbrains-dark';
}

export function currentCodeStyleName(themeId, codeStyle) {
    const id = String(codeStyle || CODE_STYLE_AUTO);
    if (id === CODE_STYLE_AUTO) {
        const eff = effectiveCodeStyleId(themeId, CODE_STYLE_AUTO);
        const style = CODE_STYLES.find((s) => s.id === eff);
        return '跟随软件主题（' + (style ? style.name : eff) + '）';
    }
    const style = CODE_STYLES.find((s) => s.id === id);
    return style ? style.name : id;
}
