// db-completion.js：SQL 控制台的补全源（db 域，db-query-editor.js 调用本模块挂载）。
// 三层候选：方言关键词（语法级表，手维护允许）→ 库/表/视图（DBListObjects）→ 列
// （DBDescribe，点号上下文与 FROM/JOIN 别名解析）。元数据懒聚合：首次触发才拉、按会话
// 缓存、单飞防重（Go 侧 describeMeta 本身也带缓存）；DDL/写语句执行后失效并让下次描述带
// noCache（与 db-table-grid 写后刷新同语义）。候选数据全部来自客户端已有 API——无索引、
// 无新增绑定（无 mock-backend 义务）；任何元数据失败静默降级为纯关键词，不打断输入。
// 方案见 docs/unfinished-plans/editor-completion.md §5。

import {matchFilter} from '../core/completion.js';

const MAX_RESULT = 60;
const META_TIMEOUT_MS = 700; // 单个元数据请求的兜底上限：给不出就用手头的（关键词永在）
const MAX_TABLE_REFS = 6;    // 词首触发时并入列候选的表数量上限（无索引定位，不做全库预热）

// ── 方言关键词（语言语法级：小而稳定；API/stdlib 词典禁止，方案 §6.5 治理规则）──
export const SQL_KEYWORDS = {
    sqlite: [
        'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
        'create', 'table', 'view', 'index', 'trigger', 'drop', 'alter', 'add', 'column',
        'primary', 'key', 'foreign', 'references', 'unique', 'check', 'default', 'null',
        'not', 'and', 'or', 'in', 'is', 'like', 'glob', 'between', 'exists', 'case',
        'when', 'then', 'else', 'end', 'join', 'left', 'right', 'inner', 'outer', 'cross',
        'on', 'as', 'order', 'by', 'group', 'having', 'limit', 'offset', 'union', 'all',
        'distinct', 'asc', 'desc', 'with', 'recursive', 'cast', 'collate', 'if', 'autoincrement',
        'begin', 'commit', 'rollback', 'transaction', 'explain', 'pragma', 'vacuum', 'analyze', 'reindex',
        'attach', 'detach', 'database', 'replace', 'temp', 'temporary', 'using',
        'integer', 'text', 'real', 'blob', 'numeric', 'varchar', 'boolean', 'count',
        'sum', 'avg', 'min', 'max', 'coalesce', 'ifnull', 'nullif', 'abs', 'length', 'substr', 'round',
    ],
};

const MYSQL_EXTRAS = [
    'show', 'describe', 'desc', 'use', 'databases', 'tables', 'columns', 'information_schema',
    'auto_increment', 'engine', 'charset', 'collate', 'unsigned', 'zerofill', 'enum', 'json',
    'tinyint', 'smallint', 'mediumint', 'bigint', 'int', 'float', 'double', 'decimal',
    'date', 'datetime', 'timestamp', 'time', 'year', 'char', 'longtext', 'mediumtext', 'tinytext',
    'current_timestamp', 'now', 'on', 'update', 'cascade', 'restrict', 'action', 'no',
    'ignore', 'duplicate', 'key', 'keys', 'primary', 'partition', 'lock', 'unlock', 'start',
    'serial', 'generated', 'stored', 'virtual', 'comment', 'constraint', 'schema',
];

SQL_KEYWORDS.mysql = Array.from(new Set([...SQL_KEYWORDS.sqlite, ...MYSQL_EXTRAS]));

export function keywordsForKind(kind) {
    return SQL_KEYWORDS[kind] || SQL_KEYWORDS.sqlite;
}

// ── 点号上下文与别名解析（纯函数）──

