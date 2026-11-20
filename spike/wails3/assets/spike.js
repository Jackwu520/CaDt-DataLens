// CaDt Wails v3 P0 spike 前端：只用 /wails/runtime.js（v3 内置提供），不装 npm 依赖。
// 每 3 秒上报一次 realm 探针，用于证明两个窗口的 JS 全局对象互不影响。

import { Events, Call } from '/wails/runtime.js';

const win = new URLSearchParams(location.search).get('win') || 'unknown';
const logEl = document.getElementById('log');
const lines = [];

function show(line) {
  lines.push(line);
  if (lines.length > 300) lines.splice(0, lines.length - 300);
  logEl.textContent = lines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function report(line) {
  show(line);
  console.log('[spike]', line);
  Call.ByName('cadt-spike-v3/service.Service.Report', win, line).catch((err) => {
    show(`REPORT-FAILED ${String(err)}`);
  });
}

document.getElementById('win').textContent = `window=${win}`;

function call(name) {
  return Call.ByName(`cadt-spike-v3/service.Service.${name}`)
    .then((v) => report(`CALL ${name} → ${JSON.stringify(v)}`))
    .catch((err) => report(`CALL ${name} FAILED ${String(err)}`));
}

document.getElementById('btn-float').addEventListener('click', () => call('OpenFloat'));
document.getElementById('btn-ping').addEventListener('click', () => call('EmitPing'));
document.getElementById('btn-exec').addEventListener('click', () => call('ExecJSProbe'));

// 每个 window 的 JS realm 独立探针：计数只在自己窗口增长。
window.__spikeProbe = { win, count: 0, createdAt: Date.now() };
setInterval(() => { window.__spikeProbe.count++; }, 500);

// Go ExecJS 写入的标记：只有被 ExecJS 的窗口应该报告它。
setInterval(() => {
  if (window.__spikeMarker) {
    report(`EXECJS-MARKER ${window.__spikeMarker} probe=${JSON.stringify(window.__spikeProbe)}`);
    window.__spikeMarker = '';
  }
}, 400);

// 周期性 realm 探针（两个窗口的 count 应各自独立增长）。
setInterval(() => {
  report(`REALM-PROBE ${JSON.stringify(window.__spikeProbe)}`);
}, 3000);

// 定向事件测试：从 Go 侧 mainWin.EmitEvent 发出，两个窗口都监听。
Events.On('spike:ping', (e) => {
  report(`EVENT spike:ping data=${JSON.stringify(e.data)} sender=${e.sender ?? '(none)'}`);
});

Events.On('spike:second-instance', (e) => {
  report(`EVENT spike:second-instance args=${JSON.stringify(e.data)}`);
});

report(`ready win=${win} href=${location.href} ua=${navigator.userAgent.includes('Edg') ? 'edge' : 'other'}`);
call('ProbeState');
