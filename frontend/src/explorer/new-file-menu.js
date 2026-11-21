// new-file-menu.js：资源管理器「新建」子菜单的条目注册表、配置归一化与合成（纯函数）。
//
// 背景（docs/finished-plans/feature-evaluations-2026-11-18.md §1）：
// 菜单运行时 contextmenu.js 只认数据、条目没有稳定 id；这里把 id 化与配置合成收成单一来源。
// 配置进 settings.newFileMenu，沿用 datalens-settings 的 localStorage 通道，缺省零迁移。
//
// 语义约定：
//   - order 是一级条目的**显式顺序**（含 file.dialog / scratch / dir.dialog 三个结构项）。
//   - 内置类型/id 若不在 order 里 → 收进「更多」二级（默认 15 项就是这样），不是被隐藏。
//   - hidden 才是「不出现」；未知 id 一律丢弃，不 throw。
//   - 自定义模板在 order 里就是一级，不在就进「更多」；新建时 UI 会把它追加进 order。

import {fileIconSpec} from '../core/fileicons.js';

export const CUSTOM_LABEL_LIMIT = 40;
export const CUSTOM_NAME_LIMIT = 80;
export const CUSTOM_CONTENT_LIMIT = 4096;
export const MAX_CUSTOM = 30;

export const SPECIAL_IDS = ['file.dialog', 'scratch', 'dir.dialog'];
export const SPECIAL_LABELS = {
    'file.dialog': '文件…',
    'scratch': '临时文件',
    'dir.dialog': '目录…',
};

// 内置文件类型单一来源。group 只决定「缺省落在哪」：top 一级 / more 「更多」二级。
export const BUILTIN_FILE_TYPES = [
    {id: 'type.md', label: 'Markdown 文件', name: '新建文件.md', group: 'top'},
    {id: 'type.txt', label: '文本文件', name: '新建文件.txt', group: 'top'},
    {id: 'type.py', label: 'Python 文件', name: '新建文件.py', group: 'top'},
    {id: 'type.js', label: 'JavaScript 文件', name: '新建文件.js', group: 'top'},
    {id: 'type.json', label: 'JSON 文件', name: '新建文件.json', group: 'top'},
    {id: 'type.go', label: 'Go 文件', name: '新建文件.go', group: 'top'},
    {id: 'type.java', label: 'Java 文件', name: '新建文件.java', group: 'top'},
    {id: 'type.csv', label: 'CSV 文件', name: '新建文件.csv', group: 'top'},
    {id: 'type.cpp', label: 'C++ 文件', name: '新建文件.cpp', group: 'top'},
    {id: 'type.vue', label: 'Vue 文件', name: '新建文件.vue', group: 'top'},
    {id: 'type.ts', label: 'TypeScript 文件', name: '新建文件.ts', group: 'more'},
    {id: 'type.html', label: 'HTML 文件', name: '新建文件.html', group: 'more'},
    {id: 'type.css', label: 'CSS 文件', name: '新建文件.css', group: 'more'},
    {id: 'type.sql', label: 'SQL 文件', name: '新建文件.sql', group: 'more'},
    {id: 'type.sh', label: 'Shell 脚本', name: '新建文件.sh', group: 'more'},
    {id: 'type.ps1', label: 'PowerShell 脚本', name: '新建文件.ps1', group: 'more'},
    {id: 'type.bat', label: '批处理文件', name: '新建文件.bat', group: 'more'},
    {id: 'type.kt', label: 'Kotlin 文件', name: '新建文件.kt', group: 'more'},
    {id: 'type.lua', label: 'Lua 脚本', name: '新建文件.lua', group: 'more'},
    {id: 'type.yaml', label: 'YAML 文件', name: '新建文件.yaml', group: 'more'},
    {id: 'type.xml', label: 'XML 文件', name: '新建文件.xml', group: 'more'},
    {id: 'type.toml', label: 'TOML 文件', name: '新建文件.toml', group: 'more'},
    {id: 'type.jsonl', label: 'JSONL 文件', name: '新建文件.jsonl', group: 'more'},
    {id: 'type.ini', label: 'INI 文件', name: '新建文件.ini', group: 'more'},
    {id: 'type.properties', label: 'Properties 文件', name: '新建文件.properties', group: 'more'},
];

