// memo-model.js：快捷便签的纯数据层——结构常量、归一化与增删改移纯函数。
// 用户编辑（bridge-todo-view.js）与 AI 工具（ai-panel.js 经 store 转发）共用同一套
// 变更函数，保证两条路径走同一条上限校验与 id 生成。变更函数一律返回
// {ok, doc?, id?, error?}，不抛异常——工具路径要把失败原因原样回给模型。

export const MEMO_STATUSES = ['pending', 'in_progress', 'completed'];
export const DEFAULT_BLOCK_TITLE = '便签';

export const MEMO_LIMITS = {
  blocks: 50,
  itemsPerBlock: 100,
  itemsTotal: 300,
  textMax: 100000, // 便签按长笔记用（报错栈/配置/长文），放宽到 10 万字符；保留兜底防极端超大内容
  blockTitleMax: 60,
  imagesPerItem: 6,
};

// 超长条目默认折叠的高度估算常量（与 .memo-item-text 的 12.5px×1.6 行高对齐）。
const MEMO_ITEM_LINE_HEIGHT = 20;
const MEMO_ITEM_CHARS_PER_LINE = 60; // 便签面板较窄，保守按每行 60 字估算

// memoItemFoldHeight 估算条目文本的渲染高度（px）：按换行 + 每行字数折行累加。
// 纯函数、不依赖 DOM，便于单测；视图拿它和 memo-body 可视高度比对决定是否折叠。
export function memoItemFoldHeight(text) {
  const lines = String(text == null ? '' : text).split('\n');
  let renderedLines = 0;
  for (const line of lines) {
    renderedLines += Math.max(1, Math.ceil(line.length / MEMO_ITEM_CHARS_PER_LINE));
  }
  return renderedLines * MEMO_ITEM_LINE_HEIGHT;
}

// shouldFoldMemoItem 超过 1 个视窗高度才折叠（viewportHeight 传 memo-body 的 clientHeight）。
export function shouldFoldMemoItem(text, viewportHeight) {
  if (!text) return false;
  const vh = Number(viewportHeight) > 0 ? Number(viewportHeight) : 600;
  return memoItemFoldHeight(text) > vh;
}

let idSeq = 0;

// memoId 纳秒时间戳 + 短自增，页面内重复调用也不会撞（前缀区分块/条目）。
export function memoId(prefix) {
  idSeq = (idSeq + 1) & 0xffff;
  return prefix + '-' + Date.now().toString(36) + '-' + idSeq.toString(36);
}

export function defaultMemoData() {
  return {version: 1, updatedAt: 0, blocks: []};
}

export function isMemoStatus(v) {
  return MEMO_STATUSES.includes(v);
}

// cycleStatus 状态点点击循环：pending → in_progress → completed → pending。
export function cycleStatus(status) {
  const idx = MEMO_STATUSES.indexOf(status);
  return MEMO_STATUSES[(idx + 1) % MEMO_STATUSES.length];
}

const clampStr = (v, max) => String(v == null ? '' : v).slice(0, max);

// normalizeMemoData 把任意输入修成合法结构：缺字段补默认、超限截断、状态枚举纠正。
// 手改坏/旧版本的数据也能安全打开。
export function normalizeMemoData(raw) {
  const doc = defaultMemoData();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) return doc;
  const blocks = [];
  for (const rawBlock of raw.blocks.slice(0, MEMO_LIMITS.blocks)) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    const block = {
      id: typeof rawBlock.id === 'string' && rawBlock.id ? rawBlock.id : memoId('blk'),
      title: clampStr(rawBlock.title || DEFAULT_BLOCK_TITLE, MEMO_LIMITS.blockTitleMax) || DEFAULT_BLOCK_TITLE,
      collapsed: rawBlock.collapsed === true,
      items: [],
    };
    for (const rawItem of (Array.isArray(rawBlock.items) ? rawBlock.items : []).slice(0, MEMO_LIMITS.itemsPerBlock)) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const images = (Array.isArray(rawItem.images) ? rawItem.images : [])
        .filter((p) => typeof p === 'string' && p)
        .slice(0, MEMO_LIMITS.imagesPerItem);
      block.items.push({
        id: typeof rawItem.id === 'string' && rawItem.id ? rawItem.id : memoId('it'),
        text: clampStr(rawItem.text, MEMO_LIMITS.textMax),
        kind: rawItem.kind === 'md' ? 'md' : 'text',
        status: isMemoStatus(rawItem.status) ? rawItem.status : 'pending',
        createdAt: Number(rawItem.createdAt) || 0,
        updatedAt: Number(rawItem.updatedAt) || 0,
        images,
      });
    }
    blocks.push(block);
  }
  doc.blocks = blocks;
  doc.updatedAt = Number(raw.updatedAt) || 0;
  return doc;
}

