# 图标规范（Icon Guidelines）

> 适用范围：`frontend/` 下所有界面代码（HTML / JS / CSS），含菜单、工具栏、状态栏、
> 标签页、面板、对话框、弹出层等一切 UI。插件如需展示图标也应遵循本规范。

## 核心规则

1. **UI 图标一律使用内联 SVG，禁止用文字字符充当图标。**
   历史教训：终端面板曾用全角 `＋`、`▾`、`✕` 当按钮图标——它们来自 UI 正文字体，
   字号、基线、粗细互不一致，跨主题/跨字体时还会变形。
2. 同样禁止的还有：emoji（⭐ ❌ 🔔 等）与图标字体（Segoe MDL2 Assets 等）。
   图标字体本质仍是字符码位，且 Segoe MDL2 已被微软弃用，可用性无保障。
3. 图标必须从 `frontend/src/core/icons.js` 的注册表取用，不在业务代码里零散手写 SVG 路径
   （唯一的例外：静态 HTML 中直接内联 `<svg>`，但视觉参数必须与注册表一致）。
4. **禁止影子注册表 / 局部图标表**（2026-11-22 图标收编后定）：业务模块不得自建
   `icons` 对象、`icon()` 工厂或成组内联 `<svg>` 字面量——同语义复用同一份 SVG 是默认路径。
   合理例外域只有：文件类型 `core/fileicons*.js`、品牌 `ai/ai-provider-icons.js`、
   AI 可视化引擎 `core/widget.js` / `core/*-render.js`（产物是图表 SVG，非 UI 图标）。
5. **`iconHtml` 只允许 `iconSvg()` 来源**；其他来源必须带 `// iconHtml-exception:` 原因注释
   （现有永久例外：`shell/app-actions.js`、`explorer/new-file-menu.js` 走 fileIconSpec
   文件类型域）。

## 统一视觉参数

| 参数 | 值 |
|---|---|
| viewBox | `0 0 16 16`（路径一律按 16 网格绘制，留 2px 边距） |
| 描边 | `fill="none" stroke="currentColor" stroke-width="1.4"` |
| 端点/拐角 | `stroke-linecap="round" stroke-linejoin="round"` |
| 颜色 | 跟随文字 `currentColor`，hover 变化由外层类控制 |
| 尺寸 | 常用 10 / 11 / 12 / 14 px，由 CSS 或调用方指定 |
| 实心例外 | 语义需要实心的（如 star），在注册表内单独覆盖 `fill="currentColor" stroke="none"` |

## 取用方式

```js
import {iconSvg, renderMenuIcon, resolveIconName} from '../core/icons.js';

// 1) JS 动态创建的图标：拿 <svg> 字符串塞进 innerHTML
el.innerHTML = iconSvg('close', 12);

// 2) 菜单项图标（勾选 ✓ > 主题色板 swatch > iconHtml > 命名图标 的优先级）
//    contextmenu.js 与主菜单 renderDropdown 都经由它渲染
renderMenuIcon(iconSpan, item);          // item.icon 传命名图标，如 'eraser'
```

静态 HTML 直接内联（参考 `index.html` 的 `wc-close`、`find-icon`）：

```html
<button class="dialog-close"><svg viewBox="0 0 16 16" width="10" height="10"
    fill="none" stroke="currentColor" stroke-width="1.4"
    stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
```

## 新增图标流程

1. 先查 `core/icons.js` 的 `ICONS` 注册表，避免重复；
2. 没有就登记一个语义化 kebab-case 键名（如 `diff`、`open-folder`）并按上表参数画路径；
3. 业务代码一律用命名图标。`LEGACY_ICONS`（旧 Segoe MDL2 码位 → 命名图标的映射）
   仅为外部插件菜单数据的兼容保留（本仓 src 已零码位），**新代码禁止使用码位**；
4. 同一个键在不同语境下如果需要两种造型（如 删除=垃圾桶 / 清屏=橡皮），
   登记两个键，不要复用一个码位。

## 护栏（规范靠机制不靠自觉）

`frontend/test/core/icon-guard.test.mjs`（已登记 `npm test`）扫 `src/**.js` 四条规则：

1. 业务代码禁止内联 `<svg>` 字面量——例外域直接豁免，其余存量进按文件计数基线，
   **只减不增**（仿 `form-controls-factory` 基线；`PRINT_ICON_BASELINE=1` 可重印快照）；
2. 菜单数据禁止遗留 MDL2 码位（`icon: 'E8C8'` 一类），基线已清零；
3. `iconHtml` 只允许 `iconSvg()` 来源，其他来源须带 `// iconHtml-exception:` 注释；
4. 注册表自身：图形不得含硬编码颜色（一律 `currentColor`）、不得嵌套 `<svg>`。

新增图标想让护栏保持绿：**先登记注册表、再用 `iconSvg()`**，不是加基线豁免。

## 例外（不算图标，允许保留）

- **文案中的省略号 `…`**：表示点击后弹对话框的菜单/按钮文案惯例（如"导出…"）；
- **分隔符与占位符**：`·`（关于页分隔）、`—`（空值占位）、`，`（中文文本）；
- **提示/标题里的符号说明**：如 tooltip 里描述快捷键的 `↑ / ↓`、图片尺寸的 `1920 × 1080`；
- **文件树的"文字缩写"图标主题（mono）**：属于文件内容标识而非 UI 图标，由
  `fileicons.js` 主题体系管理；
- **状态圆点**（未保存标记）：用纯 CSS `border-radius: 50%` 实现，不引字符。

## 检查清单（提交前自检）

- [ ] `npm test` 的 `icon-guard` 四条规则通过（内联 svg / 码位 / iconHtml 来源 / 注册表着色）；
- [ ] 全局搜索 `Segoe MDL2`、`&#xE`、`String.fromCharCode(0xE` 应无结果；
- [ ] 全局搜索 `＋ ▾ ▸ ✕ ★ ✓ ○ ● ▶ ◀` 等字符只应出现在注释/文案/本规范里；
- [ ] 新图标已在 `core/icons.js` 登记，且遵循统一视觉参数；
- [ ] 图标在暗色/亮色主题下均通过 `currentColor` 着色，无硬编码颜色
      （`market-stars` 的金星等品牌色除外）。
