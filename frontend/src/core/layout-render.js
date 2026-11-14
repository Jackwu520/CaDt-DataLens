// layout-render.js：```graph 关系图自动布局（ELK）→ 静态 SVG（方案阶段 6）。
// 模型只给「节点 + 边」纯 JSON，坐标交给引擎；产物是静态 SVG，仍走 sanitize → Shadow DOM 管线。
// ELK 1.57 MiB 懒加载；实例复用仅限成功路径——Promise.race 超时后 worker 任务无法取消，
// 必须弃用该实例下次重建。ELK 不可用或超时退化为简单分层兜底布局。

import {resolveThemeColors} from './visual-spec.js';
import {createLruCache} from './render-cache.js';

export const GRAPH_LIMITS = {maxNodes: 150, maxEdges: 300, timeoutMs: 3000};
const ALGORITHMS = new Set(['layered', 'force', 'stress']);

const cache = createLruCache(30);

// validateGraphSpec 校验 ```graph 的 JSON（纯函数，供测试）。
// 节点必须有唯一非空 id；edges 的 from/to 指向不存在的 id 时丢弃该边（记入 dropped）而非整体失败。
export function validateGraphSpec(text) {
    let spec;
    try {
        spec = JSON.parse(String(text || ''));
    } catch (e) {
        return {ok: false, error: 'graph 不是合法 JSON：' + ((e && e.message) || e)};
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return {ok: false, error: 'graph 必须是 JSON 对象'};
    }
    if (!Array.isArray(spec.nodes) || !spec.nodes.length) {
        return {ok: false, error: 'nodes 必须是非空数组'};
    }
    if (spec.nodes.length > GRAPH_LIMITS.maxNodes) {
        return {ok: false, error: '节点超过上限（' + GRAPH_LIMITS.maxNodes + '）'};
    }
    const ids = new Set();
    const nodes = [];
    for (const raw of spec.nodes) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) {
            return {ok: false, error: '每个节点都要有非空字符串 id'};
        }
        if (ids.has(raw.id)) return {ok: false, error: '节点 id 重复：' + raw.id};
        ids.add(raw.id);
        nodes.push({id: raw.id, label: typeof raw.label === 'string' ? raw.label : raw.id});
    }
    const edges = [];
    let dropped = 0;
    const rawEdges = Array.isArray(spec.edges) ? spec.edges : [];
    if (rawEdges.length > GRAPH_LIMITS.maxEdges) {
        return {ok: false, error: '边超过上限（' + GRAPH_LIMITS.maxEdges + '）'};
    }
    for (const raw of rawEdges) {
        if (!raw || typeof raw !== 'object') { dropped++; continue; }
        const from = typeof raw.from === 'string' ? raw.from : raw.source;
        const to = typeof raw.to === 'string' ? raw.to : raw.target;
        if (!ids.has(from) || !ids.has(to) || from === to) { dropped++; continue; }
        edges.push({from, to, label: typeof raw.label === 'string' ? raw.label : ''});
    }
    const algorithm = ALGORITHMS.has(spec.algorithm) ? spec.algorithm : 'layered';
    return {ok: true, spec: {nodes, edges, algorithm, dropped}};
}

// 节点尺寸按标签估宽：一行中文按 ~13px/字、ASCII ~7.2px/字，加内边距；宽高给出上下限。
function measureNode(label) {
    let units = 0;
    for (const ch of String(label)) units += /[\u2E80-\uFFFD]/.test(ch) ? 1.8 : 1;
    const width = Math.max(64, Math.min(220, Math.round(units * 7.4) + 26));
    return {width, height: 34};
}

