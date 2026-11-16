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
    safeVideoName,
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

    // 会话视频落盘（<id>/videos/）：与图片同构，只是换 Go 绑定与安全名。
    async function saveVideoFile(sessionId, video) {
        if (!video || typeof video !== 'object') return;
        if (!video.data || video.file) return;
        if (!backend.AISessionSaveVideo) return; // 旧后端：保留内嵌 base64，不丢视频
        const rel = await backend.AISessionSaveVideo(
            sessionId,
            safeVideoName(video),
            'data:' + (video.mime || 'video/mp4') + ';base64,' + video.data,
        );
        if (rel) video.file = rel;
    }

    async function prepareImages(session, messages) {
        for (const message of messages || []) {
            if (!message) continue;
            if (Array.isArray(message.images)) {
                for (const image of message.images) {
                    try {
                        await saveImageFile(session.id, image);
                    } catch (e) {
                        // 落盘失败时保留 base64，事件里继续内嵌，保证图片不丢。
                    }
                }
            }
            if (Array.isArray(message.videos)) {
                for (const video of message.videos) {
                    try {
                        await saveVideoFile(session.id, video);
                    } catch (e) {
                        // 落盘失败时保留 base64，事件里继续内嵌，保证视频不丢。
                    }
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
        // 落过盘了：面板打开时的 meta 对账靠它区分「新建还没写完」和「别处删了」
        session._unsaved = false;
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
        // 懒加载占位会话（正文还没读上来）：内存里的 messages 是空的，走日志重写会把历史抹平。
        // 只允许写 meta（标题 / 未读 / 置顶 / 待办 / 归档态都在里面）。
        if (session._stub) {
            return enqueue(session.id, async () => {
                // 基线由 toStubs 按读盘时的 meta 记好：没真改过就不写（否则每次 persistSessions
                // 都会给几十个占位各写一次 meta.json）
                await writeMetaIfChanged(session, false);
            });
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
    // 三个「整份重写日志」的入口（归档 / 清空 / 重写）绝不能作用在懒加载占位上：占位的
    // messages 是空的，重写等于把历史抹平。对应 dsh 那条「根本没有 save 整个会话的 API」——
    // 我们这边 rewrite 能力还在，所以把护栏钉在入口。调用方一律先 hydrateSession 再进来。
    function requireBody(session) {
        if (session && session._stub) {
            throw new Error('会话正文尚未加载，禁止改写磁盘历史（' + session.id + '）');
        }
    }

    function archiveSession(session, keep, summary) {
        if (!session || !session.id) return;
        requireBackend();
        requireBody(session);
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
        requireBody(session);
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
        requireBody(session);
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

    // 启动读盘并发度：每个会话都要整份重放 JSONL（几十个会话、单个几 MB 时串行 await
    // 叠加 Wails 往返能把面板空白拖到好几秒）。6 路足够摊平 IO，也不至于让 WebView
    // 同时持有过多大字符串；结果按下标回填，顺序与原串行实现一致。
    const LOAD_CONCURRENCY = 6;

    async function loadOne(meta, normalizeSession) {
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
        if (!session) return null;
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
        return session;
    }

    async function loadAll(normalizeSession) {
        requireBackend();
        let metas = [];
        try {
            metas = await backend.AISessionList();
        } catch (e) {
            throw e;
        }
        const loaded = new Array(metas.length).fill(null);
        let cursor = 0;
        async function worker() {
            while (cursor < metas.length) {
                const index = cursor++;
                let meta = null;
                try {
                    meta = JSON.parse(metas[index]);
                } catch (e) {
                    continue;
                }
                if (!meta || !meta.id) continue;
                // 单个会话读坏不影响整轮加载：与串行的 loadError 语义一致
                try {
                    loaded[index] = await loadOne(meta, normalizeSession);
                } catch (e) {
                    loaded[index] = null;
                }
            }
        }
        const workers = [];
        const lanes = Math.min(LOAD_CONCURRENCY, metas.length);
        for (let i = 0; i < lanes; i++) workers.push(worker());
        await Promise.all(workers);
        return loaded.filter(Boolean);
    }

    // ---------- 懒加载：先只要 meta，正文按需补 ----------
    // 列表页只用到 meta（标题/时间/条数/未读/置顶/工作区/待办/摘要…），正文整份重放是启动
    // 几十个会话时的主要开销。启动先 loadMetas 画列表，正文交给 hydrateSession 按需补。

    async function loadMetas() {
        requireBackend();
        const raw = await backend.AISessionList();
        const metas = [];
        for (const item of raw || []) {
            let meta = null;
            try {
                meta = JSON.parse(item);
            } catch (e) {
                continue;
            }
            if (meta && meta.id) metas.push(meta);
        }
        return metas;
    }

    // 把单个占位会话的正文就地补上：对象引用不变（列表、桥、通知里拿的都是同一个对象）。
    // 失败时退化成「正文不可用」：清掉占位标记 + 打 _loadError（等于禁止写盘），由既有错误 UI 兜住。
    // 把 meta 列表变成「占位会话」：只有列表字段，正文待 hydrateSession 补。
    // normalizeSession 由调用方给（与启动读盘同一套字段归一），保证两条路径形状一致。
    function toStubs(metas, normalizeSession) {
        const out = [];
        for (const meta of metas || []) {
            const session = normalizeSession ? normalizeSession(meta, out.length) : Object.assign({}, meta);
            if (!session) continue;
            session._stub = true;
            session._msgCount = Math.max(0, Number(meta.messageCount) || 0);
            session._archivedCount = Math.max(0, Number(meta.archivedCount) || 0);
            // 排序键缓存：占位没有正文，列表的时间与顺序只能读 meta 里的轮次起点
            session._turnTs = Math.max(0, Number(meta.turnTs) || 0);
            session._metaSig = metaSignature(buildSessionMeta(session));
            out.push(session);
        }
        return out;
    }

    async function hydrateSession(session) {
        if (!session || !session.id) return false;
        if (!session._stub) return true;
        requireBackend();
        let replay = replaySessionLog('');
        try {
            const bodyText = await backend.AISessionRead(session.id);
            replay = replaySessionLog(bodyText);
        } catch (e) {
            delete session._stub;
            delete session._msgCount;
            delete session._archivedCount;
            session._loadError = (e && e.message) || String(e);
            return false;
        }
        const normalize = typeof options.normalizeMessage === 'function' ? options.normalizeMessage : null;
        const messages = normalize ? replay.messages.map(normalize).filter(Boolean) : replay.messages;
        session.messages = messages;
        session.archived = replay.archived || [];
        if (!session.summary && replay.summary) session.summary = replay.summary;
        session._recovered = messages.some((message) => message && message._recovered);
        // 归一化可能丢掉无效消息，_mids 必须按归一化后的顺序重建，否则索引错位会重复追加。
        session._mids = messages.map((message) => textOf(message && message._mid));
        session._archivedMids = session.archived.map((message) => textOf(message && message._mid));
        resetFingerprints(session, messages);
        session._logMeta = {title: textOf(session.title), workspace: textOf(session.workspace)};
        session._logCreated = !!replay.header;
        session._needsRewrite = !!session._recovered || messages.length !== replay.messages.length;
        session._metaSig = metaSignature(buildSessionMeta(session));
        delete session._stub;
        delete session._msgCount;
        delete session._archivedCount;
        await hydrateImages(session);
        return true;
    }

    // 多个会话并发补水（启动的热会话用）。返回补成功的条数。
    async function hydrateSessions(list) {
        const targets = (list || []).filter((session) => session && session._stub);
        let cursor = 0;
        let done = 0;
        async function worker() {
            while (cursor < targets.length) {
                const index = cursor++;
                try {
                    if (await hydrateSession(targets[index])) done++;
                } catch (e) {}
            }
        }
        const lanes = Math.min(LOAD_CONCURRENCY, targets.length);
        const workers = [];
        for (let i = 0; i < lanes; i++) workers.push(worker());
        await Promise.all(workers);
        return done;
    }

    async function hydrateImages(session) {
        const lists = [session.messages, session.archived];
        for (const list of lists) {
            for (const message of list || []) {
                if (!message) continue;
                if (Array.isArray(message.images) && backend.AISessionReadImage) {
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
                if (Array.isArray(message.videos) && backend.AISessionReadVideo) {
                    for (const video of message.videos) {
                        if (!video || video.data || !video.file) continue;
                        const name = textOf(video.file).replace(/^videos[\\/]/, '');
                        if (!name || name.includes('/') || name.includes('\\')) continue;
                        try {
                            const url = await backend.AISessionReadVideo(session.id, name);
                            const marker = 'base64,';
                            const index = textOf(url).indexOf(marker);
                            if (index >= 0) video.data = textOf(url).slice(index + marker.length);
                        } catch (e) {}
                    }
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
        loadMetas,
        toStubs,
        hydrateSession,
        hydrateSessions,
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
