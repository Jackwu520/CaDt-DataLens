// db-app-actions.js：app_control 的数据库动作——AI 代配数据库连接的入口。
//
// 四个动作（技能表见 ai-constants.js cadt-ui「动作表」；三处对账守卫 ai-app-actions.test.mjs）：
//   db_list_connections：已保存连接清单（不含密码）
//   db_save_connection：新建/更新连接（必弹审批卡；addToWorkspace 默认 true = 加入当前工作区）
//   db_delete_connection：删除连接（必弹审批卡；配置 + 加密凭据 + 工作区引用一并清）
//   db_test_connection：连通性测试（只读，不落盘）
//
// 密码只在动作参数里出现一次：DPAPI 加密落库后不再回传（返回值不含任何凭据）；
// 工作区清单走 db-registry.js 的纯函数（与侧栏同一套语义）。

import {removeAllWorkspaceDbRefs, syncWorkspaceDbRef} from './db-registry.js';

export function createDbAppActions(deps) {
    // deps：{backend, settings（活对象）, persistSettingsLight, workspaceFolder（字符串 getter）}

    async function saveAndSync(cfg, password, addToWorkspace) {
        const saved = await deps.backend.DBSaveConnection(cfg, password);
        let workspace = 'not-added';
        let syncError = '';
        if (addToWorkspace !== false) {
            try {
                syncWorkspaceDbRef(deps.settings, deps.workspaceFolder || '', {
                    connectionId: saved.id,
                    inWorkspace: true,
                    name: saved.name,
                    protocol: cfg.driver,
                });
                deps.persistSettingsLight();
                workspace = 'added';
            } catch (e) {
                // 工作区清单同步失败不掩盖保存成功（与 db-connections.js applyDraft 同口径）
                syncError = String(e && e.message || e);
            }
        }
        return {saved, workspace, syncError};
    }

    return async function handleDbAppAction(action, p, requestActionApproval) {
        const params = p && typeof p === 'object' ? p : {};
        switch (action) {
            case 'db_list_connections': {
                const list = await deps.backend.DBListConnections() || [];
                return {connections: list};
            }
            case 'db_save_connection': {
                const name = String(params.name || '').trim();
                const host = String(params.host || '').trim();
                const user = String(params.user || '').trim();
                if (!name || !host || !user) throw new Error('db_save_connection 需要 name / host / user');
                const cfg = {
                    id: String(params.id || ''),
                    name,
                    kind: 'mysql', // mysql 与 mariadb 同引擎；driver 只决定工作区分组标签
                    host,
                    port: Number(params.port) || 3306,
                    database: String(params.database || ''),
                    user,
                    allowEdit: !!params.allowEdit,
                    updatedAt: 0,
                    driver: String(params.driver || 'mysql') === 'mariadb' ? 'mariadb' : 'mysql',
                };
                if (typeof requestActionApproval === 'function') {
                    const answer = await requestActionApproval({
                        action: 'db_save_connection',
                        title: (cfg.id ? '更新' : '新建') + '数据库连接：' + name,
                        target: host + ':' + cfg.port + (cfg.database ? '/' + cfg.database : ''),
                        oldValue: cfg.id ? '已有连接（更新配置）' : '未配置',
                        newValue: user + '@' + host + ':' + cfg.port +
                            (cfg.allowEdit ? ' · 允许编辑' : ' · 只读') +
                            (params.addToWorkspace !== false ? ' · 加入当前工作区' : ''),
                        risk: 'medium',
                        warnings: [
                            '密码将经 DPAPI 加密存储在本机，不会回传到对话',
                            '连接仅用于本应用的数据库浏览面板',
                        ],
                    });
                    if (!answer || !answer.approved) {
                        return {saved: false, denied: true, note: '用户拒绝了本次连接配置'};
                    }
                }
                const {saved, workspace, syncError} = await saveAndSync(cfg, String(params.password || ''), params.addToWorkspace);
                const result = {
                    saved: {
                        id: saved.id,
                        name: saved.name,
                        host: saved.host,
                        port: saved.port,
                        database: saved.database,
                        user: saved.user,
                        allowEdit: saved.allowEdit,
                    },
                    workspace,
                };
                if (syncError) result.syncError = syncError;
                return result;
            }
            case 'db_delete_connection': {
                const id = String(params.id || '').trim();
                if (!id) throw new Error('db_delete_connection 需要 id（先用 db_list_connections 查）');
                const list = await deps.backend.DBListConnections() || [];
                const cfg = list.find((c) => c.id === id);
                if (typeof requestActionApproval === 'function') {
                    const answer = await requestActionApproval({
                        action: 'db_delete_connection',
                        title: '删除数据库连接：' + (cfg ? cfg.name : id),
                        target: cfg ? cfg.host + ':' + cfg.port + (cfg.database ? '/' + cfg.database : '') : id,
                        oldValue: '已配置',
                        newValue: '删除（配置 + 加密凭据 + 工作区引用）',
                        risk: 'high',
                        warnings: ['保存的密码（加密凭据）一并删除，不可恢复；不影响数据库本身'],
                    });
                    if (!answer || !answer.approved) {
                        return {deleted: false, denied: true, note: '用户拒绝了本次删除'};
                    }
                }
                await deps.backend.DBDeleteConnection(id);
                removeAllWorkspaceDbRefs(deps.settings, id);
                deps.persistSettingsLight();
                return {deleted: true, id};
            }
            case 'db_test_connection': {
                const cfg = {
                    id: '',
                    name: 'test',
                    kind: 'mysql',
                    host: String(params.host || '').trim(),
                    port: Number(params.port) || 3306,
                    database: String(params.database || ''),
                    user: String(params.user || ''),
                };
                const version = await deps.backend.DBTestConnection(cfg, String(params.password || ''));
                return {ok: true, server: version};
            }
            default:
                throw new Error('未知的数据库动作：' + action);
        }
    };
}
