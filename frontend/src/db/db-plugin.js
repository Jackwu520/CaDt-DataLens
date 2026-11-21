// db-plugin.js：插件数据库驱动的会话门面——把 `cadt.registerDbDriver` 的插件会话
// 适配成与内置绑定（backend.DB*）相同的形状，让对象树 / 网格 / 控制台零改动复用。
//
// 分派规则（db-tab.js）：entry.kind 以 `plugin:` 开头 → 查注册表取驱动 → driver.connect(config)
// 得插件会话 → 本模块包成 backend 形状；否则走内置绑定（sqlite/mariadb/mysql）。
//
// 密文面：driver.fields 里 type=password 的字段不进工作区清单（localStorage），经
// DBCredentialPut/Get（dpapi，键 dbplug:<条目id>:<字段键>）存取，connect 前合并进 config。
// 所有插件调用包 120s 超时——插件忘做超时也不至于把标签页永远挂在「执行中」。

import {getPluginDbDriverByKind, isPluginDbKind} from '../shell/plugin-db-drivers.js';

export {isPluginDbKind};

const PLUGIN_CALL_TIMEOUT = 120 * 1000;

export function pluginDbDriverOf(kind) {
    return getPluginDbDriverByKind(kind);
}

export function pluginDbLabel(kind) {
    const driver = pluginDbDriverOf(kind);
    return driver ? driver.label : '插件数据库';
}

function credKey(entryId, fieldKey) {
    return 'dbplug:' + entryId + ':' + fieldKey;
}

// 合并密文字段：工作区清单里的 config 不含密文，connect 前从凭据库取回补进
function withTimeout(promise, label) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + '超时（' + (PLUGIN_CALL_TIMEOUT / 1000) + 's）——插件驱动应在 connect/query 里自行设超时')), PLUGIN_CALL_TIMEOUT);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function loadPluginConfig(backend, entry, driver) {
    const config = Object.assign({}, (entry && entry.config) || {});
    for (const field of driver.fields) {
        if (!field.secret) continue;
        try {
            config[field.key] = String(await backend.DBCredentialGet(credKey(entry.id, field.key)) || '');
        } catch (e) {
            config[field.key] = '';
        }
    }
    return config;
}

function normalizeDescribe(meta, table) {
    const m = (meta && typeof meta === 'object') ? meta : {};
    return {
        table: String(m.table || table || ''),
        database: String(m.database || ''),
        kind: m.kind === 'view' ? 'view' : 'table',
        columns: Array.isArray(m.columns) ? m.columns : [],
        pk: Array.isArray(m.pk) ? m.pk : [],
        indexes: Array.isArray(m.indexes) ? m.indexes : [],
        rowEstimate: Number(m.rowEstimate) || 0,
        // 插件会话 v1 只读：网格编辑（dirty model / 事务提交）只对内置 sqlite/mysql 开放
        editable: false,
    };
}

/**
 * 打开插件驱动会话并包成 backend 形状。
 * @returns {Promise<{info: object, api: object}>} info 是 SessionInfo 形状；api 的方法名
 *   与内置绑定一致（DBListDatabases/DBListObjects/DBDescribe/DBBrowse/DBQuery/DBCancel/DBClose），
 *   id 参数被忽略（插件会话在 connect 时已经绑定到具体库）。
 */
export async function openPluginSession(backend, entry, driver) {
    const config = await loadPluginConfig(backend, entry, driver);
    const session = await withTimeout(
        Promise.resolve(driver.connect(config)), '驱动连接');
    if (!session || typeof session !== 'object') {
        throw new Error('驱动 connect 未返回会话对象');
    }
    const info = session.info && typeof session.info === 'object' ? session.info : {};
    const call = (promise, label) => withTimeout(Promise.resolve(promise), label);
    const api = {
        DBListDatabases: () => call(session.listDatabases(), '清单加载'),
        DBListObjects: (_id, db) => call(session.listObjects(db), '清单加载'),
        DBDescribe: (_id, db, table) => call(session.describe(db, table), '表结构加载').then((m) => normalizeDescribe(m, table)),
        DBBrowse: (_id, req) => call(session.browse(req), '数据加载'),
        DBQuery: (_id, queryId, sql, confirmed, limit) => call(
            session.query({queryId, sql, confirmed: !!confirmed, limit: Number(limit) || 500}), '查询'),
        DBCancel: (_id, queryId) => (session.cancel ? call(session.cancel(queryId), '取消') : Promise.resolve()),
        DBClose: () => (session.close ? call(session.close(), '断开') : Promise.resolve()),
    };
    return {
        info: {
            id: 'p:' + (entry.id || ''),
            kind: entry.kind,
            name: entry.name || driver.label,
            server: String(info.server || ''),
            database: String(info.database || ''),
            editable: false,
            immutable: false,
        },
        api,
    };
}

// 保存插件条目的密文字段（宿主在新增/编辑对话框提交时调用）；空值跳过（= 保持不变）
export function savePluginSecrets(backend, entryId, driver, values) {
    const puts = [];
    for (const field of driver.fields) {
        if (!field.secret) continue;
        const value = values[field.key];
        if (value == null || value === '') continue;
        puts.push(backend.DBCredentialPut(credKey(entryId, field.key), String(value)));
    }
    return Promise.all(puts).then(() => undefined);
}
