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
  textMax: 500,
  blockTitleMax: 60,
  imagesPerItem: 6,
};

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

// addItem 加条目。blockId 为空取第一个块；没有任何块时自动建「待办」块兜底。
// opts: {status, position: 'top'|'bottom', allowEmpty}——allowEmpty 仅供 UI 的新建行
// （提交空则删行），AI 工具不走这条通路。
export function addItem(doc, blockId, text, opts) {
  const value = clampStr(text, MEMO_LIMITS.textMax);
  if (!value.trim() && !(opts && opts.allowEmpty)) return {ok: false, error: '条目内容为空'};
  const status = opts && isMemoStatus(opts.status) ? opts.status : 'pending';
  const position = opts && opts.position === 'top' ? 'top' : 'bottom';
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
  const item = {
    id: memoId('it'),
    text: value,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    images: [],
  };
  if (position === 'top') block.items.unshift(item);
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
      block.collapsed = typeof patch.collapsed === 'boolean' ? patch.collapsed : block.collapsed;
    }
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
  stamp(next);
  return {ok: true, doc: next};
}

// removeImageById 从条目上摘掉一张贴图引用（图片文件留在磁盘，存储清理页兜底孤儿）。
export function removeImageById(doc, itemId, rel) {
  const found = findItem(doc, itemId);
  if (!found) return {ok: false, error: '找不到条目 ' + itemId};
  if (!found.item.images.includes(rel)) return {ok: false, error: '条目上没有贴图 ' + rel};
  const next = cloneDoc(doc);
  const item = findItem(next, itemId).item;
  item.images = item.images.filter((p) => p !== rel);
  item.updatedAt = Date.now();
  stamp(next);
  return {ok: true, doc: next};
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
export function formatMemoForAI(doc, scopeLabel) {
  const t = totalsOf(doc);
  if (!t.items && !t.blocks) {
    return (scopeLabel || '面板') + ' 是空的：还没有任何分组或条目。';
  }
  const lines = [(scopeLabel || '面板') + ' 共 ' + t.blocks + ' 块 ' + t.items +
    ' 项（完成 ' + t.done + ' / 进行中 ' + t.doing + ' / 待办 ' + t.pending + '）'];
  doc.blocks.forEach((block, bi) => {
    lines.push('# [' + block.id + '] ' + (bi + 1) + '. ' + block.title +
      (block.collapsed ? '（已折叠）' : '') + '：' + block.items.length + ' 项');
    for (const item of block.items) {
      const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
      const imgs = item.images.length ? '（贴图 ' + item.images.length + ' 张：' + item.images.join('、') + '）' : '';
      lines.push('  ' + mark + ' [' + item.id + '] ' + item.text + imgs);
    }
  });
  return lines.join('\n');
}
