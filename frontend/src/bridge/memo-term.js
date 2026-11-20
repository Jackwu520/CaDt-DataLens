// memo-term.js：快捷便签「终端条目」的运行时——条目正文是命令字符串，点运行按钮交给
// run.Runner.RunExec 通道执行（流式 run-out / run-exit、GBK 解码、120s 超时杀树、
// RunStop 手动停止）。输出是会话内存态：只存本模块的 Map，不写 memo.json——
// 重渲染（折叠/编辑/外部变更）从 Map 恢复，关面板（memoUnmount）停运行并清空。
// shell 跟随内置终端默认：pwsh → powershell 兜底（normalizeTermShell 同语义）；
// 命令字符串 → argv 的拼接是本模块纯函数 buildShellArgv。运行 id 固定 `memo-<itemId>`
// 前缀，与 F5 的 run-N-build/run 互不干扰（run.js 对未知 id 静默忽略）。
// 顶部纯函数不依赖 DOM/Wails，node:test 直接导入（memo-term.test.mjs）。
import {iconSvg} from '../core/icons.js';
import {whenAppEvents} from '../core/app-events.js';

export const TERM_TIMEOUT_MS = 120000; // 硬超时：不支持挂起任务（npm run dev 这类到点杀树）
export const TERM_MAX_LINES = 500;     // 输出块尾部保留行数（超出丢头部，Map 与 DOM 同步）
export const TERM_RUN_ID_PREFIX = 'memo-';

// buildShellArgv 命令字符串 → shell argv。shellName 是 ResolveRunShell 返回的 Name 字段
// （PowerShell 7 / Windows PowerShell / Git Bash / Command Prompt）。
// PowerShell 用 -Command（多行 = 多语句脚本）；GBK/UTF-8 输出由 run 通道 decodeRunOutput 兜底。
export function buildShellArgv(shellName, command) {
  const name = String(shellName || '');
  const cmd = String(command == null ? '' : command);
  if (name.indexOf('PowerShell') >= 0) {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd];
  }
  if (name.indexOf('Git Bash') >= 0) {
    return ['--login', '-c', cmd];
  }
  // 其余按 cmd 语义（Command Prompt / 未知兜底）
  return ['/d', '/s', '/c', cmd];
}

// trimTermLines 就地裁剪到尾部 max 行，返回丢掉的行数（0 = 没丢）。
export function trimTermLines(lines, max) {
  const cap = Math.max(1, Number(max) || 1);
  if (!Array.isArray(lines) || lines.length <= cap) return 0;
  const dropped = lines.length - cap;
  lines.splice(0, dropped);
  return dropped;
}

// formatTermDuration 时长格式化：1.25 s / 12.3 s / 2 m 05 s；非法输入（null/负数/NaN）返回 ''。
export function formatTermDuration(ms) {
  if (ms == null) return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 10000) return (n / 1000).toFixed(2) + ' s';
  if (n < 60000) return (n / 1000).toFixed(1) + ' s';
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return m + ' m ' + String(s).padStart(2, '0') + ' s';
}

// formatTermStatus 状态行文案：运行中给实时感（ startedAt 起算），终态给退出码与耗时；
// 输出被 500 行截断时追加提示（truncated）。
export function formatTermStatus(entry) {
  if (!entry) return '';
  const dur = (now) => formatTermDuration(Math.max(0, now - (entry.startedAt || now)));
  let text = '';
  switch (entry.state) {
    case 'running': {
      const t = dur(Date.now());
      text = t ? '运行中 ⋅ ' + t : '运行中';
      break;
    }
    case 'done':
      text = '完成 ⋅ 退出码 0' + (formatTermDuration(entry.durationMs) ? ' ⋅ ' + formatTermDuration(entry.durationMs) : '');
      break;
    case 'exit':
      text = '退出码 ' + entry.code + (formatTermDuration(entry.durationMs) ? ' ⋅ ' + formatTermDuration(entry.durationMs) : '');
      break;
    case 'timeout':
      text = '已超时终止（不支持挂起任务）' + (formatTermDuration(entry.durationMs) ? ' ⋅ ' + formatTermDuration(entry.durationMs) : '');
      break;
    case 'stopped':
      text = '已停止' + (formatTermDuration(entry.durationMs) ? ' ⋅ ' + formatTermDuration(entry.durationMs) : '');
      break;
    default:
      text = '';
  }
  return text + (entry.truncated ? '（输出已截断）' : '');
}

export function termRunId(itemId) {
  return TERM_RUN_ID_PREFIX + String(itemId);
}

