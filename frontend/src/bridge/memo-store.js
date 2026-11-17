// memo-store.js：快捷便签的状态层——按作用域缓存文档，统一读写与防抖保存。
// 视图（bridge-todo-view.js）与 AI 工具（ai-panel.js）都经这里改数据：
// mutate(fn) 改内存 doc → 1s 防抖 MemoSave（带 mtime CAS）。多窗口是多进程，
// 冲突由 Go 侧 CAS 判定，这里收到冲突就重载磁盘版本并广播，不做合并。

import {parseMemoDoc, defaultMemoData} from './memo-model.js';

const SAVE_DEBOUNCE_MS = 1000;

// createMemoStore(deps)：deps 全部 getter 延迟求值（组合根接线约定）。
// - backend：Wails 桥（dev 模式走 mock-backend 同名方法）
// - flash(msg, isErr)：状态栏提示
// - workspaceRoot()：当前工作区根（无则空串）
// - onPendingChange()：pending（有未落盘修改）状态翻转时回调——组合根把它接进
//   关窗脏标记（anyDirty），保证防抖窗口内关窗会走确认流程而不静默丢数据。
export function createMemoStore(deps) {
  // caches: key → {doc, mtimeMs, dirty, timer, scope, workspace}
  const caches = new Map();
  const changeListeners = new Set();

  const normKey = (p) => String(p || '').replace(/[\\/]+$/, '');
  const scopeKey = (scope, workspace) => scope + '|' + normKey(workspace).toLowerCase();

  function resolveWorkspace(scope, workspace) {
    const ws = workspace != null ? workspace : deps.workspaceRoot();
    return scope === 'workspace' ? normKey(ws) : '';
  }

  function notify(scope) {
    for (const fn of changeListeners) {
      try { fn(scope); } catch (e) { /* 单个订阅者出错不打断其余通知 */ }
    }
  }

  function onChange(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  }

  // load 读盘并缓存（幂等：已缓存的直接返回，force 时重读）。
  // 返回 {doc, scope, workspace, error?, changed?}（changed=内容与缓存不同，外部修改用）。
  async function load(scope, opts) {
    const workspace = resolveWorkspace(scope, opts && opts.workspace);
    const key = scopeKey(scope, workspace);
    const cached = caches.get(key);
    if (cached && !(opts && opts.force)) {
      return {doc: cached.doc, scope, workspace};
    }
    let envelope;
    try {
      envelope = JSON.parse(await deps.backend.MemoLoad(scope, workspace));
    } catch (e) {
      return {doc: defaultMemoData(), scope, workspace, error: String(e && e.message || e)};
    }
    const doc = parseMemoDoc(envelope.data);
    const json = JSON.stringify(doc);
    const changed = !!cached && JSON.stringify(cached.doc) !== json;
    caches.set(key, {doc, mtimeMs: Number(envelope.mtimeMs) || 0, dirty: false, timer: cached ? cached.timer : 0, scope, workspace});
    if (changed) notify(scope);
    return {doc, scope, workspace, changed};
  }

  function cached(scope) {
    const entry = findCache(scope);
    return entry && entry.cache ? entry.cache.doc : null;
  }

  function findCache(scope) {
    const workspace = resolveWorkspace(scope);
    const key = scopeKey(scope, workspace);
    return {key, cache: caches.get(key)};
  }

  // flush 立即保存（关面板/切作用域前调用），返回 {ok, error?, conflict?}。
  async function flush(scope) {
    const {key, cache} = findCache(scope);
    if (!cache) return {ok: true};
    if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
    if (!cache.dirty) return {ok: true};
    cache.dirty = false;
    return saveCache(key, cache);
  }

  async function saveCache(key, cache) {
    try {
      let res;
      try {
        res = await deps.backend.MemoSave(cache.scope, cache.workspace, JSON.stringify(cache.doc), cache.mtimeMs);
      } catch (e) {
        cache.dirty = true;
        return {ok: false, error: String(e && e.message || e)};
      }
      if (res && res.conflict) {
        // 别的窗口先写了：放弃本次缓存，重读磁盘版本并广播（刷新所有打开的面板）
        caches.delete(key);
        const fresh = await load(cache.scope, {workspace: cache.workspace, force: true});
        notify(cache.scope);
        return {ok: false, conflict: true, error: res.error, doc: fresh.doc};
      }
      if (!res || !res.ok) {
        cache.dirty = true;
        return {ok: false, error: (res && res.error) || '保存失败'};
      }
      cache.mtimeMs = Number(res.mtimeMs) || cache.mtimeMs;
      return {ok: true};
    } finally {
      emitPending();
    }
  }

  // emitPending：pending 状态可能翻转的每个出口都拉一次钩子（SetDirty 幂等，多调无害）。
  function emitPending() {
    if (deps.onPendingChange) deps.onPendingChange();
  }

  // hasPending 任一作用域还有未落盘的修改（关窗脏标记与测试用）。
  function hasPending() {
    for (const cache of caches.values()) {
      if (cache.dirty) return true;
    }
    return false;
  }

  // scheduleSave 防抖保存（每次 mutate 后调用，合并高频小改动）。
  function scheduleSave(scope) {
    const {cache} = findCache(scope);
    if (!cache) return;
    cache.dirty = true;
    emitPending();
    if (cache.timer) clearTimeout(cache.timer);
    cache.timer = setTimeout(async () => {
      cache.timer = 0;
      if (!cache.dirty) return;
      cache.dirty = false;
      const res = await saveCache(scopeKey(cache.scope, cache.workspace), cache);
      if (!res.ok && !res.conflict && deps.flash) deps.flash('快捷便签 保存失败：' + res.error, true);
      if (res.conflict && deps.flash) deps.flash('快捷便签 已在其他窗口修改，已刷新为磁盘版本', true);
    }, SAVE_DEBOUNCE_MS);
  }

  // mutate 统一变更入口：fn(doc) → {ok, doc?, error?}（memo-model 的变更函数）。
  // 成功则更新缓存、防抖保存并广播；失败原样返回（调用方决定怎么提示）。
  // 文档不在缓存时先 load，加载失败（如未开工作区）把错误如实带回。
  async function mutate(scope, fn) {
    const workspace = resolveWorkspace(scope);
    if (!findCache(scope).cache) {
      const loaded = await load(scope, {workspace});
      if (loaded.error) return {ok: false, error: loaded.error};
    }
    const entry = findCache(scope);
    if (!entry.cache) return {ok: false, error: '快捷便签 未加载'};
    const result = fn(entry.cache.doc);
    if (!result || !result.ok) return result;
    entry.cache.doc = result.doc;
    scheduleSave(scope);
    notify(scope);
    return result;
  }

  // flushAll 冲掉所有作用域挂着的未落盘修改（关窗确认流程 / pagehide 兜底调用）。
  // 每份缓存用自己的 workspace 根落盘（载入时捕获），换过工作区也不会写错地方。
  async function flushAll() {
    const jobs = [];
    for (const [key, cache] of Array.from(caches.entries())) {
      if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
      if (!cache.dirty) continue;
      cache.dirty = false;
      jobs.push(saveCache(key, cache));
    }
    await Promise.all(jobs);
  }

  // reloadExternal 外部文件变更（workspace-changed 事件 / 窗口 focus）时重读；
  // 内容没变就静默返回，变了经 notify 刷新视图。有未保存修改时跳过——
  // 让挂着的防抖保存用 CAS 去判，不静默丢弃用户正要写的内容。
  async function reloadExternal(scope) {
    const {cache} = findCache(scope);
    if (!cache) return false; // 面板没打开/没加载过，不打扰
    if (cache.dirty) return false;
    const res = await load(scope, {force: true});
    if (res.error) {
      if (deps.flash) deps.flash('快捷便签 重载失败：' + res.error, true);
      return false;
    }
    return !!res.changed;
  }

  // saveImage 贴图落盘，返回相对引用（img/xxx.png）或抛错给调用方提示。
  async function saveImage(scope, dataURL, workspace) {
    const ws = resolveWorkspace(scope, workspace);
    return deps.backend.MemoSaveImage(scope, ws, dataURL);
  }

  // forgetWorkspace 切换/关闭工作区时清理工作区作用域的缓存（防串工作区）。
  // 未落盘的修改先按缓存捕获的旧工作区根落盘——自动保存语义，切工作区不丢字。
  async function forgetWorkspace() {
    const jobs = [];
    for (const [key, cache] of Array.from(caches.entries())) {
      if (cache.scope !== 'workspace') continue;
      if (cache.timer) { clearTimeout(cache.timer); cache.timer = 0; }
      if (cache.dirty) {
        cache.dirty = false;
        jobs.push(saveCache(key, cache));
      }
      caches.delete(key);
    }
    await Promise.all(jobs);
    emitPending();
  }

  return {load, cached, mutate, flush, flushAll, hasPending, scheduleSave, reloadExternal, saveImage, onChange, forgetWorkspace};
}