// simpleLayeredLayout 简单分层兜底（纯函数）：无入边的节点放第一层，其后按邻接逐层下推；
// 有环时（全部有入边）从首个节点 BFS。列内纵向排列。
export function simpleLayeredLayout(spec) {
    const incoming = new Map(spec.nodes.map((n) => [n.id, 0]));
    const adj = new Map(spec.nodes.map((n) => [n.id, []]));
    for (const e of spec.edges) {
        incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
        adj.get(e.from).push(e.to);
    }
    const level = new Map();
    const queue = [];
    for (const n of spec.nodes) {
        if ((incoming.get(n.id) || 0) === 0) { level.set(n.id, 0); queue.push(n.id); }
    }
    if (!queue.length) { level.set(spec.nodes[0].id, 0); queue.push(spec.nodes[0].id); }
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        for (const next of adj.get(id)) {
            if (!level.has(next)) { level.set(next, level.get(id) + 1); queue.push(next); }
        }
    }
    // 无环但不在队列的孤立点：逐个补层
    for (const n of spec.nodes) if (!level.has(n.id)) level.set(n.id, 0);
    const columns = new Map();
    for (const n of spec.nodes) {
        const lv = level.get(n.id);
        if (!columns.has(lv)) columns.set(lv, []);
        columns.get(lv).push(n);
    }
    const positions = new Map();
    const edgePaths = [];
    for (const n of spec.nodes) {
        const size = measureNode(n.label);
        positions.set(n.id, {size, level: level.get(n.id)});
    }
    return {columns, positions, edgePaths, edges: spec.edges};
}

// assembleGraphSvg 把布局结果拼成静态 SVG（纯函数，供测试）。
// positions: Map id → {x, y, width, height}；edgePaths: [{from,to,points:[{x,y}..]}]。
export function assembleGraphSvg(spec, positions, edgePaths, colors) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of positions.values()) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + p.width); maxY = Math.max(maxY, p.y + p.height);
    }
    for (const e of edgePaths) {
        for (const pt of e.points) {
            minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
            maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
        }
    }
    const pad = 14;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + minX + ' ' + minY + ' ' +
        (maxX - minX) + ' ' + (maxY - minY) + '" role="img" aria-label="关系图：' +
        spec.nodes.length + ' 节点 ' + spec.edges.length + ' 边">');
    parts.push('<title>关系图（' + spec.algorithm + ' 布局）</title>');
    parts.push('<defs><marker id="gw-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path d="M0 0 10 5 0 10z" fill="' + colors.muted + '"/></marker></defs>');
    for (const e of edgePaths) {
        const d = e.points.map((pt, i) => (i ? 'L' : 'M') + Math.round(pt.x) + ' ' + Math.round(pt.y)).join(' ');
        parts.push('<path d="' + d + '" fill="none" stroke="' + colors.muted + '" stroke-width="1.4" marker-end="url(#gw-ar)"/>');
        if (e.label) {
            const mid = e.points[Math.floor(e.points.length / 2)] || e.points[0];
            parts.push('<text x="' + Math.round(mid.x) + '" y="' + Math.round(mid.y - 5) +
                '" font-size="10" text-anchor="middle" fill="' + colors.muted + '">' +
                escapeText(e.label) + '</text>');
        }
    }
    for (const n of spec.nodes) {
        const p = positions.get(n.id);
        if (!p) continue;
        parts.push('<rect x="' + Math.round(p.x) + '" y="' + Math.round(p.y) +
            '" width="' + Math.round(p.width) + '" height="' + Math.round(p.height) +
            '" rx="8" fill="' + colors.panel2 + '" stroke="' + colors.border + '" stroke-width="1.2"/>');
        parts.push('<text x="' + Math.round(p.x + p.width / 2) + '" y="' + Math.round(p.y + p.height / 2 + 4.5) +
            '" font-size="12" text-anchor="middle" fill="' + colors.text + '">' + escapeText(n.label) + '</text>');
    }
    parts.push('</svg>');
    return parts.join('');
}

function escapeText(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let elkInstance = null;
let elkLoadPromise = null;

function ensureElk() {
    if (elkInstance) return Promise.resolve(elkInstance);
    if (elkLoadPromise) return elkLoadPromise;
    elkLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/elk/elk.bundled.js';
        script.onload = () => {
            const ElkCtor = window.ELK || (window.elk && window.elk.ELK);
            if (!ElkCtor) {
                elkLoadPromise = null;
                reject(new Error('ELK 库加载失败'));
                return;
            }
            elkInstance = new ElkCtor();
            resolve(elkInstance);
        };
        script.onerror = () => {
            elkLoadPromise = null;
            reject(new Error('ELK 库加载失败'));
        };
        document.head.appendChild(script);
    });
    return elkLoadPromise;
}

