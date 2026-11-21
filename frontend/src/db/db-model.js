// db-model.js：数据库连接页的纯函数——行键编解码、筛选算子、状态文案、修改摘要。
// 无 DOM、无依赖（core 层纯函数模块），测试在 frontend/test/db/db-model.test.mjs。

/** 会话类型的展示名（插件 kind 由 db-plugin.js 按注册表解析，不走这里）。 */
export function kindLabel(kind) {
    switch (kind) {
        case 'sqlite': return 'SQLite';
        case 'mysql': return 'MySQL';
        case 'mariadb': return 'MariaDB';
        default: return kind || '';
    }
}

/** 行主键编解码：PK 值用 \x1f 连接（值里不可能出现单元分隔符的可靠分隔）。 */
export function encodeRowKey(pkValues) {
    return (pkValues || []).map((v) => (v == null ? '' : String(v))).join('\x1f');
}

export function decodeRowKey(key) {
    return String(key || '').split('\x1f');
}

/** 从一行数据提取主键值（按 meta.PK 列名对位）。 */
export function rowKeyOf(meta, row, columns) {
    const pkValues = [];
    for (const name of meta.pk || []) {
        const idx = columns.indexOf(name);
        pkValues.push(idx >= 0 ? row[idx] : '');
    }
    return encodeRowKey(pkValues);
}

/** 从一行数据提取主键定位 map（列名 → 原值）。 */
export function rowKeysMap(meta, row, columns) {
    const map = {};
    for (const name of meta.pk || []) {
        const idx = columns.indexOf(name);
        map[name] = idx >= 0 ? row[idx] : '';
    }
    return map;
}

/** 筛选算子（UI 选项与语义说明）。 */
export const FILTER_OPS = [
    {value: 'contains', label: '包含'},
    {value: 'eq', label: '='},
    {value: 'ne', label: '≠'},
    {value: 'gt', label: '>'},
    {value: 'ge', label: '≥'},
    {value: 'lt', label: '<'},
    {value: 'le', label: '≤'},
    {value: 'null', label: '为 NULL'},
    {value: 'notNull', label: '非 NULL'},
];

export function filterOpNeedsValue(op) {
    return op !== 'null' && op !== 'notNull';
}

/** 耗时文案：<1s 显示毫秒，否则显示秒。 */
export function formatElapsed(ms) {
    const n = Number(ms) || 0;
    if (n < 1000) return n + ' ms';
    return (n / 1000).toFixed(2) + ' s';
}

/** 行估算文案（information_schema 的估计值，以「约」开头；0 表示未知不显示）。 */
export function rowEstimateLabel(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v >= 1000000) return '约 ' + (v / 1000000).toFixed(1) + 'M 行';
    if (v >= 1000) return '约 ' + (v / 1000).toFixed(1) + 'K 行';
    return '约 ' + v + ' 行';
}

/** 待提交修改摘要：{updates, deletes, inserts} → 「3 处修改 · 1 行待删 · 2 行待插」。 */
export function dirtySummary(dirty) {
    if (!dirty) return '';
    const parts = [];
    if (dirty.updates && dirty.updates.size) parts.push(dirty.updates.size + ' 处修改');
    if (dirty.deletes && dirty.deletes.size) parts.push(dirty.deletes.size + ' 行待删');
    if (dirty.inserts && dirty.inserts.length) parts.push(dirty.inserts.length + ' 行待插');
    return parts.join(' · ');
}

/** 表是否可编辑：有主键、非视图、会话允许编辑，且全局只读锁未开。
 *（Go 侧 meta.editable 是权威判定；这里把主键/视图再查一遍，UI 层双保险。） */
export function tableEditable(meta, sessionEditable, globalReadonly) {
    return !!(meta && meta.editable && sessionEditable && !globalReadonly &&
        meta.kind !== 'view' && (meta.pk || []).length);
}

/** 确认原因 → 提示文案（与 Go guard.go 的 confirmDanger / confirmMissingWhere 对应）。 */
export function confirmReasonLabel(reason) {
    if (reason === 'danger') return '危险操作';
    if (reason === 'missingWhere') return '缺 WHERE（全表生效）';
    return reason || '';
}