// parseMemoDoc JSON 解析 + 归一化；解析失败返回默认结构（坏数据不影响面板打开）。
export function parseMemoDoc(text) {
  let raw = null;
  try {
    raw = JSON.parse(String(text || ''));
  } catch (e) {
    return defaultMemoData();
  }
  return normalizeMemoData(raw);
}

// findItem 在 doc 里定位条目，返回 {item, block, itemIndex, blockIndex} 或 null。
export function findItem(doc, itemId) {
  for (let bi = 0; bi < doc.blocks.length; bi++) {
    const block = doc.blocks[bi];
    const ii = block.items.findIndex((it) => it.id === itemId);
    if (ii >= 0) return {item: block.items[ii], block, itemIndex: ii, blockIndex: bi};
  }
  return null;
}

function cloneDoc(doc) {
  return normalizeMemoData(JSON.parse(JSON.stringify(doc)));
}

function stamp(doc) {
  doc.updatedAt = Date.now();
}

// totalsOf 汇总计数（头部摘要与 AI 反馈共用）。
export function totalsOf(doc) {
  let items = 0, done = 0, doing = 0;
  for (const block of doc.blocks) {
    for (const item of block.items) {
      items++;
      if (item.status === 'completed') done++;
      else if (item.status === 'in_progress') doing++;
    }
  }
  return {blocks: doc.blocks.length, items, done, doing, pending: items - done - doing};
}

// addBlock 新建分组小节；title 空则用「新建分组」。
export function addBlock(doc, title) {
  if (doc.blocks.length >= MEMO_LIMITS.blocks) {
    return {ok: false, error: '块数已达上限 ' + MEMO_LIMITS.blocks};
  }
  const next = cloneDoc(doc);
  const block = {
    id: memoId('blk'),
    title: (clampStr(title, MEMO_LIMITS.blockTitleMax) || '新建分组'),
    collapsed: false,
    items: [],
  };
  next.blocks.push(block);
  stamp(next);
  return {ok: true, doc: next, id: block.id};
}

// addItem 加条目。blockId 为空取第一个块；没有任何块时自动建「便签」块兜底。
// opts: {status, kind: 'text'|'md', position: 'top'|'bottom', afterId, allowEmpty}
// afterId：插到该条目之后（工具栏「正在编辑某条目时点新建」的智能插入）；优先于 position。
// allowEmpty 仅供 UI 的新建行（提交空则删行），AI 工具不走这条通路。
export function addItem(doc, blockId, text, opts) {
  const value = clampStr(text, MEMO_LIMITS.textMax);
  if (!value.trim() && !(opts && opts.allowEmpty)) return {ok: false, error: '条目内容为空'};
  const status = opts && isMemoStatus(opts.status) ? opts.status : 'pending';
  const kind = opts && opts.kind === 'md' ? 'md' : 'text';
  const position = opts && opts.position === 'top' ? 'top' : 'bottom';
  const afterId = opts && typeof opts.afterId === 'string' ? opts.afterId : '';
  const next = cloneDoc(doc);
  let block = blockId ? next.blocks.find((b) => b.id === blockId) : null;
  if (!block && blockId) return {ok: false, error: '找不到块 ' + blockId};
  if (!block) {
    if (next.blocks.length >= MEMO_LIMITS.blocks) {
      return {ok: false, error: '块数已达上限 ' + MEMO_LIMITS.blocks};
    }
    block = {id: memoId('blk'), title: DEFAULT_BLOCK_TITLE, collapsed: false, items: []};
    next.blocks.push(block);
  }
  if (block.items.length >= MEMO_LIMITS.itemsPerBlock) {
    return {ok: false, error: '该块已有 ' + MEMO_LIMITS.itemsPerBlock + ' 项，已达上限'};
  }
  // 往折叠块加条目时自动展开——否则新条目藏在折叠里，用户以为没加上。
  block.collapsed = false;
  const item = {
    id: memoId('it'),
    text: value,
    kind,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    images: [],
  };
  const ai = afterId ? block.items.findIndex((it) => it.id === afterId) : -1;
  if (ai >= 0) block.items.splice(ai + 1, 0, item);
  else if (position === 'top') block.items.unshift(item);
  else block.items.push(item);
  stamp(next);
  return {ok: true, doc: next, id: item.id, blockId: block.id};
}

