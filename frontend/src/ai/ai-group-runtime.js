// ai-group-runtime.js：群聊运行时——群状态、磁盘适配、加载/创建/删除、订阅通知。
// G2 接讨论队列与流事件（handleEvent）；G3 接主持人循环。main.js 把 ai-* 事件
// 与本模块的 handleEvent 串在一起；侧栏（ai-group-sidebar）与标签页视图
// （bridge-group-view）经 subscribe 拿快照。
import {aiNowId} from './ai-constants.js';
import {
    GROUP_MEMBER_MAX,
    GROUP_MEMBER_MIN,
    TIMEOUT_PRESETS,
    normalizeChair,
    normalizeGroupMeta,
} from './ai-group-model.js';
import {createGroupStoreAdapter, groupHeaderLine, replayGroupLog} from './ai-group-store.js';

export function createAIGroupRuntime(deps) {
    const store = createGroupStoreAdapter(deps.backend);
    const getAIConfig = typeof deps.getAIConfig === 'function' ? deps.getAIConfig : (() => null);
    const flash = deps.flash || (() => {});
    const openGroupTab = deps.openGroupTab || null;
    const getWorkspace = deps.getWorkspace || (() => '');

    // groupId → {meta, messages, events, loaded}
    const groups = new Map();
    let listMode = 'sessions';
    let initPromise = null;
    const listeners = new Set();

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function notify() {
        const snap = snapshot();
        for (const fn of listeners) {
            try {
                fn(snap);
            } catch (e) {
                console.error('群聊订阅回调失败', e);
            }
        }
    }

    function snapshot() {
        return {listMode, groups: groupList()};
    }

    function groupList() {
        return [...groups.values()].map((g) => g.meta).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    async function refreshList() {
        const metas = await store.list();
        const seen = new Set();
        for (const raw of metas || []) {
            let meta = null;
            try {
                meta = normalizeGroupMeta(JSON.parse(raw));
            } catch (e) {
                continue; // 坏 meta 跳过（正文 header 兜底由 Go 侧 synthesize 完成）
            }
            if (!meta.id) continue;
            seen.add(meta.id);
            const existing = groups.get(meta.id);
            if (existing) {
                existing.meta = {...existing.meta, ...meta, updatedAt: Math.max(existing.meta.updatedAt || 0, meta.updatedAt || 0)};
            } else {
                groups.set(meta.id, {meta, messages: [], events: [], loaded: false});
            }
        }
        for (const id of [...groups.keys()]) {
            if (!seen.has(id)) groups.delete(id);
        }
        notify();
    }

    function init() {
        if (initPromise) return initPromise;
        initPromise = refreshList().catch((e) => {
            flash('群聊列表加载失败：' + ((e && e.message) || e), true);
        });
        return initPromise;
    }

    function setListMode(mode) {
        if (mode !== 'sessions' && mode !== 'groups') return;
        if (listMode === mode) return;
        listMode = mode;
        notify();
    }

    async function ensureLoaded(id) {
        const g = groups.get(id);
        if (!g || g.loaded) return g;
        const text = await store.read(id);
        const replay = replayGroupLog(text);
        g.messages = replay.messages;
        g.events = replay.events;
        g.loaded = true;
        return g;
    }

    async function openGroup(id) {
        const g = groups.get(id);
        if (!g) return null;
        try {
            await ensureLoaded(id);
        } catch (e) {
            flash('群聊记录读取失败：' + ((e && e.message) || e), true);
            return null;
        }
        if (openGroupTab) openGroupTab({groupId: id, title: g.meta.title});
        return g;
    }

    function agentsOf(config) {
        return (config && Array.isArray(config.agents)) ? config.agents : [];
    }

    // 创建群聊：spec = {title, topic, goal, memberIds, chair, maxRounds, timeoutPreset}
    // chair = {kind, agentId, policy}；模型 ref 从成员/主持人智能体推导（kind=ai）。
    async function createGroup(spec) {
        const source = spec && typeof spec === 'object' ? spec : {};
        const config = getAIConfig();
        const agents = agentsOf(config);
        const memberIds = (Array.isArray(source.memberIds) ? source.memberIds : [])
            .filter((id) => agents.some((agent) => agent && agent.id === id && agent.enabled));
        if (memberIds.length < GROUP_MEMBER_MIN) {
            return {ok: false, error: '至少选择 ' + GROUP_MEMBER_MIN + ' 位可用成员'};
        }
        if (memberIds.length > GROUP_MEMBER_MAX) {
            return {ok: false, error: '最多 ' + GROUP_MEMBER_MAX + ' 位成员'};
        }
        const chairSpec = {...(source.chair && typeof source.chair === 'object' ? source.chair : {})};
        if (chairSpec.kind === 'ai') {
            const chairAgent = agents.find((agent) => agent && agent.id === chairSpec.agentId);
            if (!chairAgent) return {ok: false, error: '主持人智能体不可用，请重新选择'};
            chairSpec.modelRef = chairAgent.modelRef;
        } else if (chairSpec.kind === 'member') {
            if (!memberIds.includes(chairSpec.agentId)) return {ok: false, error: '兼任主持人必须是群成员'};
            chairSpec.modelRef = '';
        } else {
            chairSpec.kind = 'user';
            chairSpec.agentId = '';
            chairSpec.modelRef = '';
        }
        const preset = source.timeoutPreset === 'lenient' ? TIMEOUT_PRESETS.lenient : TIMEOUT_PRESETS.standard;
        const id = aiNowId('group-');
        const meta = normalizeGroupMeta({
            id,
            title: source.title || '未命名群聊',
            topic: source.topic || '',
            goal: source.goal,
            memberIds,
            mode: 'roundtable',
            chair: normalizeChair(chairSpec),
            maxRounds: source.maxRounds,
            roundMode: 'sequential',
            timeouts: preset.timeouts,
            workspace: getWorkspace() || '',
        });
        meta.updatedAt = Date.now();
        try {
            await store.writeMeta(id, JSON.stringify(meta));
            await store.append(id, groupHeaderLine(meta) + '\n');
        } catch (e) {
            return {ok: false, error: '群聊创建失败：' + ((e && e.message) || e)};
        }
        groups.set(id, {meta, messages: [], events: [], loaded: true});
        notify();
        if (openGroupTab) openGroupTab({groupId: id, title: meta.title});
        return {ok: true, id};
    }

    async function deleteGroup(id) {
        try {
            await store.remove(id);
        } catch (e) {
            flash('删除群聊失败：' + ((e && e.message) || e), true);
            return {ok: false};
        }
        groups.delete(id);
        notify();
        return {ok: true};
    }

    // meta 就地更新并落盘（讨论推进 / 看板 / 纪要共用；updatedAt 由这里统一抬）。
    async function saveMeta(id, mutator) {
        const g = groups.get(id);
        if (!g) return;
        if (typeof mutator === 'function') mutator(g.meta);
        g.meta.updatedAt = Date.now();
        try {
            await store.writeMeta(id, JSON.stringify(g.meta));
        } catch (e) {
            flash('群聊状态保存失败：' + ((e && e.message) || e), true);
        }
        notify();
    }

    // ai-* 流事件入口（main.js 转发）：G1 阶段群聊不发起请求，事件一律不属于群
    // roundId 命名空间，直接忽略；G2 在这里按 payload.id 前缀认领。
    function handleEvent(name, payload) {
        void name;
        void payload;
    }

    return {
        init,
        refreshList,
        setListMode,
        getListMode: () => listMode,
        groupList,
        groupById: (id) => groups.get(id) || null,
        openGroup,
        createGroup,
        deleteGroup,
        saveMeta,
        subscribe,
        handleEvent,
        store,
    };
}
