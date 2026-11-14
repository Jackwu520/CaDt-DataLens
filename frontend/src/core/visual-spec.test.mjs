// visual-spec.js 的纯逻辑测试：SHADOW_STYLE 生成、预算值、主题色兜底、mermaid 主题映射。
// resolveThemeColors 依赖 DOM 的分支在 node --test 里走不到（无 document），正好覆盖兜底路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SHADOW_STYLE,
    VISUAL_BUDGET,
    VISUAL_ROUTING,
    VISUAL_RULES,
    VISUAL_TOKENS,
    mermaidThemeIdFor,
    resolveThemeColors,
} from './visual-spec.js';

test('SHADOW_STYLE 与历史字符串逐字节一致（阶段 1 纯重构红线）', () => {
    assert.equal(SHADOW_STYLE, [
        ':host{display:block;color:var(--text,#1f2328);',
        'font:13px/1.6 var(--ui-font,system-ui,"Segoe UI",sans-serif);',
        '--color-text-primary:var(--text,#1f2328);',
        '--color-text-secondary:var(--muted,#6b7280);',
        '--color-background-primary:var(--panel2,#fff);',
        '--color-background-secondary:var(--panel,#f4f6f8);',
        '--color-background-tertiary:var(--bg,#eef1f5);',
        '--color-border-tertiary:var(--border,rgba(0,0,0,.14));',
        '--color-border-secondary:var(--border,rgba(0,0,0,.24));',
        '--color-accent:var(--accent,#4f8cff);}',
        '*,*::before,*::after{box-sizing:border-box}',
        'img,svg,canvas{max-width:100%}',
        'svg{height:auto;max-height:520px}',
        'table{border-collapse:collapse}',
        'a{color:var(--accent,#4f8cff)}',
    ].join(''));
});

test('VISUAL_BUDGET 数值与历史限额一致', () => {
    assert.equal(VISUAL_BUDGET.maxWidgetChars, 200 * 1024);
    assert.equal(VISUAL_BUDGET.maxPerMessage, 8);
    assert.equal(VISUAL_BUDGET.maxPerMessageRecommended, 3);
    assert.equal(VISUAL_BUDGET.maxCssChars, 24 * 1024);
    assert.equal(VISUAL_BUDGET.svgMaxHeight, 520);
    assert.equal(VISUAL_BUDGET.svgViewBoxWidth, 680);
    assert.equal(VISUAL_BUDGET.minFontSize, 11);
    assert.equal(VISUAL_BUDGET.maxColumns, 2);
});

test('resolveThemeColors 无 DOM 时返回兜底色且不抛错', () => {
    const colors = resolveThemeColors();
    assert.equal(colors.text, '#1f2328');
    assert.equal(colors.accent, '#4f8cff');
    assert.equal(colors.border, 'rgba(0,0,0,.24)');
    for (const slot of VISUAL_TOKENS.colorSlots) {
        assert.ok(colors[slot[0]], '每个语义槽位必须有值：' + slot[0]);
    }
});

test('mermaidThemeIdFor 深色主题族落到 dark（night 背景是深色）', () => {
    assert.equal(mermaidThemeIdFor('dark'), 'dark');
    assert.equal(mermaidThemeIdFor('darcula'), 'dark');
    assert.equal(mermaidThemeIdFor('night'), 'dark');
    assert.equal(mermaidThemeIdFor('light'), 'neutral');
    assert.equal(mermaidThemeIdFor(''), 'neutral');
    assert.equal(mermaidThemeIdFor(null), 'neutral');
});

test('VISUAL_RULES.inlineVisual 保留规范正文锚点', () => {
    const text = VISUAL_RULES.inlineVisual;
    assert.ok(text.startsWith('# 内联可视化（inline-visual）'));
    assert.ok(text.includes('no-widget'));
    assert.ok(text.includes('var(--text,#1f2328)'));
    assert.ok(text.includes('单条上限 8 张，单块上限 200 KB'));
    assert.ok(text.includes('prefers-color-scheme'));
});

test('VISUAL_RULES.inlineVisual 含 mermaid 速查与 echarts 模板（阶段 3）', () => {
    const text = VISUAL_RULES.inlineVisual;
    assert.ok(text.includes('## 10. mermaid 声明式图速查'));
    assert.ok(text.includes('xychart-beta'));
    assert.ok(text.includes('sankey-beta'));
    assert.ok(text.includes('## 11. echarts 声明式图表'));
    assert.ok(text.includes('禁止 formatter / rich 字段'));
    assert.ok(text.includes('/ mermaid / echarts；写成其它语言'));
});

test('VISUAL_ROUTING 覆盖画图决策的主出口', () => {
    assert.ok(Array.isArray(VISUAL_ROUTING) && VISUAL_ROUTING.length >= 8);
    for (const row of VISUAL_ROUTING) {
        assert.equal(row.length, 2);
        assert.ok(row[0] && row[1]);
    }
});
