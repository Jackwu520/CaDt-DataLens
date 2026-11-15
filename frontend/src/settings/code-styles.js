// code-styles.js：代码风格（语法 token 配色）的单一来源，与软件主题解耦。
//
// 背景：原先 settings.theme → html[data-theme] 一个开关同时决定界面配色与代码高亮，
// 而 themes 列表里 Darcula / IDEA Dark / IDEA Light / Github 本质是代码配色方案，
// 和 Newsprint / Pixyll / Harness 这些界面风格混在一起。现在拆成两条独立通道：
//   - 软件主题：settings.theme → data-theme → UI 变量（含编辑器框架色 --ace-*、图表色）
//   - 代码风格：settings.codeStyle → data-code-style → 下面这组 token 变量
// 具体色值仍只在 style.css 里维护，这里只放列表与映射，不维护第二份 JS 色板。
//
// 兼容约定：codeStyle='auto'（默认）时不写 data-code-style 属性，CSS 里没有匹配块，
// 于是 token 变量回落到软件主题块的既有定义 —— 老用户升级后观感零变化。
// 显式选择时 html[data-theme][data-code-style="X"] 覆盖 token 变量（特异性更高）。

export const CODE_STYLE_AUTO = 'auto';

// token 变量清单：代码风格块必须逐套定义齐全（护栏测试按此断言）。
// --val-* 不在此列：它同时给 UI（文件图标 / 结构面板 / 运行输出）着色，归软件主题；
// 代码高亮改用 --code-val-*，并写 var(--code-val-x, var(--val-x)) 回退到主题的取值色。
export const CODE_TOKEN_VARS = [
    '--syn-keyword', '--syn-operator', '--syn-comment', '--syn-tag', '--syn-attr',
    '--syn-attr-value', '--syn-yaml-key', '--syn-json-key', '--syn-function', '--syn-heading',
    '--py-builtin', '--py-doc', '--py-self',
    '--code-val-key', '--code-val-string', '--code-val-number', '--code-val-bool', '--code-val-null',
];

// 从现有主题里抽出的 7 套配色（零新增色值）：
// dark/idea-dark 与 light/idea-light 的 token 表本来完全相同，合并为 JetBrains 深/浅两套；
// github / night / newsprint 原先缺 --syn-* / --py-*（继承 :root 深色值），
// 这里补上同明暗档的 JetBrains token，取值色仍用各主题自己的 --val-*。
export const CODE_STYLES = [
    {id: 'jetbrains-dark', name: 'JetBrains 深色', group: 'dark', from: 'dark / idea-dark'},
    {id: 'darcula', name: 'Darcula', group: 'dark', from: 'darcula'},
    {id: 'tokyo-night', name: 'Tokyo Night', group: 'dark', from: 'night'},
    {id: 'jetbrains-light', name: 'JetBrains 浅色', group: 'light', from: 'light / idea-light'},
    {id: 'github-light', name: 'GitHub Light', group: 'light', from: 'github'},
    {id: 'shiki', name: 'Shiki（DeepSeek）', group: 'light', from: 'harness'},
    {id: 'newsprint', name: 'Newsprint 暖纸', group: 'light', from: 'newsprint'},
];

// auto 时软件主题实际对应的代码风格。仅用于界面展示（「跟随软件主题（当前：X）」）与
// 测试；CSS 的 auto 回退不依赖这张表，它靠「不写 data-code-style」自然落回主题块。
export const THEME_CODE_STYLE = {
    dark: 'jetbrains-dark',
    light: 'jetbrains-light',
    darcula: 'darcula',
    'idea-dark': 'jetbrains-dark',
    'idea-light': 'jetbrains-light',
    github: 'github-light',
    newsprint: 'newsprint',
    night: 'tokyo-night',
    pixyll: 'jetbrains-light',
    whitey: 'github-light',
    harness: 'shiki',
};

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
