// db-sessions.js：数据库会话管理器——侧栏会话树与表/控制台标签页共享的会话生命周期。
//
// 一个工作区条目（连接）至多一个会话：幂等连接（并发调用共享同一 pending）；
// 断开/重连 + 订阅通知。会话生命周期挂侧栏（JetBrains 语义）：关标签页只关视图不断会话，
// 断开靠行菜单手动触发或 Go 侧空闲回收兜底（回收后调用报错，面板给重连入口）。
// 竞态防线沿用原 db-tab.js 的 connectEpoch 思路：disconnect/reconnect 使仍在飞行的连接
// 在 resolve 后发现世代不符，立即自释放刚拿到的会话。
//
// 插件 kind 的会话经 openPluginSession 拿 {info, api} 门面（db-plugin.js），
// 内置 kind api 为 null、直接走宿主绑定——消费方一律用 state.api || 全局 backend。

import {isPluginDbKind, openPluginSession, pluginDbDriverOf} from './db-plugin.js';

let backend = null; // 由组合根 configureDbSessions 注入（main.js 启动时一次）

export function configureDbSessions(deps) {
    backend = deps.backend;
}

function db() {
    if (!backend) throw new Error('db-sessions 未初始化（configureDbSessions）');
    return backend;
}

// entryId → {entry, status: connecting|connected|error|closed, info, api, error, pending, epoch}
const states = new Map();
// entryId → Set<listener>；会话状态变化（连接中/成功/失败/断开）时逐个通知
const listeners = new Map();

export function subscribeSession(entryId, cb) {
    if (!listeners.has(entryId)) listeners.set(entryId, new Set());
    listeners.get(entryId).add(cb);
    return () => {
        const set = listeners.get(entryId);
        if (set) set.delete(cb);
    };
}

// 会话状态快照（供 UI 渲染；api 是活引用不复制——门面对象本身不可变）
export function getSessionState(entryId) {
    const st = states.get(entryId);
    if (!st) return null;
    return {entry: st.entry, status: st.status, info: st.info, api: st.api, error: st.error};
}

function notify(entryId) {
    const snap = getSessionState(entryId);
    const set = listeners.get(entryId);
    if (!set) return;
    for (const cb of set) {
        try {
            cb(snap);
        } catch (e) {
            // 单个监听器异常不中断其他监听器（状态通知是尽力而为路径）
        }
    }
}

function startConnect(st) {
    const epoch = ++st.epoch;
    st.status = 'connecting';
    st.error = '';
    notify(st.entry.id);
    const attempt = (async () => {
        if (isPluginDbKind(st.entry.kind)) {
            const driver = pluginDbDriverOf(st.entry.kind);
            if (!driver) throw new Error('驱动未注册（插件已禁用或卸载）');
            return openPluginSession(db(), st.entry, driver);
        }
        const info = st.entry.kind === 'sqlite'
            ? await db().DBOpen(st.entry.path, !!st.entry.allowEdit)
            : await db().DBConnect(st.entry.connectionId);
        return {info, api: null};
    })();
    const wrapped = attempt.then(
        (opened) => {
            // 被「断开/重连」超越：立即释放刚拿到的会话，不让它泄漏（db-tab.js 原防线）
            if (st.epoch !== epoch) {
                const closing = opened.api ? opened.api.DBClose() : db().DBClose(opened.info.id);
                return Promise.resolve(closing).catch(() => {}).then(() => {
                    throw new Error('连接已取消');
                });
            }
            st.status = 'connected';
            st.info = opened.info;
            st.api = opened.api;
            st.pending = null;
            notify(st.entry.id);
            return {info: opened.info, api: opened.api};
        },
        (e) => {
            if (st.epoch !== epoch) throw new Error('连接已取消'); // 被超越：状态由新的连接/断开负责
            st.status = 'error';
            st.info = null;
            st.api = null;
            st.pending = null;
            st.error = String(e && e.message || e);
            notify(st.entry.id);
            throw e;
        },
    );
    st.pending = wrapped;
    return wrapped;
}

// ensureSession 幂等连接：已连接复用；连接中共享同一 pending；否则发起新连接。
// entry 每次传最新快照（编辑连接保存后重连生效）。
export function ensureSession(entry) {
    if (!entry || !entry.id) return Promise.reject(new Error('数据库条目无效'));
    let st = states.get(entry.id);
    if (!st) {
        st = {entry, status: 'closed', info: null, api: null, error: '', pending: null, epoch: 0};
        states.set(entry.id, st);
    }
    st.entry = entry;
    if (st.status === 'connected') return Promise.resolve({info: st.info, api: st.api});
    if (st.pending) return st.pending;
    return startConnect(st);
}

// disconnectSession 断开并清理状态。在飞连接由 startConnect 的世代检查自行释放。
export function disconnectSession(entryId) {
    const st = states.get(entryId);
    if (!st) return Promise.resolve();
    st.epoch++; // 让在飞连接 resolve 后自释放
    st.status = 'closed';
    st.error = '';
    st.pending = null;
    const info = st.info;
    const api = st.api;
    st.info = null;
    st.api = null;
    notify(entryId);
    if (!info) return Promise.resolve();
    // 会话可能已被空闲回收：DBClose 报错也照常清理界面（原 db-tab.js 语义）
    const closing = api ? api.DBClose() : db().DBClose(info.id);
    return Promise.resolve(closing).catch(() => {}).then(() => notify(entryId));
}

// reconnectSession 先断再连（编辑连接保存后 / 手动重连 / 会话被空闲回收后的恢复入口）。
export function reconnectSession(entry) {
    return disconnectSession(entry.id).then(() => ensureSession(entry));
}

// isSessionMissing 会话不存在类错误的判定（Go 侧空闲回收 / 手动断开后继续调用）。
export function isSessionMissing(e) {
    const msg = String(e && e.message || e);
    return /会话不存在|session (not found|expired)/i.test(msg);
}

// 测试辅助：清空全部会话状态与监听（模块级单例的用例隔离；生产代码不要调用）
export function _resetDbSessionsForTests() {
    states.clear();
    listeners.clear();
}