// 光标前文本 → 上下文：chain 为标识符链（['users'] / ['mydb','users']），endsWithDot 表示
// 光标停在点号后（列上下文），prefix 为词首前缀（非点号尾时最后一个段）。
export function parseSqlContext(textBefore) {
    const s = String(textBefore || '');
    const m = s.match(/([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\.?$/);
    if (!m) return {chain: [], endsWithDot: false, prefix: ''};
    const parts = m[1].split('.');
    const endsWithDot = m[0].length > m[1].length;
    if (endsWithDot) return {chain: parts, endsWithDot: true, prefix: ''};
    return {chain: parts.slice(0, -1), endsWithDot: false, prefix: parts[parts.length - 1]};
}

// FROM/JOIN/INTO/UPDATE 涉及的表 → 别名映射（alias→table，table→table 自映射便于直查）。
// `FROM a, b` 的逗号列表第二段不在本解析内（低频场景，词法兜底接得住）。
const ALIAS_STOP = new Set([
    'where', 'on', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'join',
    'from', 'group', 'order', 'limit', 'union', 'having', 'set', 'values', 'as', 'select',
    'into', 'using', 'and', 'or', 'not', 'for', 'with', 'offset', 'by',
    'except', 'intersect', 'minus',
]);

export function resolveAliasMap(sqlText) {
    const map = new Map();
    const re = /\b(?:from|join|into|update)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
    const s = String(sqlText || '');
    let m;
    while ((m = re.exec(s)) !== null) {
        const ref = m[1];
        const alias = m[2];
        const safeAlias = alias && !ALIAS_STOP.has(alias.toLowerCase()) ? alias : null;
        if (safeAlias && safeAlias.toLowerCase() !== ref.toLowerCase()) {
            map.set(safeAlias.toLowerCase(), ref);
        }
        map.set(ref.toLowerCase(), ref);
        // `FROM db.table t`：让 table 段也能直查
        const parts = ref.split('.');
        if (parts.length === 2) map.set(parts[1].toLowerCase(), ref);
    }
    return map;
}

// 别名映射里出现过的真实表引用（去重，保序）。
export function tablesInSql(aliases) {
    const out = [];
    const seen = new Set();
    for (const ref of aliases.values()) {
        const k = String(ref).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const parts = String(ref).split('.');
        out.push(parts.length === 2 ? {db: parts[0], table: parts[1]} : {db: '', table: ref});
    }
    return out;
}

function splitRef(db, ref) {
    const parts = String(ref).split('.');
    if (parts.length === 2) return {db: parts[0], table: parts[1]};
    return {db: db || '', table: ref};
}

// 标识符链 → 表引用：['a'] 查别名/表；['db','t'] 直接跨库。
function resolveTableRef(chain, aliases) {
    if (!chain || !chain.length) return null;
    if (chain.length === 1) {
        const hit = aliases.get(chain[0].toLowerCase());
        return splitRef('', hit || chain[0]);
    }
    if (chain.length === 2) return {db: chain[0], table: chain[1]};
    return null;
}

// DDL 检测：命中即让会话缓存失效（CREATE/ALTER/DROP/TRUNCATE…）。
const DDL_RE = /\b(create|alter|drop|truncate|rename|grant|revoke|comment)\b/i;
export function isDdlSql(sqlText) {
    return DDL_RE.test(String(sqlText || ''));
}

// ── 文本工具（session 小心取值，不带 window 依赖）──

function fullText(session) {
    try { return String(session.getValue() || ''); } catch (e) { return ''; }
}

function textUpTo(session, pos) {
    const all = fullText(session);
    if (!pos || !Number.isFinite(pos.row)) return all;
    const lines = all.split('\n');
    const row = Math.min(Math.max(pos.row, 0), lines.length - 1);
    const head = lines.slice(0, row).join('\n');
    const cur = String(lines[row] || '').slice(0, pos.column || 0);
    return head ? head + '\n' + cur : cur;
}

function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve([]); } }, ms);
        Promise.resolve(promise).then((v) => {
            if (!done) { done = true; clearTimeout(t); resolve(v || []); }
        }, () => {
            if (!done) { done = true; clearTimeout(t); resolve([]); }
        });
    });
}

function columnDoc(c) {
    const bits = [];
    if (c && c.type) bits.push(String(c.type));
    if (c && c.pk) bits.push('主键');
    if (c && c.notNull) bits.push('NOT NULL');
    if (c && c.default != null && c.default !== '') bits.push('默认 ' + c.default);
    return bits.join(' · ');
}

// ── completer 工厂 ──

