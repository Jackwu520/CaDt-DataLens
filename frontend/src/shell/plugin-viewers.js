// plugin-viewers.js：插件自定义视图（cadt.registerViewer）注册表——纯逻辑、无 DOM，可单测。
//
// 视图只渲染不改数据：mount 拿到的 container 是空的 div，写回一律经 ctx.requestSave 上抛给
// 编辑器（走既有脏标记与只读判定）。约束与生命周期口径见
// docs/unfinished-plans/plugin-extension-roadmap.md 2.2 节。
//
// 模式串约定：doc.mode = 'plugin:<viewerId>'。
// 刻意复用 doc.mode 这一个字段（不给 doc 加第二套视图状态），因为视图下拉、标签页视图按钮、
// 会话恢复都只认 doc.mode —— 新增一套状态就会出现「切过去但按钮不亮」这类错位。

export const PLUGIN_VIEW_MODE_PREFIX = 'plugin:';

// 上限：注册期严格拒绝（插件作者立刻看到错误），执行期不静默丢弃。
export const MAX_VIEWERS_TOTAL = 30;
export const MAX_VIEWERS_PER_PLUGIN = 10;
export const MAX_VIEW_LABEL = 40;
export const MAX_VIEW_FORMATS = 32;
export const MAX_VIEW_TOKEN = 32;
// 大文件只读档不挂插件视图：与 app_core.go 的 largeFileBytes（10 MB）同一口径。
export const MAX_VIEW_DOC_BYTES = 10 * 1024 * 1024;
export const DEFAULT_VIEW_PRIORITY = 0;
const PRIORITY_LIMIT = 1000;

const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @type {Map<string, object>} viewerId → 归一化记录 */
const viewers = new Map();

