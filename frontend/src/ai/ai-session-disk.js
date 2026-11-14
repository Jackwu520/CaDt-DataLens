// AI 会话磁盘存储适配：把事件日志与 meta.json 落到 backend 提供的会话接口上。
// 追加式 JSONL 为唯一真源；编码/重放/指纹等纯逻辑在 ai-session-store.js，本模块只做
// 排队、写入、图片落盘、meta 同步与错误上报（依赖注入 backend，不碰 DOM）。
import {
    buildSessionMeta,
    encodeArchiveEvent,
    encodeMessageEvent,
    encodeMetaEvent,
    encodeSessionHeader,
    encodeSessionLines,
    encodeTruncateEvent,
    messageFingerprint,
    metaSignature,
    replaySessionLog,
    safeImageName,
    textOf,
} from './ai-session-store.js';

// ---------- 磁盘适配 ----------

export function createSessionDiskStore(options) {
    const backend = options.backend || {};
    const genId = options.genId || ((prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    const queues = new Map();
    const pending = new Set();

    function requireBackend() {
        for (const name of ['AISessionList', 'AISessionRead', 'AISessionAppend', 'AISessionRewrite', 'AISessionWriteMeta', 'AISessionDelete']) {
            if (!backend[name]) throw new Error('当前版本缺少会话存储接口：' + name);
        }
    }

    function enqueue(id, task) {
        const key = textOf(id);
        const prev = queues.get(key) || Promise.resolve();
        const next = prev.then(task, task).catch((err) => {
            onError(err);
        });
        queues.set(key, next);
        pending.add(next);
        next.finally(() => pending.delete(next));
        return next;
    }

    async function flush() {
        while (pending.size) {
            await Promise.all(Array.from(pending));
        }
    }

    function newMid() {
        return genId('m-');
    }

    // 已落盘消息的指纹表（mid → 指纹）。按 mid 存，不随消息下标变化而错位。
    function fingerprintsOf(session) {
        if (!(session._fps instanceof Map)) session._fps = new Map();
        return session._fps;
    }

    function resetFingerprints(session, list) {
        const fps = new Map();
        for (const message of list || []) {
            const mid = textOf(message && message._mid);
            if (mid) fps.set(mid, messageFingerprint(message));
        }
        session._fps = fps;
        return fps;
    }

    // 写盘失败时把日志记账恢复到写前状态，保证下一次持久化会重试这批消息。
    function snapshotLogState(session) {
        return {
            mids: Array.isArray(session._mids) ? session._mids.slice() : [],
            archivedMids: Array.isArray(session._archivedMids) ? session._archivedMids.slice() : [],
            logCreated: !!session._logCreated,
            logMeta: session._logMeta ? Object.assign({}, session._logMeta) : session._logMeta,
            needsRewrite: !!session._needsRewrite,
            fps: session._fps instanceof Map ? new Map(session._fps) : null,
        };
    }

    function restoreLogState(session, state) {
        session._mids = state.mids;
        session._archivedMids = state.archivedMids;
        session._logCreated = state.logCreated;
        session._logMeta = state.logMeta;
        session._needsRewrite = state.needsRewrite;
        session._fps = state.fps;
    }

    // 追加式日志不会自动覆盖已落盘的消息。消息首次落盘后被就地修改（审批对象的
    // pending → approved/denied/failed、自动放行来源等）时调用这里：把该消息从
    // 「已持久化前缀」里摘出，下一次 persistSession 会在它的位置断开公共前缀，
    // 发 truncate 截掉旧事件后按当前状态重追加，避免 JSONL 永远留着旧状态
    // （如分类器放行来源、用户裁定结果丢失，或残留「pending」）。
    function invalidateMessage(session, message) {
        if (!session || session._loadError) return;
        if (!message || typeof message !== 'object' || message.status === 'streaming') return;
        if (!Array.isArray(session.messages) || !Array.isArray(session._mids)) return;
        const index = session.messages.indexOf(message);
        if (index < 0 || index >= session._mids.length) return; // 从未落盘的消息无需失效
        const mid = textOf(message._mid);
        if (mid && session._mids[index] === mid) session._mids[index] = '';
    }

    async function saveImageFile(sessionId, image) {
        if (!image || typeof image !== 'object') return;
        if (!image.data || image.file) return;
        if (!backend.AISessionSaveImage) return; // 旧后端：保留内嵌 base64，不丢图
        const rel = await backend.AISessionSaveImage(
            sessionId,
            safeImageName(image),
            'data:' + (image.mime || 'image/png') + ';base64,' + image.data,
        );
        if (rel) image.file = rel;
    }

    async function prepareImages(session, messages) {
        for (const message of messages || []) {
            if (!message || !Array.isArray(message.images)) continue;
            for (const image of message.images) {
                try {
                    await saveImageFile(session.id, image);
                } catch (e) {
                    // 落盘失败时保留 base64，事件里继续内嵌，保证图片不丢。
                }
            }
        }
    }

    function syncMids(session, list, archivedList) {
        const mids = Array.isArray(session._mids) ? session._mids : [];
        const next = list.map((message, index) => {
            let mid = textOf(message && message._mid);
            if (!mid) {
                mid = mids[index] || newMid();
                if (message && typeof message === 'object') message._mid = mid;
            }
            return mid;
        });
        session._mids = next;
        const archivedMids = [];
        for (const message of archivedList || []) {
            let mid = textOf(message && message._mid);
            if (!mid) {
                mid = newMid();
                if (message && typeof message === 'object') message._mid = mid;
            }
            archivedMids.push(mid);
        }
        session._archivedMids = archivedMids;
    }

    function buildRewriteEvents(session) {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const archived = Array.isArray(session.archived) ? session.archived : [];
        syncMids(session, messages, archived);
        const events = [encodeSessionHeader(session)];
        session._logCreated = true;
        session._needsRewrite = false;
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        if (session.summary) events.push(encodeMetaEvent({summary: session.summary}));
        archived.forEach((message, index) => {
            // mids 条目可能被 invalidateMessage 清空：回退到消息自带的 _mid，整份重写时不能丢消息。
            const event = encodeMessageEvent(message, session._archivedMids[index] || textOf(message && message._mid), true);
            if (event) events.push(event);
        });
        messages.forEach((message, index) => {
            const event = encodeMessageEvent(message, session._mids[index] || textOf(message && message._mid), false);
            if (event) events.push(event);
        });
        // 整份重写后磁盘内容与内存一致：指纹表按当前消息重建。
        resetFingerprints(session, messages);
        return events;
    }

    // 新会话的第一条事件必须是 header；之后只追加事件行。
    function ensureHeaderEvent(session, events) {
        if (session._logCreated || !events.length) return events;
        events.unshift(encodeSessionHeader(session));
        session._logCreated = true;
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        return events;
    }

    async function writeMetaIfChanged(session, force) {
        const meta = buildSessionMeta(session);
        const signature = metaSignature(meta);
        if (!force && signature === session._metaSig) return;
        session.updatedAt = Date.now();
        meta.updatedAt = session.updatedAt;
        await backend.AISessionWriteMeta(session.id, JSON.stringify(meta));
        session._metaSig = signature;
    }

    // 增量持久化：按 _mid 找共同前缀，截断后追加新消息。
    const pendingPersists = new Set();

    // 同一会话已有排队中的持久化任务时直接复用：任务执行时才读最新状态，
    // 高频 persistSessions（每个工具轮）不会把队列堆长。
    function persistSession(session) {
        if (!session || !session.id) return Promise.resolve();
        if (session._loadError) return Promise.resolve(); // 正文没读出来时禁止写，避免覆盖磁盘历史
        try {
            requireBackend();
        } catch (e) {
            return Promise.reject(e);
        }
        if (pendingPersists.has(session.id)) return Promise.resolve();
        pendingPersists.add(session.id);
        return enqueue(session.id, async () => {
            pendingPersists.delete(session.id);
            await runPersistSession(session);
        });
    }

    async function runPersistSession(session) {
        if (!session || !session.id) return;
        if (session._loadError) return;
        const state = snapshotLogState(session);
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const archived = Array.isArray(session.archived) ? session.archived : [];
        const mids = Array.isArray(session._mids) ? session._mids : [];
        const archivedMids = Array.isArray(session._archivedMids) ? session._archivedMids : [];
        if (session._needsRewrite || archived.length !== archivedMids.length) {
            // 归一化丢过消息 / 归档在不经过 archive() 的情况下被改动：整份重写，保证日志与内存一致。
            await prepareImages(session, archived.concat(messages));
            try {
                const events = buildRewriteEvents(session);
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
            return;
        }
        await prepareImages(session, messages);
        const events = [];
        if (!session._logCreated) {
            // 新会话的正文以 header 开头；先落 header 再算标题补丁，避免重复的 meta 事件。
            events.push(encodeSessionHeader(session));
            session._logCreated = true;
            session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        }
        const logMeta = session._logMeta && typeof session._logMeta === 'object' ? session._logMeta : {};
        const patch = {};
        if (textOf(session.title) !== textOf(logMeta.title)) patch.title = textOf(session.title);
        if (textOf(session.workspace) !== textOf(logMeta.workspace)) patch.workspace = textOf(session.workspace);
        if (Object.keys(patch).length) {
            events.push(encodeMetaEvent(patch));
            session._logMeta = Object.assign({}, logMeta, patch);
        }
        let common = 0;
        const fps = fingerprintsOf(session);
        // 前缀要 mid 与指纹都对上才算「已落盘」：就地改过状态的消息会让前缀在这里断开，
        // 下面 truncate 后按当前内容重追加（见 messageFingerprint 的说明）。
        while (common < mids.length && common < messages.length &&
               textOf(messages[common] && messages[common]._mid) === mids[common] &&
               fps.get(mids[common]) === messageFingerprint(messages[common])) {
            common++;
        }
        if (common < mids.length) {
            events.push(encodeTruncateEvent(common));
            for (let i = common; i < mids.length; i++) if (mids[i]) fps.delete(mids[i]);
            mids.length = common;
        }
        for (let i = common; i < messages.length; i++) {
            const message = messages[i];
            if (!message || typeof message !== 'object') continue;
            if (message.status === 'streaming') break;
            let mid = textOf(message._mid);
            if (!mid) {
                mid = newMid();
                message._mid = mid;
            }
            mids[i] = mid;
            fps.set(mid, messageFingerprint(message));
            const event = encodeMessageEvent(message, mid, false);
            if (event) events.push(event);
        }
        try {
            session._mids = mids;
            session._fps = fps;
            if (events.length) {
                ensureHeaderEvent(session, events);
                await backend.AISessionAppend(session.id, encodeSessionLines(events));
            }
        } catch (e) {
            restoreLogState(session, state);
            throw e;
        }
        await writeMetaIfChanged(session, events.length > 0);
    }

    // 归档必须先于调用方裁剪 messages 执行：这里捕获裁剪前的快照，
    // 保证被移动的消息先落进日志，再追加 archive 事件。
    function archiveSession(session, keep, summary) {
        if (!session || !session.id) return;
        requireBackend();
        const snapshot = (Array.isArray(session.messages) ? session.messages : []).slice();
        const keepCount = Math.max(0, Math.min(snapshot.length, Number(keep) || 0));
        return enqueue(session.id, async () => {
            const liveNow = Array.isArray(session.messages) ? session.messages : [];
            const archivedNow = Array.isArray(session.archived) ? session.archived : [];
            const midsNow = Array.isArray(session._mids) ? session._mids : [];
            const archivedMidsNow = Array.isArray(session._archivedMids) ? session._archivedMids : [];
            // 队列里更早的 persist 可能已经把裁剪后的归档状态整份重写进磁盘：
            // 此时 live/archived 与 mids 已对齐，再追加 archive 事件会把消息重复写一遍。
            if (liveNow.length !== snapshot.length &&
                liveNow.length === midsNow.length &&
                archivedNow.length === archivedMidsNow.length) {
                return;
            }
            const state = snapshotLogState(session);
            if (session._needsRewrite) {
                // 加载时归一化丢掉过消息：日志里的下标与内存不一致，直接按裁剪后的状态整份重写。
                try {
                    session._needsRewrite = false;
                    await prepareImages(session, archivedNow.concat(liveNow));
                    const events = buildRewriteEvents(session);
                    await backend.AISessionRewrite(session.id, encodeSessionLines(events));
                } catch (e) {
                    restoreLogState(session, state);
                    throw e;
                }
                await writeMetaIfChanged(session, true);
                return;
            }
            const mids = midsNow;
            const archivedMids = archivedMidsNow;
            const fps = fingerprintsOf(session);
            await prepareImages(session, snapshot);
            const events = [];
            let common = 0;
            while (common < mids.length && common < snapshot.length &&
                   textOf(snapshot[common] && snapshot[common]._mid) === mids[common] &&
                   fps.get(mids[common]) === messageFingerprint(snapshot[common])) {
                common++;
            }
            if (common < mids.length) {
                events.push(encodeTruncateEvent(common));
                for (let i = common; i < mids.length; i++) if (mids[i]) fps.delete(mids[i]);
                mids.length = common;
            }
            for (let i = common; i < snapshot.length; i++) {
                const message = snapshot[i];
                if (!message || typeof message !== 'object') continue;
                let mid = textOf(message._mid);
                if (!mid) {
                    mid = newMid();
                    message._mid = mid;
                }
                mids[i] = mid;
                fps.set(mid, messageFingerprint(message));
                const event = encodeMessageEvent(message, mid, false);
                if (event) events.push(event);
            }
            events.push(encodeArchiveEvent(keepCount, summary));
            try {
                // keep 是保留数：[0, keep) 移入归档，[keep, end) 留在live。
                session._mids = mids.slice(keepCount);
                session._archivedMids = archivedMids.concat(mids.slice(0, keepCount));
                ensureHeaderEvent(session, events);
                await backend.AISessionAppend(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
        });
    }

    function resetSession(session) {
        if (!session || !session.id) return;
        requireBackend();
        return enqueue(session.id, async () => {
            const state = snapshotLogState(session);
            try {
                session._mids = [];
                session._archivedMids = [];
                session._fps = new Map();
                const events = [encodeSessionHeader(session)];
                if (session.summary) events.push(encodeMetaEvent({summary: session.summary}));
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
                session._logCreated = true;
                session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
        });
    }

    function rewriteSession(session) {
        if (!session || !session.id) return;
        requireBackend();
        return enqueue(session.id, async () => {
            const state = snapshotLogState(session);
            try {
                await prepareImages(session, (session.archived || []).concat(session.messages || []));
                const events = buildRewriteEvents(session);
                await backend.AISessionRewrite(session.id, encodeSessionLines(events));
            } catch (e) {
                restoreLogState(session, state);
                throw e;
            }
            await writeMetaIfChanged(session, true);
        });
    }

    async function loadAll(normalizeSession) {
        requireBackend();
        let metas = [];
        try {
            metas = await backend.AISessionList();
        } catch (e) {
            throw e;
        }
        const sessions = [];
        for (const raw of metas || []) {
            let meta = null;
            try {
                meta = JSON.parse(raw);
            } catch (e) {
                continue;
            }
            if (!meta || !meta.id) continue;
            let replay = replaySessionLog('');
            let loadError = '';
            let bodyText = '';
            try {
                bodyText = await backend.AISessionRead(meta.id);
                replay = replaySessionLog(bodyText);
            } catch (e) {
                loadError = (e && e.message) || String(e);
            }
            const combined = Object.assign({}, meta, {
                messages: replay.messages,
                archived: replay.archived,
                summary: meta.summary && typeof meta.summary === 'object' ? meta.summary : replay.summary,
            });
            const session = normalizeSession ? normalizeSession(combined) : combined;
            if (!session) continue;
            // 归一化可能丢掉无效消息，_mids 必须按归一化后的消息顺序重建，否则索引错位会触发重复追加。
            session._mids = (session.messages || []).map((message) => textOf(message && message._mid));
            session._archivedMids = (session.archived || []).map((message) => textOf(message && message._mid));
            // 刚读出来的消息就是磁盘状态，指纹按当前内容建立基线。
            resetFingerprints(session, session.messages);
            session._logMeta = {title: textOf(meta.title), workspace: textOf(meta.workspace)};
            session._logCreated = !!replay.header;
            session._needsRewrite = !!session._recovered || (session.messages || []).length !== replay.messages.length;
            session.updatedAt = Number(meta.updatedAt) || Number(meta.createdAt) || 0;
            session._loadError = loadError;
            session._metaSig = metaSignature(buildSessionMeta(session));
            await hydrateImages(session);
            sessions.push(session);
        }
        return sessions;
    }

    async function hydrateImages(session) {
        if (!backend.AISessionReadImage) return;
        const lists = [session.messages, session.archived];
        for (const list of lists) {
            for (const message of list || []) {
                if (!message || !Array.isArray(message.images)) continue;
                for (const image of message.images) {
                    if (!image || image.data || !image.file) continue;
                    const name = textOf(image.file).replace(/^images[\\/]/, '');
                    if (!name || name.includes('/') || name.includes('\\')) continue;
                    try {
                        const url = await backend.AISessionReadImage(session.id, name);
                        const marker = 'base64,';
                        const index = textOf(url).indexOf(marker);
                        if (index >= 0) image.data = textOf(url).slice(index + marker.length);
                    } catch (e) {}
                }
            }
        }
    }

    async function removeSession(id) {
        requireBackend();
        await flush();
        return backend.AISessionDelete(id);
    }

    async function removeAll() {
        requireBackend();
        await flush();
        if (!backend.AISessionDeleteAll) throw new Error('当前版本缺少批量删除接口');
        return backend.AISessionDeleteAll();
    }

    return {
        loadAll,
        persistSession,
        invalidateMessage,
        archiveSession,
        resetSession,
        rewriteSession,
        removeSession,
        removeAll,
        flush,
        hydrateImages,
        newMid,
    };
}