export function createSqlCompletion({backend, getSession}) {
    // sessionId → {objects, objectsPromise, objectsDb, dbs, columns:Map, pending:Map, needsFresh}
    const state = new Map();

    function st(sid) {
        if (!state.has(sid)) {
            state.set(sid, {objects: null, objectsPromise: null, objectsDb: '', columns: new Map(), pending: new Map(), needsFresh: false, metaEpoch: 0});
        }
        return state.get(sid);
    }

    // 对象清单：首个库（DBListDatabases[0]；SQLite 恒 ['main']）。空库/失败不缓存——保持
    // null 让下次触发重试（连接未就绪/瞬时失败的恢复路径）；并发调用等待在途 promise。
    async function loadObjects(sid) {
        const s = st(sid);
        if (s.objects) return s.objects;
        if (s.objectsPromise) return s.objectsPromise;
        const p = (async () => {
            let dbs = [];
            try {
                dbs = await backend.DBListDatabases(sid) || [];
            } catch (e) {
                dbs = []; // 后端瞬时失败：留空让下次触发重试
            }
            const db = (dbs && dbs.length && dbs[0]) || '';
            let list = [];
            if (db) {
                try {
                    list = await backend.DBListObjects(sid, db) || [];
                } catch (e) {
                    list = []; // 同上，重试路径
                }
            }
            s.dbs = dbs;
            s.objectsDb = db;
            s.objects = list.length ? list.map((o) => ({
                caption: String(o.name),
                value: String(o.name),
                meta: o.kind === 'view' ? '视图' : '表',
            })) : null;
            return s.objects || [];
        })();
        s.objectsPromise = p;
        try { await p; } catch (e) {}
        s.objectsPromise = null;
        return s.objects || [];
    }

    // 列清单：单飞（并发触发同一张表只发一次 DBDescribe）。
    // metaEpoch：DDL/写失效（noteQueryOutcome）会自增——在途旧请求完成后不再写缓存（旧结果
    // 只给当轮调用方，stale 一轮可接受），下一轮必然重新发 noCache 描述；needsFresh 的复位
    // 也在「真正发出 noCache 请求」的完成回调里做（复用旧 pending 的轮次不复位）。
    async function loadColumns(sid, db, table, noCache) {
        const s = st(sid);
        const key = (db || '') + '\x00' + table;
        if (!noCache && s.columns.has(key)) return s.columns.get(key);
        if (!s.pending.has(key)) {
            const myEpoch = s.metaEpoch;
            const p = (async () => {
                let meta = null;
                try { meta = await backend.DBDescribe(sid, db || '', table, !!noCache); } catch (e) {}
                const list = meta && Array.isArray(meta.columns)
                    ? meta.columns.filter((c) => c && c.name).map((c) => ({
                        caption: String(c.name),
                        value: String(c.name),
                        meta: String(c.type || ''),
                        docText: columnDoc(c),
                    }))
                    : [];
                // 请求在途期间发生了 DDL/写失效（epoch 已变）：旧结果不写缓存
                if (myEpoch === s.metaEpoch && list.length) s.columns.set(key, list);
                if (noCache && myEpoch === s.metaEpoch) s.needsFresh = false;
                return list;
            })();
            s.pending.set(key, p);
            let out = [];
            try { out = await p; } catch (e) { out = []; }
            s.pending.delete(key);
            // 发起者直接用自己 await 的结果（pending 可能被 noteQueryOutcome 中途清空）
            return out || (s.columns.get(key) || []);
        }
        return s.pending.get(key) || (s.columns.get(key) || []);
    }

    function keywordItems(sessionInfo) {
        return keywordsForKind(sessionInfo && sessionInfo.kind).map((k) => ({caption: k, value: k, meta: 'SQL'}));
    }

    async function buildItems(session, pos, sessionInfo) {
        const ctx = parseSqlContext(textUpTo(session, pos));
        const prefix = ctx.prefix || '';
        const out = [];
        const dedup = new Set();
        const push = (list) => {
            for (const it of list || []) {
                const k = it.caption + '\x00' + (it.meta || '');
                if (!dedup.has(k)) {
                    dedup.add(k);
                    out.push(it);
                }
            }
        };
        const sid = sessionInfo && sessionInfo.id;
        if (!sid) {
            push(keywordItems(sessionInfo));
            return matchFilter(prefix, out, MAX_RESULT);
        }
        if (ctx.endsWithDot) {
            // 列上下文：点号链 ['users'] / ['mydb','users'] / ['别名'] → 只给列候选；
            // 链不可解析（≥3 段等）回退关键词层，弹层不至于消失
            const aliases = resolveAliasMap(fullText(session));
            const ref = resolveTableRef(ctx.chain, aliases);
            if (ref) {
                const s = st(sid);
                const cols = await withTimeout(
                    loadColumns(sid, ref.db || s.objectsDb || '', ref.table, s.needsFresh),
                    META_TIMEOUT_MS,
                );
                push(cols);
            } else {
                push(keywordItems(sessionInfo));
            }
        } else {
            // 词首：对象清单 + 当前 SQL 引用到的表的列 + 关键词
            // （matchFilter 平分按插入序：关键词表长，排尾部防挤掉元数据候选）
            // 先等对象清单落定再拉列：列的默认库取 objectsDb，必须等它就位缓存键才稳定
            const aliases = resolveAliasMap(fullText(session));
            const sidState = st(sid);
            const objects = await withTimeout(loadObjects(sid), META_TIMEOUT_MS);
            const refs = tablesInSql(aliases).slice(0, MAX_TABLE_REFS);
            const colLists = await Promise.all(refs.map((r) => withTimeout(
                loadColumns(sid, r.db || sidState.objectsDb || '', r.table, sidState.needsFresh),
                META_TIMEOUT_MS,
            )));
            push(objects);
            for (const list of colLists) push(list);
            push(keywordItems(sessionInfo));
        }
        return matchFilter(prefix, out, MAX_RESULT);
    }

    const completer = {
        id: 'cadtSqlCompleter',
        // Ace 的 completer 回调支持异步（snippets/jsoneditor 自身同款机制）；元数据请求各自带
        // 700ms 兜底，最坏也在秒级内给出手头数据（关键词同步就绪，永不为空）。
        // getSession 只在入口取一次（抛异常按无会话降级），done 标志保证 callback 恰好调用一次。
        getCompletions(editor, session, pos, acePrefix, callback) {
            let sessionInfo = null;
            try {
                sessionInfo = getSession ? getSession() : null;
            } catch (e) {
                sessionInfo = null; // 会话状态取不到：降级为纯关键词
            }
            let done = false;
            const fire = (items) => {
                if (done) return;
                done = true;
                try { callback(null, items || []); } catch (e) {} // Ace 回调异常不该反向打断补全
            };
            const fallback = () => {
                let prefix = '';
                try { prefix = parseSqlContext(textUpTo(session, pos)).prefix || ''; } catch (e) {}
                fire(matchFilter(prefix, keywordItems(sessionInfo), MAX_RESULT));
            };
            buildItems(session, pos, sessionInfo).then(fire).catch(fallback);
        },
    };

    // 查询执行后由 db-query-editor 调：写语句 / DDL → 失效该会话缓存 + 下次描述带 noCache
    // （SQL 里新建/改表后，Go 侧 describeMeta 缓存也会被 noCache 绕开）
    function noteQueryOutcome(outcome, sqlText) {
        const sessionInfo = getSession ? getSession() : null;
        if (!sessionInfo || !sessionInfo.id) return;
        if (!outcome || outcome.status !== 'ok') return;
        const wrote = (typeof outcome.writes === 'number' && outcome.writes > 0) || !!outcome.writes;
        if (!wrote && !isDdlSql(sqlText)) return;
        const s = st(sessionInfo.id);
        s.metaEpoch++; // 在途旧描述完成时发现 epoch 已变，不再写缓存（见 loadColumns）
        s.pending.clear(); // 在途请求不再被后续轮复用：下一轮必然重新发起描述
        s.needsFresh = true;
        s.columns.clear();
        s.objects = null;
        s.objectsPromise = null;
    }

    function reset() {
        state.clear();
    }

    return {completer, noteQueryOutcome, reset};
}