function bad(message) {
    throw new Error('[registerViewer] ' + message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// 归属 token 归一：格式 id 与小写扩展名共用一套写法（去点、去空白、小写）。
export function normalizeViewToken(token) {
    return String(token == null ? '' : token).trim().replace(/^\./, '').toLowerCase();
}

export function pluginViewMode(viewerId) {
    return PLUGIN_VIEW_MODE_PREFIX + String(viewerId || '');
}

export function isPluginViewMode(mode) {
    return typeof mode === 'string' && mode.startsWith(PLUGIN_VIEW_MODE_PREFIX) && mode.length > PLUGIN_VIEW_MODE_PREFIX.length;
}

export function viewerIdFromMode(mode) {
    return isPluginViewMode(mode) ? mode.slice(PLUGIN_VIEW_MODE_PREFIX.length) : '';
}

function docExt(doc) {
    const name = String((doc && (doc.name || doc.path)) || '');
    const base = name.replace(/\\/g, '/').split('/').pop();
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function normalizePluginViewer(pluginId, pluginName, spec) {
    const owner = String(pluginId || '').trim();
    if (!ID_RULE.test(owner)) bad(`插件 id 无效：${JSON.stringify(pluginId)}`);
    if (!isPlainObject(spec)) bad('需要一个视图对象');
    const id = String(spec.id || '').trim();
    if (!ID_RULE.test(id)) bad(`id 无效：${JSON.stringify(spec.id)}`);
    if (typeof spec.mount !== 'function') bad(`视图 ${id} 缺少 mount 函数`);
    const rawFormats = Array.isArray(spec.formats) ? spec.formats : [];
    const formats = [];
    for (const entry of rawFormats) {
        const token = normalizeViewToken(entry);
        if (!token) continue;
        if (token.length > MAX_VIEW_TOKEN) bad(`视图 ${id} 的 formats 项过长：${JSON.stringify(entry)}`);
        if (!formats.includes(token)) formats.push(token);
        if (formats.length > MAX_VIEW_FORMATS) bad(`视图 ${id} 的 formats 超过 ${MAX_VIEW_FORMATS} 项`);
    }
    if (!formats.length) bad(`视图 ${id} 缺少 formats`);
    const rawPriority = Number(spec.priority);
    const priority = Number.isFinite(rawPriority)
        ? Math.max(-PRIORITY_LIMIT, Math.min(PRIORITY_LIMIT, Math.round(rawPriority)))
        : DEFAULT_VIEW_PRIORITY;
    const label = String(spec.label == null ? id : spec.label).trim().slice(0, MAX_VIEW_LABEL) || id;
    return {
        key: owner + ':' + id,
        pluginId: owner,
        pluginName: String(pluginName || owner),
        id,
        mode: pluginViewMode(id),
        label,
        formats,
        priority,
        mount: spec.mount,
    };
}

export function registerPluginViewer(pluginId, pluginName, spec) {
    const record = normalizePluginViewer(pluginId, pluginName, spec);
    if (viewers.has(record.id)) bad(`视图 ${record.id} 已注册`);
    if (viewers.size >= MAX_VIEWERS_TOTAL) bad(`自定义视图总数超过上限 ${MAX_VIEWERS_TOTAL}`);
    let mine = 0;
    for (const v of viewers.values()) {
        if (v.pluginId === record.pluginId) mine += 1;
    }
    if (mine >= MAX_VIEWERS_PER_PLUGIN) bad(`单插件视图数超过上限 ${MAX_VIEWERS_PER_PLUGIN}`);
    viewers.set(record.id, record);
    return record;
}

export function clearPluginViewers() {
    viewers.clear();
}

export function getPluginViewers() {
    return [...viewers.values()];
}

export function getPluginViewer(viewerId) {
    return viewers.get(String(viewerId || '')) || null;
}

export function getPluginViewerByMode(mode) {
    const id = viewerIdFromMode(mode);
    return id ? getPluginViewer(id) : null;
}

// 一份文档参与匹配的 token 集合：格式 id + 格式自带扩展名 + 文件名扩展名。
// 三个都收是因为插件写 formats:['geojson'] 时，内置格式探测多半把它归到 text，
// 只比格式 id 就永远匹配不上（roadmap 2.2 的 geo-map 例子正是这种情况）。
export function viewMatchTokens(fmt, doc) {
    const tokens = new Set();
    const formatId = normalizeViewToken(fmt && fmt.id);
    if (formatId) tokens.add(formatId);
    if (fmt && Array.isArray(fmt.extensions)) {
        for (const ext of fmt.extensions) {
            const token = normalizeViewToken(ext);
            if (token) tokens.add(token);
        }
    }
    const ext = docExt(doc);
    if (ext) tokens.add(ext);
    return tokens;
}

export function viewerMatches(viewer, fmt, doc) {
    if (!viewer) return false;
    const tokens = viewMatchTokens(fmt, doc);
    return viewer.formats.some((token) => tokens.has(token));
}

// 当前文档能否挂这个视图：返回禁止原因（'' = 可以）。
// 判定单一来源——编辑器标签页按钮、底栏视图菜单、写回链路都问这里，免得三处口径漂移。
export function pluginViewUnavailable(doc, mode) {
    const viewer = getPluginViewerByMode(mode);
    if (!viewer) return '该插件视图未注册（插件已禁用或卸载）';
    return pluginViewerBlockedReason(viewer, doc);
}

export function pluginViewerBlockedReason(viewer, doc) {
    if (!doc) return '未打开文件';
    if (doc.binary || (doc.format && doc.format.id === 'bytes')) return '二进制文件不支持插件视图';
    if (doc.large) return '大文件不支持插件视图';
    if (Number(doc.size || 0) > MAX_VIEW_DOC_BYTES) return '超过 10 MB，不支持插件视图';
    if (viewer && !viewerMatches(viewer, doc.format, doc)) return '该视图不适用于当前文件';
    return '';
}

function sortViewers(list) {
    return list.slice().sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.label !== b.label) return a.label < b.label ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// 归当前格式（或扩展名）的插件视图，按 priority 降序（视图下拉与标签页按钮的排序单一来源）。
export function viewersFor(fmt, doc) {
    const hit = [];
    for (const viewer of viewers.values()) {
        if (viewerMatches(viewer, fmt, doc)) hit.push(viewer);
    }
    return sortViewers(hit);
}

// 视图下拉用的 [mode, label] 对，形状与 writing-ui 的 viewOptionsFor 一致。
export function pluginViewOptions(fmt, doc) {
    return viewersFor(fmt, doc).map((viewer) => [viewer.mode, viewer.label]);
}

export function pluginViewLabel(mode) {
    const viewer = getPluginViewerByMode(mode);
    return viewer ? viewer.label : '插件视图';
}