// updateById 单参数入口（AI 的 app_control update_memo 动作与 UI 的就地编辑共用）：
// id 命中条目 → text/status/index 作用于条目；命中块 → text 当作块标题、index 当块位置。
export function updateById(doc, id, patch) {
  if (!id) return {ok: false, error: '缺少 id'};
  const next = cloneDoc(doc);
  const block = next.blocks.find((b) => b.id === id);
  if (block) {
    if (patch.status && isMemoStatus(patch.status)) {
      return {ok: false, error: id + ' 是块（分组小节），没有状态；要改条目请传条目 id'};
    }
    if (typeof patch.text === 'string') {
      if (!patch.text.trim()) return {ok: false, error: '块标题不能为空'};
      block.title = clampStr(patch.text, MEMO_LIMITS.blockTitleMax);
    }
    if (typeof patch.collapsed === 'boolean') block.collapsed = patch.collapsed;
    if (Number.isFinite(patch.index)) moveInArray(next.blocks, block, patch.index);
    stamp(next);
    return {ok: true, doc: next, kind: 'block'};
  }
  const found = findItem(next, id);
  if (!found) return {ok: false, error: '找不到条目或块 ' + id};
  if (typeof patch.text === 'string') {
    if (!patch.text.trim()) return {ok: false, error: '条目内容不能为空'};
    found.item.text = clampStr(patch.text, MEMO_LIMITS.textMax);
    found.item.updatedAt = Date.now();
  }
  if (patch.status != null) {
    if (!isMemoStatus(patch.status)) {
      return {ok: false, error: 'status 只支持 pending / in_progress / completed'};
    }
    found.item.status = patch.status;
    found.item.updatedAt = Date.now();
  }
  if (Number.isFinite(patch.index)) {
    moveInArray(found.block.items, found.item, patch.index);
  }
  stamp(next);
  return {ok: true, doc: next, kind: 'item'};
}

// removeById 按 id 删条目或块（块连带全部条目）。返回被删贴图引用，供调用方决定
// 是否清理（v1 不清理，孤儿图由存储清理页兜底）。
export function removeById(doc, id) {
  if (!id) return {ok: false, error: '缺少 id'};
  const next = cloneDoc(doc);
  const blockIndex = next.blocks.findIndex((b) => b.id === id);
  if (blockIndex >= 0) {
    const removed = next.blocks.splice(blockIndex, 1)[0];
    stamp(next);
    return {ok: true, doc: next, removedImages: removed.items.flatMap((it) => it.images), removedItems: removed.items.length};
  }
  for (const block of next.blocks) {
    const ii = block.items.findIndex((it) => it.id === id);
    if (ii >= 0) {
      const [removed] = block.items.splice(ii, 1);
      stamp(next);
      return {ok: true, doc: next, removedImages: removed.images.slice(), removedItems: 1};
    }
  }
  return {ok: false, error: '找不到条目或块 ' + id};
}

