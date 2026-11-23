// settings-pane-usage-stats.js：设置 → AI → 使用统计面板。
// 数据来自 Go 派生库快照（打开面板只查库，不扫会话文件）；ECharts 懒加载画趋势/环形图，
// 热力图用 CSS Grid 手写（53 周 × 7 天，每日/每周/累计三种模式）。

import {createSelect} from '../core/form-controls.js';
import {escapeHtml} from '../core/escape.js';
import {
    buildHeatmapModel,
    buildTrendModel,
    dayKeyOf,
    emptySnapshot,
    formatChatDuration,
    formatHitRate,
    formatRequestSpeed,
    formatRequestTime,
    formatSharePercent,
    formatStatusCode,
    formatTokenCount,
    formatTokenExact,
    formatTtft,
    monthLabels,
    requestNewInputTokens,
    sliceDailyModels,
    splitModelSlices,
} from './usage-stats-model.js';

const HEATMAP_MODES = [
    {key: 'daily', label: '每日'},
    {key: 'weekly', label: '每周'},
    {key: 'cumulative', label: '累计'},
];

const RANGE_MODES = [
    {key: '7d', label: '近 7 日'},
    {key: '30d', label: '近 30 日'},
];

// 图表系列色：与主题无关的中饱和色板，深浅主题下都可读。
const SERIES_COLORS = ['#548af7', '#26a641', '#cf8e6d', '#c77dbb', '#2aacb8', '#e5c07b', '#f75464', '#7f8cff'];

const CHART_FONT = '"Inter", "Microsoft YaHei UI", sans-serif';

const LOG_PAGE_SIZES = [10, 20, 50];

// 请求日志表头的解释文案（与截图口径一致，写明本应用的测量方式）。
const LOG_TIPS = {
    trueTokens: '新增输入 + 输出 + 缓存写入 + 缓存命中。新增输入不含缓存；部分协议（如 OpenAI）不上报缓存写入，这一项可能偏低。',
    hitRate: '缓存命中 ÷（新增输入 + 缓存写入 + 缓存命中）。',
    speed: '每秒输出多少 token，从首字算到结束。只统计输出不少于 100 token 的请求；思考过程不外露的模型是近似值。',
    ttft: '从请求发出到上游返回第一个 token 的时间（含排队、预填充与网络往返）。',
};

