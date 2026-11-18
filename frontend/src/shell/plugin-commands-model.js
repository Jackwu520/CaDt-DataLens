// plugin-commands-model.js：插件命令（cadt.addCommand）的纯逻辑——声明归一化、入口上下文、
// when 条件求值、快捷键校验。无 DOM 依赖，可单测。
//
// 设计边界：本模块只做「把插件给的声明变成可信的命令记录」与「判断该命令在某个入口是否
// 出现 / 可用」。真正的菜单渲染、命令面板、快捷键分发都在宿主（main.js / editor-menus.js）
// 里，宿主只消费本模块的判定结果。

import {comboSpecFromText} from '../core/keymap.js';

// 命令可出现的入口。palette（命令面板）对全部插件命令开放，不在此清单里——
// 它是所有命令的兜底入口，不需要插件声明。
export const COMMAND_CONTEXTS = ['tools', 'editorContext'];

// 命令面板分组。plugin 是插件命令的默认分组，其余复用宿主既有分组名。
export const COMMAND_CATEGORIES = ['file', 'edit', 'format', 'view', 'tools', 'plugin'];

export const COMMAND_CATEGORY_LABELS = {
    file: '文件', edit: '编辑', format: '格式',
    view: '视图', tools: '工具', plugin: '插件',
};

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LABEL_MAX = 60;
const DESCRIPTION_MAX = 200;
const ICON_MAX = 40;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function clip(value, max) {
    const text = String(value == null ? '' : value).trim();
    return text.length > max ? text.slice(0, max) : text;
}

// 快捷键声明：{key: 'Ctrl+Alt+F', when?: 'editorFocus'}。
// key 用 keymap 的同一套语法校验并归一成组合串，避免插件写 'ctrl+alt+f' 之类匹配不上。
// when 目前只认 'editorFocus'（编辑器有焦点时生效），其余一律当全局键。
export function normalizeCommandShortcut(raw) {
    if (raw == null) return null;
    if (!isPlainObject(raw)) throw new Error('shortcut 需要一个对象：{key, when?}');
    const key = String(raw.key == null ? '' : raw.key).trim();
    if (!key) throw new Error('shortcut 缺少 key');
    const spec = comboSpecFromText(key);
    if (!spec.ok) throw new Error('shortcut.key 无效：' + spec.error);
    const when = raw.when == null ? '' : String(raw.when).trim();
    if (when && when !== 'editorFocus') {
        throw new Error(`shortcut.when 目前只支持 'editorFocus'：${JSON.stringify(raw.when)}`);
    }
    return {combo: spec.combo, label: spec.combo, when};
}

// 归一化一条插件命令声明。校验失败抛错（由 plugins.js 包成插件名前缀的错误）。
// 返回的记录字段全部是可安全消费的，宿主不需要再校验。
export function normalizePluginCommand(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!owner) throw new Error('缺少插件 id');
    if (!isPlainObject(spec)) throw new Error('addCommand 需要一个命令对象');

    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) throw new Error(`命令 id 无效：${JSON.stringify(spec.id)}`);

    const label = clip(spec.label, LABEL_MAX);
    if (!label) throw new Error('命令缺少 label');
    if (typeof spec.run !== 'function') throw new Error('命令缺少 run');

    const contexts = Array.isArray(spec.contexts) && spec.contexts.length
        ? COMMAND_CONTEXTS.filter((c) => spec.contexts.includes(c))
        : ['tools'];
    if (!contexts.length) {
        throw new Error(`contexts 无效：${JSON.stringify(spec.contexts)}（可用 ${COMMAND_CONTEXTS.join(' / ')}）`);
    }

    const category = COMMAND_CATEGORIES.includes(spec.category) ? spec.category : 'plugin';

    if (spec.when != null && typeof spec.when !== 'function') {
        throw new Error('when 必须是函数');
    }

    return {
        // 全局唯一 id：插件内 id 加插件前缀（与既有 getPluginCommands 的约定一致）
        id: `${owner}:${id}`,
        pluginId: owner,
        pluginName: String(pluginName || owner),
        label,
        icon: clip(spec.icon, ICON_MAX),
        description: clip(spec.description, DESCRIPTION_MAX),
        category,
        contexts,
        when: typeof spec.when === 'function' ? spec.when : null,
        shortcut: spec.shortcut == null ? null : normalizeCommandShortcut(spec.shortcut),
        run: spec.run,
    };
}

// 该命令是否属于某个入口。
export function commandAppliesTo(cmd, context) {
    if (!cmd) return false;
    if (context === 'palette') return true; // 命令面板对所有插件命令开放
    return Array.isArray(cmd.contexts) && cmd.contexts.includes(context);
}

// when 条件求值：插件函数抛错一律当「不满足」，绝不让一条坏命令阻断菜单渲染。
export function evalCommandWhen(cmd, env) {
    if (!cmd || typeof cmd.when !== 'function') return true;
    try {
        return !!cmd.when(env || {});
    } catch (e) {
        return false;
    }
}

// 命令面板里的显示前缀（'插件： xxx'）。
export function commandCategoryLabel(cmd) {
    const key = cmd && cmd.category ? cmd.category : 'plugin';
    return COMMAND_CATEGORY_LABELS[key] || COMMAND_CATEGORY_LABELS.plugin;
}

// 在给定组合串下找出应触发的插件命令：同键多命令时先注册的优先（与 keymap 先到先得一致）。
export function matchCommandShortcut(commands, combo, env) {
    const key = String(combo || '');
    if (!key || !Array.isArray(commands)) return null;
    for (const cmd of commands) {
        if (!cmd || !cmd.shortcut || cmd.shortcut.combo !== key) continue;
        if (cmd.shortcut.when === 'editorFocus' && !(env && env.editorFocused)) continue;
        if (!evalCommandWhen(cmd, env)) continue;
        return cmd;
    }
    return null;
}
