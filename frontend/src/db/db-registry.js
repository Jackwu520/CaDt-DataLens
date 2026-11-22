// db-registry.js：工作区数据库清单（settings.dbWorkspaceDatabases）的纯函数操作。
// 侧栏面板（db-ui.js）与 AI 的 app_control 动作（db-app-actions.js）共用同一套增删改语义，
// 避免两处口径漂移；settings 是主窗口的活对象（persistSettingsLight 由调用方负责）。
//
// 条目形状：{id, workspace, kind: 'sqlite'|'mysql'|'mariadb'|'plugin:<pid>:<did>',
//           name, path?|connectionId?|config?, allowEdit?, addedAt}

export const DB_REGISTRY_KEY = 'dbWorkspaceDatabases';

export function newWorkspaceDbId() {
    return 'wsdb-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

/** 某工作区的清单条目（保持注册表顺序）。 */
export function workspaceDbEntries(settings, ws) {
    const all = Array.isArray(settings && settings[DB_REGISTRY_KEY]) ? settings[DB_REGISTRY_KEY] : [];
    return all.filter((e) => e.workspace === ws);
}

/**
 * MySQL/MariaDB 的工作区引用同步：inWorkspace=true 确保存在（protocol 决定分组标签），
 * false 移除；同一连接在同一工作区只保留一条。直接原地改 settings，返回新清单。
 */
export function syncWorkspaceDbRef(settings, ws, {connectionId, inWorkspace, name, protocol}) {
    const kind = protocol === 'mariadb' ? 'mariadb' : 'mysql';
    const all = Array.isArray(settings && settings[DB_REGISTRY_KEY]) ? settings[DB_REGISTRY_KEY] : [];
    const kept = all.filter((e) => !((e.kind === 'mysql' || e.kind === 'mariadb') && e.connectionId === connectionId && e.workspace === ws));
    if (inWorkspace) {
        kept.push({
            id: newWorkspaceDbId(),
            workspace: ws,
            kind,
            connectionId,
            name: name || '',
            addedAt: Date.now(),
        });
    }
    settings[DB_REGISTRY_KEY] = kept;
    return kept;
}

/** 全局删除连接时：所有引用它的条目一并移除。 */
export function removeAllWorkspaceDbRefs(settings, connectionId) {
    const all = Array.isArray(settings && settings[DB_REGISTRY_KEY]) ? settings[DB_REGISTRY_KEY] : [];
    settings[DB_REGISTRY_KEY] = all.filter((e) => e.connectionId !== connectionId);
}