export const DEFAULT_ORDER = [...SPECIAL_IDS, ...BUILTIN_FILE_TYPES.filter((t) => t.group === 'top').map((t) => t.id)];

export function defaultNewFileMenu() {
    return {order: [...DEFAULT_ORDER], hidden: [], custom: []};
}

function clampText(value, limit) {
    return String(value == null ? '' : value).normalize('NFC').trim().slice(0, limit);
}

// validateCustomTemplate：设置页「添加模板」的输入校验（单一来源，UI 与归一化共用）。
// 返回 {ok, error, value}，value 是已净化的 {label, name, content}。
export function validateCustomTemplate(raw) {
    const label = clampText(raw && raw.label, CUSTOM_LABEL_LIMIT);
    if (!label) return {ok: false, error: '请填写显示名称', value: null};
    let name = clampText(raw && raw.name, CUSTOM_NAME_LIMIT).replace(/[\\/:*?"<>|]/g, '');
    if (!name) return {ok: false, error: '请填写文件名', value: null};
    if (!name.includes('.')) return {ok: false, error: '文件名需要带扩展名（如 .vue）', value: null};
    if (/\.$/.test(name)) return {ok: false, error: '扩展名不能为空', value: null};
    const content = String(raw && raw.content != null ? raw.content : '').slice(0, CUSTOM_CONTENT_LIMIT);
    return {ok: true, error: '', value: {label, name, content}};
}

function normalizeCustom(raw) {
    if (!Array.isArray(raw)) return [];
    const used = new Set();
    const out = [];
    for (const item of raw.slice(0, MAX_CUSTOM)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const checked = validateCustomTemplate(item);
        if (!checked.ok) continue;
        let id = String(item.id || '');
        if (!/^c[A-Za-z0-9_-]{1,32}$/.test(id) || used.has(id)) {
            let n = out.length + 1;
            while (used.has('c' + n)) n += 1;
            id = 'c' + n;
        }
        used.add(id);
        out.push({id, ...checked.value});
    }
    return out;
}

// normalizeNewFileMenu：损坏配置回退默认，绝不 throw。未知 id 与重复 id 直接丢弃。
export function normalizeNewFileMenu(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultNewFileMenu();
    const custom = normalizeCustom(raw.custom);
    const known = new Set([...SPECIAL_IDS, ...BUILTIN_FILE_TYPES.map((t) => t.id), ...custom.map((c) => c.id)]);
    const hidden = Array.isArray(raw.hidden)
        ? [...new Set(raw.hidden.filter((id) => typeof id === 'string' && known.has(id)))]
        : [];
    const order = [];
    if (Array.isArray(raw.order)) {
        for (const id of raw.order) {
            if (typeof id !== 'string' || !known.has(id) || order.includes(id)) continue;
            order.push(id);
        }
    }
    // 结构项与自定义项即便不在 order 里也要有落点（否则用户再也找不到它）；
    // 内置类型不在 order 里是有意义的 —— 表示收进「更多」。
    // 反序遍历 + unshift，保证三个结构项即便全缺失也按 file.dialog / scratch / dir.dialog 归位
    for (const id of [...SPECIAL_IDS].reverse()) {
        if (!hidden.includes(id) && !order.includes(id)) order.unshift(id);
    }
    for (const item of custom) {
        if (!hidden.includes(item.id) && !order.includes(item.id)) order.push(item.id);
    }
    return {order, hidden, custom};
}

// resolveNewFileMenu：配置 → 一级 / 「更多」二级条目。两组共用同一份注册表。
export function resolveNewFileMenu(raw) {
    const config = normalizeNewFileMenu(raw);
    const hidden = new Set(config.hidden);
    const ordered = new Set(config.order);
    const byId = new Map();
    for (const type of [...BUILTIN_FILE_TYPES, ...config.custom]) byId.set(type.id, type);

    const typeEntry = (type) => ({
        id: type.id, kind: 'type', label: type.label, name: type.name, content: type.content || '',
    });
    const top = [];
    for (const id of config.order) {
        if (hidden.has(id)) continue;
        if (SPECIAL_IDS.includes(id)) {
            top.push({id, kind: 'special', label: SPECIAL_LABELS[id]});
            continue;
        }
        const type = byId.get(id);
        if (type) top.push(typeEntry(type));
    }
    const more = [];
    for (const type of [...BUILTIN_FILE_TYPES, ...config.custom]) {
        if (hidden.has(type.id) || ordered.has(type.id)) continue;
        more.push(typeEntry(type));
    }
    return {top, more, config};
}

// 以下四个函数供设置页使用：全部「输入旧配置 → 输出新配置」，不修改入参。

export function setMenuItemHidden(config, id, hidden) {
    const next = normalizeNewFileMenu(config);
    const wanted = !!hidden;
    next.hidden = wanted
        ? [...new Set([...next.hidden, id])]
        : next.hidden.filter((item) => item !== id);
    return next;
}

// moveMenuItem：上移/下移。原本在「更多」二级的条目第一次移动会先提升进 order。
export function moveMenuItem(config, id, delta) {
    const next = normalizeNewFileMenu(config);
    const index = next.order.indexOf(id);
    if (index < 0) return next;
    const target = index + (delta < 0 ? -1 : 1);
    if (target < 0 || target >= next.order.length) return next;
    [next.order[index], next.order[target]] = [next.order[target], next.order[index]];
    return next;
}

export function promoteMenuItem(config, id) {
    const next = normalizeNewFileMenu(config);
    const index = next.order.indexOf(id);
    if (index >= 0) return next;
    next.order.push(id);
    return next;
}

// reorderMenuItem：拖拽排序（对齐排队消息 reorderQueueItem 的语义）。
// 把 draggedId 挪到 targetId 之前 / 之后。拖动项若在「更多」二级（不在 order），
// 这一步会顺带把它提升进一级；目标在「更多」时落到 order 末尾，即插在一级与二级之间。
export function reorderMenuItem(config, draggedId, targetId, after) {
    const next = normalizeNewFileMenu(config);
    if (!draggedId || !targetId || draggedId === targetId) return next;
    const known = new Set([...SPECIAL_IDS, ...BUILTIN_FILE_TYPES.map((t) => t.id), ...next.custom.map((c) => c.id)]);
    if (!known.has(draggedId) || !known.has(targetId)) return next;
    const order = next.order.filter((id) => id !== draggedId);
    let to = order.indexOf(targetId);
    if (to < 0) {
        order.push(draggedId);
    } else {
        if (after) to += 1;
        order.splice(to, 0, draggedId);
    }
    return {...next, order};
}

export function upsertCustomTemplate(config, template, id) {
    const next = normalizeNewFileMenu(config);
    const checked = validateCustomTemplate(template);
    if (!checked.ok) return {ok: false, error: checked.error, config: next};
    if (next.custom.length >= MAX_CUSTOM && !id) {
        return {ok: false, error: '自定义模板最多 ' + MAX_CUSTOM + ' 个', config: next};
    }
    const existing = id ? next.custom.find((item) => item.id === id) : null;
    if (id && !existing) return {ok: false, error: '模板不存在', config: next};
    if (existing) {
        Object.assign(existing, checked.value);
    } else {
        let nextId = 'c1';
        let n = 1;
        while (next.custom.some((item) => item.id === nextId)) {
            n += 1;
            nextId = 'c' + n;
        }
        next.custom.push({id: nextId, ...checked.value});
        next.order.push(nextId); // 新模板默认出现在「新建」一级，不埋进「更多」
    }
    return {ok: true, error: '', config: normalizeNewFileMenu(next)};
}

export function removeCustomTemplate(config, id) {
    const next = normalizeNewFileMenu(config);
    next.custom = next.custom.filter((item) => item.id !== id);
    next.order = next.order.filter((item) => item !== id);
    next.hidden = next.hidden.filter((item) => item !== id);
    return next;
}

// fileTypeMenuItem：通用菜单项构造（iconHtml/iconClass 走 fileIconSpec，与既有外观一致）。
// action 收到的是完整 entry（含 name / content），调用方据此决定建空文件还是写模板。
export function fileTypeMenuItem(type, action) {
    const spec = fileIconSpec(type.name);
    const dot = type.name.lastIndexOf('.');
    return {
        label: type.label,
        shortcut: dot >= 0 ? type.name.slice(dot) : '',
        // iconHtml-exception: 文件类型图标走 fileIconSpec 域（core/fileicons*.js），非通用注册表语义
        iconHtml: spec.svg,
        iconClass: spec.className,
        action: () => action(type),
    };
}