// runElkLayout 调 ELK 布局；超时弃实例（worker 任务无法取消）并抛错，由调用方走兜底。
async function runElkLayout(spec, sizes) {
    const elk = await ensureElk();
    const options = {'elk.spacing.nodeNode': '28'};
    if (spec.algorithm === 'layered') {
        options['elk.algorithm'] = 'layered';
        options['elk.layered.spacing.nodeNodeBetweenLayers'] = '44';
        options['elk.edgeRouting'] = 'ORTHOGONAL';
    } else {
        options['elk.algorithm'] = spec.algorithm;
    }
    const graph = {
        id: 'root',
        layoutOptions: options,
        children: spec.nodes.map((n) => ({id: n.id, width: sizes.get(n.id).width, height: sizes.get(n.id).height})),
        edges: spec.edges.map((e, i) => ({id: 'e' + i, sources: [e.from], targets: [e.to]})),
    };
    const result = await Promise.race([
        elk.layout(graph),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ELK 布局超时')), GRAPH_LIMITS.timeoutMs)),
    ]);
    const positions = new Map();
    for (const child of result.children || []) {
        const size = sizes.get(child.id);
        positions.set(child.id, {x: child.x, y: child.y, width: child.width || size.width, height: child.height || size.height});
    }
    const edgePaths = [];
    for (const edge of result.edges || []) {
        const section = edge.sections && edge.sections[0];
        if (!section) continue;
        const points = [section.startPoint].concat(section.bendPoints || [], [section.endPoint])
            .filter(Boolean).map((pt) => ({x: pt.x, y: pt.y}));
        const specEdge = spec.edges[Number(String(edge.id).slice(1))] || {};
        edgePaths.push({from: specEdge.from, to: specEdge.to, label: specEdge.label, points});
    }
    return {positions, edgePaths};
}

// renderGraphToSvg：校验 → 布局（ELK，失败/超时退简单分层）→ 拼静态 SVG。
export async function renderGraphToSvg(code, themeId) {
    const {ok, spec, error} = validateGraphSpec(code);
    if (!ok) throw new Error(error);
    const cacheKey = (themeId || '') + ':' + code;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const sizes = new Map();
    for (const n of spec.nodes) sizes.set(n.id, measureNode(n.label));
    let positions;
    let edgePaths;
    try {
        const layout = await runElkLayout(spec, sizes);
        positions = layout.positions;
        edgePaths = layout.edgePaths;
        // ELK 结果缺节点（理论不该发生）时退兜底
        if (positions.size !== spec.nodes.length) throw new Error('ELK 结果不完整');
    } catch (e) {
        if (e && /超时/.test(e.message)) elkInstance = null; // 超时弃实例，复用只限成功路径
        const fallback = simpleLayeredLayout(spec);
        positions = new Map();
        edgePaths = [];
        const COL_GAP = 56;
        const ROW_GAP = 26;
        let colX = 24;
        for (const [, colNodes] of fallback.columns) {
            let y = 24;
            let colWidth = 0;
            // 同层节点纵向排，层间横向排
            for (const n of colNodes) {
                const size = sizes.get(n.id);
                positions.set(n.id, {x: colX, y, width: size.width, height: size.height});
                y += size.height + ROW_GAP;
                colWidth = Math.max(colWidth, size.width);
            }
            colX += colWidth + COL_GAP;
        }
        for (const e of spec.edges) {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) continue;
            edgePaths.push({from: e.from, to: e.to, label: e.label, points: [
                {x: a.x + a.width, y: a.y + a.height / 2},
                {x: b.x, y: b.y + b.height / 2},
            ]});
        }
    }
    const colors = resolveThemeColors();
    const svg = assembleGraphSvg(spec, positions, edgePaths, colors);
    if (/<script/i.test(svg)) throw new Error('布局产物包含脚本，已拒绝');
    cache.set(cacheKey, svg);
    return svg;
}