export function createSettingsPaneUsageStats(deps) {
    // 宿主：2026-11-22 起本页是「应用页面」标签页（core/app-pages.js 的 usage-stats），
    // 由 mount(host) 在标签页容器里建骨架；设置页原内嵌位置已移除。
    // hostEl 为空时回落到旧的固定 id（保留给 dev mock 与将来的多宿主）。
    let hostEl = null;
    const state = {
        range: '30d',
        heatmapMode: 'daily',
        snapshot: null,
        loading: false,
        seq: 0,
        mounted: false,
        syncing: false,
        syncError: '',
        resizeBound: false,
        logPage: 1,
        logPageSize: 10,
        logPageData: null,
        logLoading: false,
        logSeq: 0,
    };
    let trendChart = null;
    let donutChart = null;
    let resizeTimer = 0;
    let chartResizeObserver = null;

    // 图表容器尺寸变化时 resize 两个 ECharts 实例（debounce）。
    // 只靠 window.resize 覆盖不到「窗口没变但容器变窄」的场景——侧栏展开/收起、
    // 编辑器分栏拖动、标签页宽度变化都不派发 window.resize，图表会保持旧宽度。
    // 这里用 ResizeObserver 盯容器本身，window.resize 仅作宿主不派发 RO 时的兜底。
    function scheduleChartResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (trendChart && trendChart.getDom() && trendChart.getDom().getClientRects().length) trendChart.resize();
            if (donutChart && donutChart.getDom() && donutChart.getDom().getClientRects().length) donutChart.resize();
        }, 120);
    }

    function root() {
        return hostEl || document.getElementById('usage-stats-root');
    }

    function node(id) {
        const host = root();
        return host ? host.querySelector('#' + id) : null;
    }

    // ---------- 骨架 ----------

    function mountSkeleton(host) {
        if (state.mounted && host.dataset.usReady === '1') return;
        disposeCharts();
        // 板块间距靠 .us-root 的 flex gap:14px。应用页面标签页的宿主是 .apppage-root，
        // 设置页旧宿主是 #usage-stats-root，两者都没有 .us-root——组件自己加上，
        // 别依赖宿主 class，否则切到应用页面后所有卡片紧贴、没有上下间距。
        // 注意：us-root 会加在宿主元素身上（同节点合并），**不得自带 padding**——
        // 同特异性下声明更晚会压掉 .apppage-root 的内边距（曾因此整页贴边），留白统一由宿主给。
        host.classList.add('us-root');
        host.dataset.usReady = '1';
        host.innerHTML = `
<div class="us-head">
  <div class="us-head-main">
    <div class="us-title">Token 用量</div>
    <div class="us-sub" id="us-sub">累计与热力图覆盖全部历史；趋势与模型分布按所选范围统计</div>
  </div>
  <button type="button" class="dlg-btn us-refresh" id="us-refresh">刷新</button>
</div>
<div class="us-metrics" id="us-metrics"></div>
<section class="us-card">
  <div class="us-card-head">
    <div class="us-card-title">Token 活动</div>
    <div class="us-chips" id="us-heat-chips"></div>
  </div>
  <div class="us-heatmap" id="us-heatmap"></div>
  <div class="us-heat-foot">
    <span class="us-heat-hint" id="us-heat-hint"></span>
    <span class="us-heat-scale"><span>少</span><i class="us-heat-dot level-0"></i><i class="us-heat-dot level-1"></i><i class="us-heat-dot level-2"></i><i class="us-heat-dot level-3"></i><i class="us-heat-dot level-4"></i><span>多</span></span>
  </div>
</section>
<section class="us-card">
  <div class="us-card-head">
    <div class="us-card-title">每日 Token 趋势</div>
    <div class="us-chips" id="us-range-chips"></div>
  </div>
  <div class="us-chart" id="us-trend"></div>
</section>
<section class="us-card">
  <div class="us-card-head">
    <div class="us-card-title">模型用量</div>
    <div class="us-card-sub" id="us-model-sub"></div>
  </div>
  <div class="us-model-body">
    <div class="us-donut" id="us-donut"></div>
    <div class="us-model-list" id="us-model-list"></div>
  </div>
</section>
<section class="us-card us-log-card">
  <div class="us-card-head">
    <div class="us-card-title">请求日志</div>
    <div class="us-card-sub" id="us-log-sub">全部历史 · 按时间倒序</div>
  </div>
  <div class="us-log-scroll">
    <table class="us-log-table">
      <thead>
        <tr>
          <th class="us-log-col-time">时间</th>
          <th>供应商</th>
          <th>模型</th>
          <th class="us-log-num">新增输入</th>
          <th class="us-log-num">输出</th>
          <th class="us-log-num">缓存命中</th>
          <th class="us-log-num">缓存写入</th>
          <th class="us-log-num"><span class="us-log-th">命中率<button type="button" class="info-tip" data-tip="${escapeHtml(LOG_TIPS.hitRate)}" aria-label="命中率说明"></button></span></th>
          <th class="us-log-num"><span class="us-log-th">速度<button type="button" class="info-tip" data-tip="${escapeHtml(LOG_TIPS.speed)}" aria-label="速度说明"></button></span></th>
          <th class="us-log-num"><span class="us-log-th">首字<button type="button" class="info-tip" data-tip="${escapeHtml(LOG_TIPS.ttft)}" aria-label="首字说明"></button></span></th>
          <th class="us-log-num">总耗时</th>
          <th class="us-log-num">状态码</th>
        </tr>
      </thead>
      <tbody id="us-log-body"></tbody>
    </table>
  </div>
  <div class="us-log-foot">
    <span class="us-log-total" id="us-log-total"></span>
    <span class="us-log-pagesize" id="us-log-pagesize"></span>
    <span class="us-log-pager">
      <button type="button" class="us-log-page-btn" id="us-log-prev" aria-label="上一页">‹</button>
      <span class="us-log-page" id="us-log-page"></span>
      <button type="button" class="us-log-page-btn" id="us-log-next" aria-label="下一页">›</button>
    </span>
  </div>
</section>`;
        state.mounted = true;
        bindHeatChips();
        bindRangeChips();
        const refresh = node('us-refresh');
        if (refresh) refresh.addEventListener('click', () => void reload(true));
        bindLogPager();
        if (!state.resizeBound) {
            state.resizeBound = true;
            // 容器级观察：覆盖所有「窗口没变但图表变窄」的宽度变化（侧栏/分栏/标签页）。
            const trendEl = node('us-trend');
            const donutEl = node('us-donut');
            if (typeof ResizeObserver === 'function' && trendEl && donutEl) {
                chartResizeObserver = new ResizeObserver(scheduleChartResize);
                chartResizeObserver.observe(trendEl);
                chartResizeObserver.observe(donutEl);
            }
            // window.resize 兜底：部分宿主（IAB 节流渲染帧）不派发 RO 回调，
            // 两者共用同一 debounce，重复触发只会合并成一次 resize。
            window.addEventListener('resize', scheduleChartResize);
        }
    }

    function bindHeatChips() {
        renderChips(node('us-heat-chips'), HEATMAP_MODES, state.heatmapMode, (key) => {
            state.heatmapMode = key;
            bindHeatChips();
            renderHeatmap(state.snapshot || emptySnapshot(state.range));
        });
    }

    function bindRangeChips() {
        renderChips(node('us-range-chips'), RANGE_MODES, state.range, (key) => {
            if (key === state.range) return;
            state.range = key;
            bindRangeChips();
            void reload(false);
        });
    }

    // renderChips 渲染分段按钮；onPick 由调用方传入（避免递归时重复闭包）。
    function renderChips(host, items, active, onPick) {
        if (!host) return;
        host.replaceChildren();
        for (const item of items) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'us-chip' + (item.key === active ? ' active' : '');
            btn.textContent = item.label;
            btn.addEventListener('click', () => onPick(item.key));
            host.appendChild(btn);
        }
    }

    // ---------- 数据 ----------

    async function load(range) {
        const seq = ++state.seq;
        state.loading = true;
        let raw = null;
        let error = '';
        try {
            if (deps.backend && typeof deps.backend.AIUsageStatsSnapshot === 'function') {
                raw = await deps.backend.AIUsageStatsSnapshot(range);
            }
        } catch (e) {
            error = '统计读取失败：' + String((e && e.message) || e);
        }
        if (seq !== state.seq) return;
        state.loading = false;
        const snap = normalizeSnapshot(raw, range);
        if (error) snap.error = error;
        state.snapshot = snap;
    }

    // 请求日志按页查库：只取当前页，不把全部事实搬到前端。
    async function loadRequests() {
        const seq = ++state.logSeq;
        state.logLoading = true;
        let raw = null;
        let error = '';
        try {
            if (deps.backend && typeof deps.backend.AIUsageStatsRequests === 'function') {
                raw = await deps.backend.AIUsageStatsRequests((state.logPage - 1) * state.logPageSize, state.logPageSize);
            }
        } catch (e) {
            error = '请求日志读取失败：' + String((e && e.message) || e);
        }
        if (seq !== state.logSeq) return;
        state.logLoading = false;
        const total = Math.max(0, Number(raw && raw.total) || 0);
        const pages = logPageCount(total, state.logPageSize);
        if (state.logPage > pages) {
            // 刷新后条数变少：回到最后一页重新取，避免停在空页
            state.logPage = pages;
            return loadRequests();
        }
        state.logPageData = {
            items: Array.isArray(raw && raw.items) ? raw.items : [],
            total,
            error: error || (raw && raw.error ? String(raw.error) : ''),
        };
    }

    // reload 只在用户动作（打开面板 / 刷新按钮 / 切范围）里调用：
    // withSync=true 时先跑一次增量扫描，再做库内查询——没有后台轮询。
    async function reload(withSync) {
        const refreshBtn = node('us-refresh');
        if (refreshBtn) refreshBtn.disabled = true;
        if (withSync && !state.syncing) {
            state.syncing = true;
            const sub = node('us-sub');
            if (sub) sub.textContent = '正在同步用量数据…';
            try {
                if (deps.backend && typeof deps.backend.AIUsageStatsSync === 'function') {
                    const syncError = await deps.backend.AIUsageStatsSync();
                    if (syncError) state.syncError = String(syncError);
                    else state.syncError = '';
                }
            } catch (e) {
                // 增量扫描失败不阻塞展示：已有事实仍然可读
                state.syncError = String((e && e.message) || e);
            } finally {
                state.syncing = false;
            }
        }
        await load(state.range);
        if (withSync) await loadRequests();
        if (refreshBtn) refreshBtn.disabled = false;
        const host = root();
        if (!host || host.getClientRects().length === 0) return;
        renderAll();
    }

    // ---------- 渲染 ----------

    function renderAll() {
        const snap = state.snapshot || emptySnapshot(state.range);
        renderMetrics(snap);
        renderHeatmap(snap);
        renderModels(snap);
        renderLog();
        const sub = node('us-sub');
        if (sub) {
            sub.textContent = snap.error
                ? snap.error
                : (state.syncError
                    ? '同步失败：' + state.syncError
                    : '累计指标覆盖全部历史；热力图展示最近 53 周；趋势与模型分布按所选范围统计'
                        + (snap.generatedAt ? ' · 更新于 ' + timeText(snap.generatedAt) : ''));
        }
        void renderCharts(snap);
    }

    function renderMetrics(snap) {
        const host = node('us-metrics');
        if (!host) return;
        const summary = snap.summary || {};
        const cards = [
            {
                label: '累计 Token 数',
                value: formatTokenCount(summary.totalTokens),
                sub: formatTokenExact(summary.totalTokens) + ' tokens',
                tip: LOG_TIPS.trueTokens,
            },
            {
                label: '峰值 Token 数',
                value: formatTokenCount(summary.peakDayTokens),
                sub: summary.peakDay ? '单日最高 · ' + summary.peakDay : '暂无数据',
            },
            {
                label: '最长聊天时长',
                value: formatChatDuration(summary.longestSessionMs),
                sub: summary.totalSessions ? summary.totalSessions + ' 个会话有记录' : '暂无数据',
            },
            {
                label: '当前连续天数',
                value: (Number(summary.currentStreakDays) || 0) + ' 天',
                sub: '累计活跃 ' + (Number(summary.activeDays) || 0) + ' 天',
            },
            {
                label: '最长连续天数',
                value: (Number(summary.longestStreakDays) || 0) + ' 天',
                sub: summary.firstDay ? '自 ' + summary.firstDay + ' 起' : '暂无数据',
            },
        ];
        host.replaceChildren();
        for (const card of cards) {
            const box = document.createElement('div');
            box.className = 'us-metric';
            const label = document.createElement('div');
            label.className = 'us-metric-label';
            const labelText = document.createElement('span');
            labelText.textContent = card.label;
            label.appendChild(labelText);
            if (card.tip) label.appendChild(infoTip(card.tip, card.label + '说明'));
            const value = document.createElement('div');
            value.className = 'us-metric-value';
            value.textContent = card.value;
            const sub = document.createElement('div');
            sub.className = 'us-metric-sub';
            sub.textContent = card.sub;
            box.append(label, value, sub);
            host.appendChild(box);
        }
    }

    function renderHeatmap(snap) {
        const host = node('us-heatmap');
        if (!host) return;
        const model = buildHeatmapModel((snap.heatmap && snap.heatmap.days) || [], dayKeyOf(new Date()), state.heatmapMode);
        const weeks = model.weeks || [];
        host.replaceChildren();
        if (!weeks.length) return;
        // 月份轴：与 53 列对齐（左侧留出星期列宽）
        const months = document.createElement('div');
        months.className = 'us-heat-months';
        for (const label of monthLabels(weeks)) {
            const item = document.createElement('span');
            item.className = 'us-heat-month';
            item.style.gridColumn = String(label.weekIndex + 1);
            item.textContent = label.label;
            months.appendChild(item);
        }
        const body = document.createElement('div');
        body.className = 'us-heat-body';
        const weekdays = document.createElement('div');
        weekdays.className = 'us-heat-weekdays';
        for (const text of ['', '一', '', '三', '', '五', '']) {
            const item = document.createElement('span');
            item.className = 'us-heat-weekday';
            item.textContent = text;
            weekdays.appendChild(item);
        }
        const cols = document.createElement('div');
        cols.className = 'us-heat-cols';
        for (const week of weeks) {
            const col = document.createElement('div');
            col.className = 'us-heat-week';
            for (const cell of week.cells || []) {
                const dot = document.createElement('span');
                dot.className = 'us-heat-cell level-' + (Number(cell.level) || 0);
                if (model.mode === 'daily') {
                    if (cell.tokens > 0) {
                        dot.dataset.tip = cell.date + ' · ' + formatTokenExact(cell.tokens) + ' tokens' + (cell.requests ? ' · ' + cell.requests + ' 次' : '');
                        dot.dataset.tipDelay = '0';
                    }
                } else if (Number(week.value) > 0) {
                    // 每周/累计模式：一列一个值，悬停整列任何格子都报该列口径
                    const firstDay = week.days && week.days[0] ? week.days[0].date : '';
                    const lastDay = week.days && week.days[6] ? week.days[6].date : '';
                    dot.dataset.tip = model.mode === 'weekly'
                        ? '本周（' + firstDay + ' ~ ' + lastDay + '） · 合计 ' + formatTokenExact(week.value) + ' tokens'
                        : '截至 ' + lastDay + ' · 累计 ' + formatTokenExact(week.value) + ' tokens';
                    dot.dataset.tipDelay = '0';
                }
                col.appendChild(dot);
            }
            cols.appendChild(col);
        }
        body.append(weekdays, cols);
        host.append(months, body);
        const hint = node('us-heat-hint');
        if (hint) {
            hint.textContent = state.heatmapMode === 'daily'
                ? '一格 = 一天'
                : state.heatmapMode === 'weekly'
                    ? '一列 = 一周总用量（从底部按比例填充）'
                    : '一列 = 截至该周的累计用量';
        }
    }

    function renderModels(snap) {
        const host = node('us-model-list');
        const sub = node('us-model-sub');
        if (!host) return;
        const {items, other} = splitModelSlices(snap.models || []);
        const all = other ? [...items, other] : items;
        host.replaceChildren();
        if (sub) {
            const total = all.reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
            sub.textContent = total > 0
                ? state.range === '7d' ? '近 7 日 · ' + formatTokenExact(total) + ' tokens' : '近 30 日 · ' + formatTokenExact(total) + ' tokens'
                : '所选范围暂无用量';
        }
        if (!all.length) {
            const empty = document.createElement('div');
            empty.className = 'us-empty';
            empty.textContent = (snap.summary && snap.summary.totalRequests > 0)
                ? '所选范围内没有用量，切换到「近 30 日」看看'
                : '暂无用量记录。首次打开会自动导入历史会话；若仍为空，点「刷新」再试。';
            host.appendChild(empty);
            return;
        }
        all.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'us-model-row';
            const dot = document.createElement('span');
            dot.className = 'us-model-dot';
            dot.style.background = SERIES_COLORS[index % SERIES_COLORS.length];
            const name = document.createElement('span');
            name.className = 'us-model-name';
            name.textContent = item.model || '未知模型';
            const tokens = document.createElement('span');
            tokens.className = 'us-model-tokens';
            tokens.textContent = formatTokenCount(item.tokens);
            const share = document.createElement('span');
            share.className = 'us-model-share';
            share.textContent = formatSharePercent(item.share);
            row.append(dot, name, tokens, share);
            row.dataset.tip = (item.model || '未知模型') + ' · 输入 ' + formatTokenExact(item.inputTokens)
                + ' / 输出 ' + formatTokenExact(item.outputTokens) + ' · ' + (Number(item.requests) || 0) + ' 次请求';
            row.dataset.tipDelay = '0';
            host.appendChild(row);
        });
    }

    // ---------- 请求日志 ----------

    function infoTip(text, label) {
        const tip = document.createElement('button');
        tip.type = 'button';
        tip.className = 'info-tip';
        tip.dataset.tip = text || '';
        tip.setAttribute('aria-label', label || '说明');
        return tip;
    }

    function logPageCount(total, size) {
        return Math.max(1, Math.ceil((Number(total) || 0) / Math.max(1, Number(size) || 10)));
    }

    function bindLogPager() {
        const host = node('us-log-pagesize');
        if (host) {
            host.replaceChildren();
            const prefix = document.createElement('span');
            prefix.textContent = '每页';
            const {element} = createSelect({
                options: LOG_PAGE_SIZES.map((size) => ({value: String(size), label: String(size)})),
                value: String(state.logPageSize),
                onChange: (event) => {
                    const size = Number(event.target.value) || 10;
                    if (size === state.logPageSize) return;
                    state.logPageSize = size;
                    state.logPage = 1;
                    void loadRequests().then(() => renderLog());
                },
            });
            element.classList.add('us-log-size-select');
            element.setAttribute('aria-label', '每页条数');
            const suffix = document.createElement('span');
            suffix.textContent = '条';
            host.append(prefix, element, suffix);
            // 应用页面不走 settings-ui 的自动扫描，这里手动增强成自绘浮层——
            // 否则原生 select 展开会露出系统菜单（截图里白底的 10/20/50），与界面其余自绘控件两套外观。
            // 增强器幂等，原生 select 仍是值真源，change 照常从它派发。
            if (typeof deps.enhanceSelect === 'function') deps.enhanceSelect(element);
        }
        const prev = node('us-log-prev');
        if (prev) prev.addEventListener('click', () => goLogPage(state.logPage - 1));
        const next = node('us-log-next');
        if (next) next.addEventListener('click', () => goLogPage(state.logPage + 1));
    }

    function goLogPage(page) {
        const total = Number(state.logPageData && state.logPageData.total) || 0;
        const pages = logPageCount(total, state.logPageSize);
        const next = Math.min(pages, Math.max(1, Math.round(Number(page) || 1)));
        if (next === state.logPage) return;
        state.logPage = next;
        // loadRequests 会同步置 loading，先重绘再等结果
        const pending = loadRequests();
        renderLog();
        void pending.then(() => renderLog());
    }

    function renderLog() {
        const body = node('us-log-body');
        if (!body) return;
        const data = state.logPageData;
        const total = Number(data && data.total) || 0;
        const pages = logPageCount(total, state.logPageSize);
        const totalEl = node('us-log-total');
        if (totalEl) totalEl.textContent = '共 ' + formatTokenExact(total) + ' 条记录';
        const pageEl = node('us-log-page');
        if (pageEl) pageEl.textContent = state.logPage + ' / ' + pages;
        const prev = node('us-log-prev');
        if (prev) prev.disabled = state.logLoading || state.logPage <= 1;
        const next = node('us-log-next');
        if (next) next.disabled = state.logLoading || state.logPage >= pages;
        const sub = node('us-log-sub');
        if (sub) sub.textContent = state.logLoading ? '正在读取请求日志…' : '全部历史 · 按时间倒序';
        body.replaceChildren();
        if (!data) {
            appendLogMessageRow(body, '加载中…');
            return;
        }
        if (data.error) {
            appendLogMessageRow(body, data.error);
            return;
        }
        const items = data.items || [];
        if (!items.length) {
            appendLogMessageRow(body, '暂无请求记录。首次打开会自动导入历史会话；若仍为空，点「刷新」再试。');
            return;
        }
        for (const item of items) body.appendChild(buildLogRow(item));
    }

    function appendLogMessageRow(body, text) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 12;
        cell.className = 'us-log-empty';
        cell.textContent = text;
        row.appendChild(cell);
        body.appendChild(row);
    }

    function buildLogRow(item) {
        const row = document.createElement('tr');
        const cell = (text, className) => {
            const td = document.createElement('td');
            if (className) td.className = className;
            td.textContent = text;
            return td;
        };
        const account = String((item && item.modelAccount) || '') || '—';
        const model = String((item && item.model) || '') || '未知模型';
        const status = Number(item && item.statusCode) || 0;
        const statusClass = status >= 200 && status < 300
            ? ' us-log-status-ok'
            : (status >= 400 ? ' us-log-status-error' : '');
        const timeCell = cell(formatRequestTime(item && item.ts), 'us-log-col-time');
        const accountCell = cell(account, 'us-log-ellipsis');
        if (account !== '—') accountCell.dataset.tip = account;
        const modelCell = cell(model, 'us-log-ellipsis');
        modelCell.dataset.tip = model;
        row.append(
            timeCell,
            accountCell,
            modelCell,
            cell(formatTokenCount(requestNewInputTokens(item)), 'us-log-num'),
            cell(formatTokenCount(item && item.completionTokens), 'us-log-num'),
            cell(formatTokenCount(item && item.cachedTokens), 'us-log-num'),
            cell(formatTokenCount(item && item.cacheWriteTokens), 'us-log-num'),
            cell(formatHitRate(item), 'us-log-num'),
            cell(formatRequestSpeed(item), 'us-log-num us-log-speed'),
            cell(formatTtft(item && item.ttftMs), 'us-log-num'),
            cell(formatChatDuration(item && item.modelMs), 'us-log-num'),
            cell(formatStatusCode(status), 'us-log-num' + statusClass),
        );
        return row;
    }

    // ---------- ECharts ----------

    async function renderCharts(snap) {
        const trendEl = node('us-trend');
        const donutEl = node('us-donut');
        if (!trendEl || !donutEl || trendEl.getClientRects().length === 0) return;
        let echarts = null;
        let colors = {};
        try {
            // 动态加载：ECharts 加载器与主题色工具都不进主 bundle（图表只在进本页时才需要）
            const [chartMod, visualMod] = await Promise.all([
                import('../core/chart-render.js'),
                import('../core/visual-spec.js'),
            ]);
            colors = visualMod.resolveThemeColors();
            echarts = await chartMod.ensureEcharts();
        } catch (e) {
            showChartFallback(trendEl, '图表库加载失败');
            showChartFallback(donutEl, '');
            return;
        }
        // await 期间用户可能切走：隐藏容器上 init 会得到 0 尺寸，等下次进入再画
        if (trendEl.getClientRects().length === 0 || donutEl.getClientRects().length === 0) return;
        if (trendChart && trendChart.getDom() !== trendEl) {
            trendChart.dispose();
            trendChart = null;
        }
        if (!trendChart) trendChart = echarts.init(trendEl);
        else trendChart.resize();
        trendChart.setOption(buildTrendOption(snap, colors), true);
        if (donutChart && donutChart.getDom() !== donutEl) {
            donutChart.dispose();
            donutChart = null;
        }
        if (!donutChart) donutChart = echarts.init(donutEl);
        else donutChart.resize();
        donutChart.setOption(buildDonutOption(snap, colors), true);
    }

    function showChartFallback(host, text) {
        if (!text) return;
        host.replaceChildren();
        const line = document.createElement('div');
        line.className = 'us-empty';
        line.textContent = text;
        host.appendChild(line);
    }

    function buildTrendOption(snap, colors) {
        const days = snap.range === '7d' ? 7 : 30;
        const rows = sliceDailyModels(snap.dailyModelUsage || [], days);
        const models = (snap.models || []).map((item) => item.model).filter(Boolean);
        const trend = buildTrendModel(rows, models);
        return {
            animation: false,
            color: SERIES_COLORS,
            grid: {left: 56, right: 18, top: 34, bottom: 30},
            tooltip: {
                trigger: 'axis',
                // 挂到 body：设置对话框内容区有 overflow，容器内的浮层会被侧栏/裁剪盖住
                appendToBody: true,
                backgroundColor: colors.panel2,
                borderColor: colors.border,
                textStyle: {color: colors.text, fontSize: 12},
                // 模型名来自用户配置：默认 formatter 按 HTML 插入，这里全部转义
                formatter: (params) => {
                    const list = Array.isArray(params) ? params : [params];
                    if (!list.length) return '';
                    const title = escapeHtml(list[0].axisValueLabel || list[0].axisValue || '');
                    const rows = list.map((item) =>
                        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' +
                        escapeHtml(item.color) + '"></span>' + escapeHtml(item.seriesName) + '：' +
                        escapeHtml(formatTokenExact(item.value)) + ' tokens');
                    return '<div style="font-size:12px;line-height:1.7">' + title + '<br/>' + rows.join('<br/>') + '</div>';
                },
            },
            legend: {
                type: 'scroll',
                top: 0,
                left: 0,
                textStyle: {color: colors.muted, fontSize: 11, fontFamily: 'inherit'},
                icon: 'roundRect',
                itemWidth: 10,
                itemHeight: 8,
                pageIconSize: 9,
                pageTextStyle: {color: colors.muted, fontSize: 11},
            },
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: trend.dates.map((date) => date.slice(5)),
                axisLine: {lineStyle: {color: colors.border}},
                axisTick: {show: false},
                axisLabel: {color: colors.muted, fontSize: 11, fontFamily: CHART_FONT},
            },
            yAxis: {
                type: 'value',
                splitLine: {lineStyle: {color: colors.border, opacity: 0.5}},
                axisLabel: {color: colors.muted, fontSize: 11, fontFamily: CHART_FONT, formatter: (value) => formatTokenCount(value)},
            },
            series: trend.series.map((item) => ({
                name: item.name,
                type: 'line',
                smooth: true,
                showSymbol: false,
                symbolSize: 4,
                lineStyle: {width: 2},
                areaStyle: {opacity: 0.06},
                emphasis: {focus: 'series'},
                data: item.data,
            })),
        };
    }

    function buildDonutOption(snap, colors) {
        const {items, other} = splitModelSlices(snap.models || []);
        const all = other ? [...items, other] : items;
        const total = all.reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
        return {
            animation: false,
            color: SERIES_COLORS,
            // 圆心常显范围内总量（与图例/扇区同口径），hover 明细走 tooltip
            title: {
                text: formatTokenCount(total),
                subtext: 'tokens',
                left: 'center',
                top: 'center',
                itemGap: 2,
                textStyle: {color: colors.text, fontSize: 20, fontWeight: 600, fontFamily: CHART_FONT},
                subtextStyle: {color: colors.muted, fontSize: 11, fontFamily: CHART_FONT},
            },
            tooltip: {
                trigger: 'item',
                appendToBody: true,
                backgroundColor: colors.panel2,
                borderColor: colors.border,
                textStyle: {color: colors.text, fontSize: 12},
                formatter: (param) => escapeHtml(param.name) + '：' + escapeHtml(formatTokenExact(param.value))
                    + ' tokens（' + escapeHtml(param.percent) + '%）',
            },
            series: [{
                type: 'pie',
                radius: ['62%', '86%'],
                center: ['50%', '50%'],
                avoidLabelOverlap: false,
                itemStyle: {borderRadius: 5, borderColor: colors.panel, borderWidth: 2},
                label: {show: false},
                labelLine: {show: false},
                emphasis: {scale: true, scaleSize: 4},
                data: all.map((item) => ({name: item.model || '未知模型', value: Number(item.tokens) || 0})),
            }],
        };
    }

    function disposeCharts() {
        if (trendChart) {
            trendChart.dispose();
            trendChart = null;
        }
        if (donutChart) {
            donutChart.dispose();
            donutChart = null;
        }
    }

    // ---------- 入口 ----------

    async function renderUsageStatsPane() {
        const host = root();
        if (!host) return;
        mountSkeleton(host);
        // 先用库里的现有事实渲染（毫秒级），再按这次打开做一次增量同步并刷新。
        // 首次打开会顺带回填历史会话；不做启动回填、不做定时轮询。
        await Promise.all([load(state.range), loadRequests()]);
        if (!root() || root().getClientRects().length === 0) return;
        renderAll();
        await reload(true);
    }

    // 挂到宿主容器（应用页面标签页调用）：登记宿主 → 建骨架并加载 → 返回卸载函数
    // （关标签时释放 ECharts 实例与 resize 监听，否则实例与 DOM 一起泄漏）。
    function mount(host) {
        if (!host) return null;
        hostEl = host;
        state.mounted = false;
        renderUsageStatsPane().catch(() => {});
        return () => {
            disposeCharts();
            if (chartResizeObserver) {
                chartResizeObserver.disconnect();
                chartResizeObserver = null;
            }
            window.removeEventListener('resize', scheduleChartResize);
            state.resizeBound = false;
            if (hostEl) hostEl.classList.remove('us-root');
            hostEl = null;
            state.mounted = false;
        };
    }

    return {mount, renderUsageStatsPane};
}

function normalizeSnapshot(raw, range) {
    const base = emptySnapshot(range);
    const snap = raw && typeof raw === 'object' ? raw : {};
    const heatmap = snap.heatmap && typeof snap.heatmap === 'object' ? snap.heatmap : {};
    return {
        ...base,
        ...snap,
        range: snap.range || range,
        generatedAt: Number(snap.generatedAt) || 0,
        summary: {...base.summary, ...(snap.summary && typeof snap.summary === 'object' ? snap.summary : {})},
        heatmap: {
            ...base.heatmap,
            ...heatmap,
            days: Array.isArray(heatmap.days) ? heatmap.days : [],
        },
        dailyModelUsage: Array.isArray(snap.dailyModelUsage) ? snap.dailyModelUsage : [],
        models: Array.isArray(snap.models) ? snap.models : [],
        error: typeof snap.error === 'string' ? snap.error : '',
    };
}

function timeText(ms) {
    const date = new Date(Number(ms) || 0);
    if (Number.isNaN(date.getTime())) return '';
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