// moveItemToBlock 把条目挪到另一个块（UI「移到块」菜单用；AI 面不做跨块移动）。
export function moveItemToBlock(doc, itemId, targetBlockId) {
  const found = findItem(doc, itemId);
  if (!found) return {ok: false, error: '找不到条目 ' + itemId};
  const target = doc.blocks.find((b) => b.id === targetBlockId);
  if (!target) return {ok: false, error: '找不到目标块 ' + targetBlockId};
  if (target.id === found.block.id) return {ok: true, doc};
  if (target.items.length >= MEMO_LIMITS.itemsPerBlock) {
    return {ok: false, error: '目标块已有 ' + MEMO_LIMITS.itemsPerBlock + ' 项，已达上限'};
  }
  const next = cloneDoc(doc);
  const src = findItem(next, itemId);
  const dst = next.blocks.find((b) => b.id === targetBlockId);
  src.block.items.splice(src.itemIndex, 1);
  dst.items.push(src.item);
  dst.collapsed = false; // 移到折叠块同样展开，保证条目可见
  stamp(next);
  return {ok: true, doc: next};
}

// removeImageById 从条目上摘掉一张贴图引用；removedImages 回传给 store——保存成功后
// 按最新文档 GC（不再被引用才删文件进回收站，见 memo-store 的 gcImages）。
export function removeImageById(doc, itemId, rel) {
  const found = findItem(doc, itemId);
  if (!found) return {ok: false, error: '找不到条目 ' + itemId};
  if (!found.item.images.includes(rel)) return {ok: false, error: '条目上没有贴图 ' + rel};
  const next = cloneDoc(doc);
  const item = findItem(next, itemId).item;
  item.images = item.images.filter((p) => p !== rel);
  item.updatedAt = Date.now();
  stamp(next);
  return {ok: true, doc: next, removedImages: [rel]};
}

// attachImage 给条目追加贴图引用（落盘成功后调用）。ref 形如 img/xxx.png。
export function attachImage(doc, itemId, ref) {
  const found = findItem(doc, itemId);
  if (!found) return {ok: false, error: '找不到条目 ' + itemId};
  if (found.item.images.length >= MEMO_LIMITS.imagesPerItem) {
    return {ok: false, error: '该条目贴图已达 ' + MEMO_LIMITS.imagesPerItem + ' 张上限'};
  }
  const next = cloneDoc(doc);
  const item = findItem(next, itemId).item;
  item.images.push(String(ref));
  item.updatedAt = Date.now();
  stamp(next);
  return {ok: true, doc: next};
}

function moveInArray(arr, element, index) {
  const from = arr.indexOf(element);
  const to = Math.max(0, Math.min(arr.length - 1, Math.floor(index)));
  if (from === to || from < 0) return;
  arr.splice(from, 1);
  arr.splice(to, 0, element);
}

// formatMemoForAI 面板内容转给模型看的紧凑文本（id 一并给出，供后续 update/remove）。
// filter 可选：{blockId?, status?, q?}——按分组 / 状态 / 文本包含过滤；首行永远汇报
// 全局面板计数（模型不丢全局视野），过滤时注明条件与本次命中数。
export function formatMemoForAI(doc, scopeLabel, filter) {
  const t = totalsOf(doc);
  if (!t.items && !t.blocks) {
    return (scopeLabel || '面板') + ' 是空的：还没有任何分组或条目。';
  }
  const f = filter || {};
  const q = typeof f.q === 'string' ? f.q.trim().toLowerCase() : '';
  const matchQ = (text) => !q || String(text || '').toLowerCase().indexOf(q) >= 0;
  const statusOk = (st) => !f.status || f.status === st;
  let shown = 0;
  const lines = [(scopeLabel || '面板') + ' 共 ' + t.blocks + ' 块 ' + t.items +
    ' 项（完成 ' + t.done + ' / 进行中 ' + t.doing + ' / 待办 ' + t.pending + '）'];
  const filtersDesc = [
    f.blockId ? 'block=' + f.blockId : '',
    f.status ? 'status=' + f.status : '',
    q ? 'q=' + f.q.trim() : '',
  ].filter(Boolean);
  if (filtersDesc.length) lines.push('（本次按 ' + filtersDesc.join('，') + ' 过滤）');
  doc.blocks.forEach((block, bi) => {
    if (f.blockId && block.id !== f.blockId) return;
    const hits = block.items.filter((item) => statusOk(item.status) &&
      (matchQ(item.text) || item.images.some((rel) => matchQ(rel))));
    shown += hits.length;
    lines.push('# [' + block.id + '] ' + (bi + 1) + '. ' + block.title +
      (block.collapsed ? '（已折叠）' : '') + '：' +
      (filtersDesc.length ? hits.length + '/' + block.items.length + ' 项命中' : block.items.length + ' 项'));
    for (const item of hits) {
      const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
      const kindTag = item.kind === 'md' ? ' [md]' : '';
      const imgs = item.images.length ? '（贴图 ' + item.images.length + ' 张：' + item.images.join('、') + '）' : '';
      lines.push('  ' + mark + kindTag + ' [' + item.id + '] ' + item.text + imgs);
    }
  });
  if (filtersDesc.length) {
    lines.push(shown
      ? '以上 ' + shown + ' 项为过滤命中；其余 ' + (t.items - shown) + ' 项未显示。'
      : '没有匹配过滤条件的条目（面板总数不变：' + t.items + ' 项）。');
  }
  return lines.join('\n');
}

