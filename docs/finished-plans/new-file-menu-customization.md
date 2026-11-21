# 右键「新建」菜单定制（已完成 2026-11-18）

> 事实底座：`docs/finished-plans/feature-evaluations-2026-11-18.md` §1。
> 范围按评估稿一期执行：只接 explorer 右键「新建」子菜单；explorer 主菜单 / 编辑器右键保持硬编码。

## 结果

「新建」子菜单的全部条目已有稳定 id，出现与顺序由 `settings.newFileMenu` 驱动，配置随
`datalens-settings` 的 localStorage 通道持久化。新增「自定义文件类型模板」（名称 + 文件名 + 初始内容），
子菜单底部加「配置菜单…」直达「菜单管理」独立设置页。

配置形状：

```js
settings.newFileMenu = {
    order: ['file.dialog', 'scratch', 'dir.dialog', 'type.md', /* … */], // 一级条目顺序
    hidden: ['type.java'],                                              // 不出现的内置 id
    custom: [{id: 'c1', label: 'Vue 组件', name: '新建组件.vue', content: '<template>…'}],
};
```

语义（与评估稿一致，另有两条实现约定）：

- 缺省 / 字段缺失 / 配置损坏 → 归一化回当前内置全集与顺序，零迁移、不 throw。
- `hidden` 才表示「不出现」；**不在 `order` 里的内置类型会收进「更多」二级**（默认 15 项就是这样），
  不是隐藏。自定义模板不在 `order` 里同理；新建时 UI 自动把它追加进 `order`，所以默认出现在一级。
- 分组结构项 `file.dialog` / `scratch` / `dir.dialog` 恒有落点；未知 id 直接丢弃。
- `readOnlyMode` 依旧禁用整个「新建」入口，合成层再逐项兜一层，配置绕不过去。
- 模板内容上限 4096 字符，模板数上限 30；不做 `{date}` 之类变量。
- 评估稿建议的「添加」弹窗改为设置页内的内联表单：字段、校验、保存链路完全一致，少一层 modal。
- **拖拽排序已补齐**（原评估稿说「不建议做」、首版也刻意未做，2026-11-18 追加）：与排队消息同一套
  `grip` 手柄 + **让位插槽占位**（`.drop-gap-before/after` 的 margin 过渡，不画描边/插入线），
  保留上下移作为无障碍 / 精确操作。拖动「更多」二级的条目会自动提升进一级。

## 改动文件

| 文件 | 作用 |
|------|------|
| `frontend/src/explorer/new-file-menu.js`（新） | 内置类型注册表 + 配置归一化 + 顺序/显隐/模板合成 + 模板校验 + 菜单项构造，唯一来源 |
| `frontend/src/main.js` | 旧两张表从注册表派生（属性面板「新建文档」菜单行为不变）；settings 默认值与载入归一化；注入 `openSettings` 与设置 pane |
| `frontend/src/explorer/explorer-ops.js` | `newFileMenuItems` 按配置合成；`openCreateEntryDialog` 增加初始内容参数（含撤销/重做回填）；子菜单底部「配置菜单…」；scratch 项按 `deps.createScratchFile` 是否存在自动激活（与临时文件功能解耦） |
| `frontend/src/settings/settings-pane-new-file-menu.js`（新） | 设置 → 菜单管理（独立设置页）：显隐开关、拖拽排序（grip 手柄 + 让位插槽）、上移/下移、模板增删改、恢复默认，控件全走 `core/form-controls.js` |
| `frontend/src/style.css` | `.nfm-row` / `.nfm-drag` / `.drop-gap-before|after`：与排队消息同款的让位插槽样式 |
| `frontend/src/settings/settings-ui.js` | 进「菜单管理」页时重建动态行；供 `openSettings` 直达 |
| `frontend/index.html` | 「功能」分组加独立导航项 `菜单管理` + 独立 pane `data-pane="new-file-menu"`，内含 `#new-file-menu-settings` 容器（原先嵌在通用 pane，2026-11-18 移出） |
| `frontend/test/explorer/new-file-menu.test.mjs`（新） | 纯函数 9 组 + 接线断言 4 组（共 13 例）；已登记 `npm test` 清单 |
| `frontend/package.json` | test 脚本登记新测试文件 |

## 验证

- `node --test test/explorer/new-file-menu.test.mjs`：13/13 通过（含拖拽落点纯函数 + 让位插槽接线断言）。
- `npm test`：全量通过。
- `npm run build`：通过（仅既有 chunk > 500 kB 警告）。

## 后续扩展位

- explorer 主菜单 / 编辑器右键：给条目补 id 后，可复用同一份 `order`/`hidden` 配置形状，不改存储格式。
- 拖拽排序与上移/下移并存：手柄拖动用于快速重排（含让位占位），上下移用于键盘/精确微调；两者写同一份 `order`，无需额外存储。
- 「临时文件」占位项保留在注册表里（`scratch`）；落盘草稿的编排由另一项功能接入，本模块只提供 id 与开关位置。