export function createMemoTerm(deps) {
  // deps：{backend, flash, rt, normalizeTermText, findRow(itemId)->HTMLElement|null}
  // findRow 由 bridge-memo-view 提供（在 view.root 里查条目行）；活更新直接改 DOM、
  // 不整面板重渲染——流式期间可能正在编辑命令文本，整渲染会把行内编辑打掉。
  // termRuns: itemId → {state: 'running'|'done'|'exit'|'timeout'|'stopped', lines, code,
  //                     durationMs, startedAt, truncated, shell}
  const termRuns = new Map();

  // ===== 活更新（查不到行就跳过，整渲染自然从 Map 恢复） =====
  // ensureResultBlock 结果块就地创建（插入位置与 buildItem 一致：actions 之前）——
  // run() 建档后行内还没有这个块（整渲染才会画），流式 append 需要落点。
  function ensureResultBlock(row) {
    let box = row.querySelector('.memo-term-result');
    if (!box) {
      box = document.createElement('div');
      box.className = 'memo-term-result';
      const status = document.createElement('div');
      status.className = 'memo-term-status';
      const out = document.createElement('div');
      out.className = 'memo-term-out';
      box.append(status, out);
      const actions = row.querySelector('.memo-item-actions');
      if (actions) row.insertBefore(box, actions);
      else row.appendChild(box);
    }
    return box;
  }

  function removeResultBlock(itemId) {
    const row = deps.findRow ? deps.findRow(itemId) : null;
    const box = row && row.querySelector('.memo-term-result');
    if (box) box.remove();
  }

  function paintLive(itemId) {
    const row = deps.findRow ? deps.findRow(itemId) : null;
    if (!row) return;
    const entry = termRuns.get(itemId);
    const btn = row.querySelector('.memo-run-btn');
    if (btn) {
      const running = !!entry && entry.state === 'running';
      btn.innerHTML = iconSvg(running ? 'stop' : 'play', 12);
      btn.classList.toggle('running', running);
      btn.setAttribute('data-tip', running ? '停止运行' : (btn.dataset.cwdTip || '运行命令'));
    }
    if (entry) {
      const box = ensureResultBlock(row);
      const status = box.querySelector('.memo-term-status');
      status.textContent = formatTermStatus(entry);
      status.className = 'memo-term-status st-' + entry.state;
    }
  }

  function appendLiveLines(itemId, lines) {
    const row = deps.findRow ? deps.findRow(itemId) : null;
    const out = row && row.querySelector('.memo-term-out');
    if (!out) return;
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'memo-term-line' + (line.stream === 'err' ? ' err' : '');
      div.textContent = line.text;
      out.appendChild(div);
    }
    while (out.childElementCount > TERM_MAX_LINES) out.removeChild(out.firstElementChild);
    // 贴底滚动：仅当用户本来就停在输出块底部附近（跟 run.js 的 pinned 逻辑同款）
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 32;
    if (nearBottom) out.scrollTop = out.scrollHeight;
  }

  function resetLiveBlock(itemId) {
    const row = deps.findRow ? deps.findRow(itemId) : null;
    const out = row && row.querySelector('.memo-term-out');
    if (out) out.textContent = '';
  }

  // ===== 事件（run-out / run-exit，按 id 前缀过滤；run.js 对这些 id 不感知） =====
  function onRunOut(payload) {
    if (!payload || typeof payload.id !== 'string' || !payload.id.startsWith(TERM_RUN_ID_PREFIX)) return;
    const itemId = payload.id.slice(TERM_RUN_ID_PREFIX.length);
    const entry = termRuns.get(itemId);
    if (!entry || entry.state !== 'running') return;
    const raw = String(payload.data || '');
    const clean = deps.normalizeTermText ? deps.normalizeTermText(raw) : raw;
    if (!clean) return;
    const stream = payload.stream === 'err' ? 'err' : 'out';
    const incoming = clean.split('\n').map((text) => ({text, stream}));
    entry.lines.push(...incoming);
    if (trimTermLines(entry.lines, TERM_MAX_LINES)) entry.truncated = true;
    // DOM 的行数上限与 Map 的裁剪同口径：append 后把超限的旧行摘掉即可
    appendLiveLines(itemId, incoming);
  }

  function onRunExit(payload) {
    if (!payload || typeof payload.id !== 'string' || !payload.id.startsWith(TERM_RUN_ID_PREFIX)) return;
    const itemId = payload.id.slice(TERM_RUN_ID_PREFIX.length);
    const entry = termRuns.get(itemId);
    if (!entry) return;
    const code = Number(payload.code);
    const reason = payload.reason === 'timeout' ? 'timeout'
      : entry.state === 'stopped' ? 'stopped'
        : code === 0 ? 'done' : 'exit';
    entry.state = entry.state === 'running' ? reason : entry.state;
    entry.code = code;
    entry.durationMs = Number(payload.durationMs) || entry.durationMs;
    paintLive(itemId);
  }

  // 事件桥：宿主可注入（测试）；生产由 main.js 创建，经就绪队列注册。
  if (deps.appEvents) {
    deps.appEvents.onApp('run-out', onRunOut);
    deps.appEvents.onApp('run-exit', onRunExit);
  } else {
    whenAppEvents((bridge) => {
      bridge.onApp('run-out', onRunOut);
      bridge.onApp('run-exit', onRunExit);
    });
  }

  // ===== 编排 =====
  // run(itemId, command, cwd)：解析 shell → RunExec。返回 {ok, error?}（失败已 flash）。
  async function run(itemId, command, cwd) {
    const cmd = String(command == null ? '' : command).trim();
    if (!cmd) return {ok: false, error: '命令为空'};
    if (!deps.backend || typeof deps.backend.RunExec !== 'function' ||
        typeof deps.backend.ResolveRunShell !== 'function') {
      return {ok: false, error: '当前环境不支持运行终端条目'};
    }
    const prev = termRuns.get(itemId);
    if (prev && prev.state === 'running') return {ok: false, error: '该条目正在运行'};
    // shell 跟随内置终端默认：pwsh 优先，不可用回退 Windows PowerShell
    let shell = null;
    for (const kind of ['pwsh', 'powershell']) {
      try {
        const info = await deps.backend.ResolveRunShell(kind);
        if (info && info.path) { shell = info; break; }
      } catch (e) { /* 该 shell 不存在，试下一个 */ }
    }
    if (!shell) {
      deps.flash('未找到可用的 shell（pwsh / powershell）', true);
      return {ok: false, error: '未找到可用的 shell'};
    }
    const entry = {
      state: 'running',
      lines: [],
      code: null,
      durationMs: 0,
      startedAt: Date.now(),
      truncated: false,
      shell: shell.name || '',
    };
    termRuns.set(itemId, entry);
    paintLive(itemId);
    resetLiveBlock(itemId);
    try {
      await deps.backend.RunExec(termRunId(itemId), shell.path, buildShellArgv(shell.name, cmd), String(cwd || ''), '', TERM_TIMEOUT_MS);
      return {ok: true};
    } catch (e) {
      termRuns.delete(itemId);
      const msg = String((e && e.message) || e);
      // 同窗口防重入已挡掉重复 id：走到这里基本是另一窗口正在运行同一条目
      const friendly = /已在运行/.test(msg) ? '该条目已在运行（可能正在另一窗口）' : '终端条目运行失败：' + msg;
      deps.flash(friendly, true);
      removeResultBlock(itemId);
      paintLive(itemId);
      return {ok: false, error: friendly};
    }
  }

  // stop(itemId)：手动停止。状态立刻翻 stopped（run-exit 随后到达时保留 stopped）。
  async function stop(itemId) {
    const entry = termRuns.get(itemId);
    if (!entry || entry.state !== 'running') return {ok: true};
    entry.state = 'stopped';
    paintLive(itemId);
    if (deps.backend && typeof deps.backend.RunStop === 'function') {
      try { await deps.backend.RunStop(termRunId(itemId)); } catch (e) { /* 进程可能已退出，尽力而为 */ }
    }
    return {ok: true};
  }

  function clear(itemId) {
    termRuns.delete(itemId);
    removeResultBlock(itemId);
    paintLive(itemId);
  }

  // stopAll：关面板（memoUnmount）调用——停掉仍在跑的运行、清空内存态。
  async function stopAll() {
    const jobs = [];
    for (const [itemId, entry] of Array.from(termRuns.entries())) {
      if (entry.state === 'running' && deps.backend && typeof deps.backend.RunStop === 'function') {
        jobs.push(deps.backend.RunStop(termRunId(itemId)).catch(() => { /* 进程可能已退出，尽力而为 */ }));
      }
      termRuns.delete(itemId);
    }
    await Promise.all(jobs);
  }

  function entryOf(itemId) {
    return termRuns.get(itemId) || null;
  }

  function runningCount() {
    let n = 0;
    for (const entry of termRuns.values()) if (entry.state === 'running') n++;
    return n;
  }

  return {run, stop, clear, stopAll, entryOf, runningCount};
}