// ===== 内联贴图与导出 =====

// INLINE_IMAGE_RE 正文里的贴图占位符：![文件名](img/xxx.png)。粘贴进编辑框时插入，
// text 条目轻量渲染成内联图、md 条目由共享渲染器出图，导出按标准 Markdown 携带——
// 图片位置由此记录在正文流里（渲染与导出的共同依据）。
export const INLINE_IMAGE_RE = /!\[[^\]\n]*\]\((img\/[^)\s]+)\)/g;

// collectImageRefs 文档里全部贴图引用：item.images（缩略图挂载）+ 正文占位符。
// 贴图 GC 与导出共用这一份口径——正文里删掉占位符同样会触发文件回收。
export function collectImageRefs(doc) {
  const refs = new Set();
  for (const block of doc.blocks) {
    for (const item of block.items) {
      for (const rel of item.images) refs.add(rel);
      for (const m of String(item.text || '').matchAll(INLINE_IMAGE_RE)) refs.add(m[1]);
    }
  }
  return refs;
}

// exportMemoMarkdown 便签导出为 Markdown：文本条目 = 任务清单（勾选框，多行续行缩进），
// md 条目原样嵌入，缩略图与正文占位符统一成标准图片语法（含挂载在 item.images 上的）。
// images 返回全部被引用的相对路径（导出方负责把文件复制到旁侧 img/）。
export function exportMemoMarkdown(doc, scopeLabel) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const lines = ['# 快捷便签 · ' + (scopeLabel || ''), '', '- 导出时间：' + stamp, ''];
  const images = [];
  const noteImage = (rel) => {
    if (rel && !images.includes(rel)) images.push(rel);
  };
  const scanItem = (item) => {
    for (const rel of item.images) noteImage(rel);
    for (const m of String(item.text || '').matchAll(INLINE_IMAGE_RE)) noteImage(m[1]);
  };
  doc.blocks.forEach((block, bi) => {
    lines.push('', '## ' + (bi + 1) + '. ' + block.title, '');
    let hasList = false;
    for (const item of block.items) {
      if (item.kind === 'md') continue;
      scanItem(item);
      const mark = item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' ';
      const body = String(item.text || '').split('\n').join('\n  ');
      lines.push('- [' + mark + '] ' + (body || '（空）'));
      // 挂载在缩略图上、还没写进正文的贴图：以图片语法补进条目末尾
      for (const rel of item.images) {
        if (String(item.text || '').indexOf(rel) >= 0) continue;
        lines.push('  ![' + rel.split('/').pop() + '](' + rel + ')');
      }
      hasList = true;
    }
    for (const item of block.items) {
      if (item.kind !== 'md' || !item.text) continue;
      scanItem(item);
      if (hasList) lines.push('');
      lines.push(String(item.text), '');
    }
    if (!block.items.length) lines.push('（空）');
  });
  return {content: lines.join('\n') + '\n', images};
}
