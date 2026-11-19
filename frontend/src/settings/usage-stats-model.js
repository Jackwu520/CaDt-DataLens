// usage-stats-model.js：使用统计面板的纯函数层——token/时长格式化、53 周热力图网格、
// 每周/累计填充、趋势序列、请求日志命中率/速度/首字换算与环形图切片。
// DOM 与 ECharts 在 settings-pane-usage-stats.js。
// 日界与 streak 口径由 Go 侧算好；这里只做展示层换算，全部函数可单测。

export const HEATMAP_WEEKS = 53;
export const HEATMAP_ROWS = 7;
export const MODEL_SLICE_LIMIT = 6;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------- 格式化 ----------

function trimFixed(value) {
    return value.toFixed(1).replace(/\.0$/, '');
}

// formatTokenCount：指标卡/图例的紧凑数字（1.2亿 / 1.2M / 12.3K / 999）。
// 中文语境不用 Billion：十亿以上按「亿」显示。
export function formatTokenCount(value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    if (n >= 1e8) return trimFixed(n / 1e8) + '亿';
    if (n >= 1e6) return trimFixed(n / 1e6) + 'M';
    if (n >= 999950) return '1M'; // 四舍五入到 1000K 时进位，不显示 1000K
    if (n >= 1e3) return trimFixed(n / 1e3) + 'K';
    return String(n);
}

// formatTokenExact：明细/悬浮提示的完整数字（千分位）。
export function formatTokenExact(value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// formatChatDuration：两单位口径（2h13m / 45m / 30s / 3d2h），与额度倒计时一致。
export function formatChatDuration(ms) {
    const totalMs = Math.max(0, Number(ms) || 0);
    if (totalMs <= 0) return '—';
    if (totalMs < 1000) return '<1s';
    const totalSec = Math.round(totalMs / 1000);
    if (totalSec < 60) return totalSec + 's';
    const totalMin = Math.floor(totalSec / 60);
    if (totalMin < 60) return totalMin + 'm';
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    if (hours < 24) return mins ? hours + 'h' + mins + 'm' : hours + 'h';
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? days + 'd' + restHours + 'h' : days + 'd';
}

export function formatSharePercent(share) {
    const value = Math.max(0, Number(share) || 0) * 100;
    if (value >= 100) return '100%';
    if (value >= 10) return value.toFixed(0) + '%';
    if (value >= 1) return value.toFixed(1) + '%';
    return value > 0 ? '<1%' : '0%';
}

// ---------- 请求日志 ----------

// 速度只统计输出足够多的请求；生成窗口太短时除法的量化误差太大。
export const MIN_SPEED_OUTPUT_TOKENS = 100;
export const MIN_SPEED_WINDOW_MS = 200;

// 新增输入 = prompt - 缓存命中 - 缓存写入（不同协议的 prompt 口径见 ai-usage-quota 归一）。
export function requestNewInputTokens(row) {
    const prompt = Number(row && row.promptTokens) || 0;
    const cached = Number(row && row.cachedTokens) || 0;
    const write = Number(row && row.cacheWriteTokens) || 0;
    return Math.max(0, prompt - cached - write);
}

// 缓存命中率 = 缓存命中 ÷（新增输入 + 缓存写入 + 缓存命中）。
export function requestCacheHitRate(row) {
    const hit = Number(row && row.cachedTokens) || 0;
    const denom = requestNewInputTokens(row) + (Number(row && row.cacheWriteTokens) || 0) + hit;
    if (denom <= 0) return 0;
    return Math.min(1, hit / denom);
}

export function formatHitRate(row) {
    const hit = Number(row && row.cachedTokens) || 0;
    const denom = requestNewInputTokens(row) + (Number(row && row.cacheWriteTokens) || 0) + hit;
    if (denom <= 0) return '—';
    const rate = Math.min(1, hit / denom);
    if (rate >= 0.9995) return '100%';
    return (rate * 100).toFixed(1) + '%';
}

// 速度 = 输出 token ÷（请求总耗时 - 首字延迟）；只算输出 ≥100 token 且窗口 ≥200ms 的请求。
export function formatRequestSpeed(row) {
    const output = Number(row && row.completionTokens) || 0;
    const modelMs = Number(row && row.modelMs) || 0;
    const ttft = Math.max(0, Number(row && row.ttftMs) || 0);
    if (output < MIN_SPEED_OUTPUT_TOKENS || modelMs <= 0 || ttft <= 0) return '—';
    const windowMs = modelMs - ttft;
    if (windowMs < MIN_SPEED_WINDOW_MS) return '—';
    const speed = output / (windowMs / 1000);
    if (!Number.isFinite(speed) || speed <= 0) return '—';
    return (speed >= 100 ? Math.round(speed) : speed.toFixed(1)) + ' tok/s';
}

// 首字延迟：请求发出 → 第一个 token。
export function formatTtft(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value <= 0) return '—';
    if (value < 1000) return Math.round(value) + 'ms';
    if (value < 10000) return (value / 1000).toFixed(1) + 's';
    return Math.round(value / 1000) + 's';
}

// 请求日志时间：同年省略年份，跨年补上；本地时区。
export function formatRequestTime(ts, now = Date.now()) {
    const value = Number(ts) || 0;
    if (value <= 0) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    const sameYear = date.getFullYear() === new Date(Number(now) || Date.now()).getFullYear();
    return (sameYear ? '' : date.getFullYear() + '-')
        + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' '
        + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

export function formatStatusCode(code) {
    const value = Number(code) || 0;
    return value >= 100 && value <= 599 ? String(value) : '—';
}

// ---------- 日期 ----------

// parseDayKey 按本地日历解析 YYYY-MM-DD（new Date('YYYY-MM-DD') 会按 UTC 解析而偏移一天）。
export function parseDayKey(key) {
    const match = DAY_RE.exec(String(key || ''));
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function dayKeyOf(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
}

// ---------- 热力图 ----------

// heatmapLevel 0–4 色阶（阈值对齐 ZCode：25% / 50% / 75% 分档）。
export function heatmapLevel(tokens, max) {
    const value = Number(tokens) || 0;
    const peak = Number(max) || 0;
    if (value <= 0) return 0;
    if (peak <= 0) return 1;
    const ratio = value / peak;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
}

// filledRows 每周/累计模式一列从底部填几格（1–7）。
export function filledRows(value, max, rows = HEATMAP_ROWS) {
    const v = Number(value) || 0;
    const peak = Number(max) || 0;
    if (v <= 0 || peak <= 0) return 0;
    return Math.max(1, Math.min(rows, Math.ceil((v / peak) * rows)));
}

// buildHeatmapWeeks 53 个自然周（周日开头）的二维网格；数据按日期查表，缺的补 0。
export function buildHeatmapWeeks(days, todayKey, weeksCount = HEATMAP_WEEKS) {
    const map = new Map();
    for (const day of Array.isArray(days) ? days : []) {
        if (day && typeof day.date === 'string') map.set(day.date, day);
    }
    const today = parseDayKey(todayKey) || new Date();
    const endWeekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
    const start = new Date(endWeekStart.getFullYear(), endWeekStart.getMonth(), endWeekStart.getDate() - (weeksCount - 1) * 7);
    const weeks = [];
    for (let w = 0; w < weeksCount; w++) {
        const weekDays = [];
        for (let row = 0; row < HEATMAP_ROWS; row++) {
            const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + row);
            const key = dayKeyOf(date);
            const hit = map.get(key);
            weekDays.push({
                date: key,
                tokens: Number(hit && hit.tokens) || 0,
                requests: Number(hit && hit.requests) || 0,
            });
        }
        weeks.push({weekIndex: w, days: weekDays});
    }
    return weeks;
}

// buildHeatmapModel 把日数据换算成渲染模型：daily 每格独立着色；weekly/cumulative 每列
// 一个值，按比例从底往上填格。返回的 weeks[i].cells 已经是最终 level。
export function buildHeatmapModel(days, todayKey, mode) {
    const weeks = buildHeatmapWeeks(days, todayKey);
    if (mode === 'weekly' || mode === 'cumulative') {
        const weekly = weeks.map((week) => week.days.reduce((sum, day) => sum + day.tokens, 0));
        const values = mode === 'cumulative'
            ? weekly.reduce((acc, value) => {
                acc.push((acc.length ? acc[acc.length - 1] : 0) + value);
                return acc;
            }, [])
            : weekly;
        const maxValue = values.reduce((max, value) => Math.max(max, value), 0);
        return {
            mode,
            maxValue,
            weeks: weeks.map((week, index) => {
                const value = values[index];
                const filled = filledRows(value, maxValue);
                const level = heatmapLevel(value, maxValue);
                return {
                    weekIndex: week.weekIndex,
                    value,
                    days: week.days,
                    cells: week.days.map((day, row) => ({
                        ...day,
                        level: row >= HEATMAP_ROWS - filled ? level : 0,
                    })),
                };
            }),
        };
    }
    const maxValue = weeks.reduce((max, week) => week.days.reduce((inner, day) => Math.max(inner, day.tokens), max), 0);
    return {
        mode: 'daily',
        maxValue,
        weeks: weeks.map((week) => ({
            weekIndex: week.weekIndex,
            value: week.days.reduce((sum, day) => sum + day.tokens, 0),
            days: week.days,
            cells: week.days.map((day) => ({...day, level: heatmapLevel(day.tokens, maxValue)})),
        })),
    };
}

// monthLabels 月份轴：月份变化处一个标签；间距不足 2 周的跳过（避免同月开头挤在一起）。
export function monthLabels(weeks) {
    const labels = [];
    let lastMonth = -1;
    let lastIndex = -99;
    for (const week of Array.isArray(weeks) ? weeks : []) {
        const first = parseDayKey(week && week.days && week.days[0] && week.days[0].date);
        if (!first) continue;
        const month = first.getMonth();
        if (month === lastMonth) continue;
        // 间距太近先跳过，但不更新 lastMonth：下一周继续尝试，避免整月标签永久丢失
        if (week.weekIndex - lastIndex < 2) continue;
        labels.push({weekIndex: week.weekIndex, label: (month + 1) + '月'});
        lastMonth = month;
        lastIndex = week.weekIndex;
    }
    return labels;
}

// ---------- 趋势图与环形图 ----------

// sliceDailyModels 取最近 days 个日桶（Go 返回的窗口可能更长）。
export function sliceDailyModels(daily, days) {
    const rows = Array.isArray(daily) ? daily : [];
    const limit = Math.max(1, Number(days) || rows.length || 1);
    return rows.slice(-limit);
}

// buildTrendModel 多模型折线：只画前 limit 个模型，缺日补 0。
export function buildTrendModel(daily, modelNames, limit = MODEL_SLICE_LIMIT) {
    const rows = Array.isArray(daily) ? daily : [];
    const names = (Array.isArray(modelNames) ? modelNames : []).slice(0, Math.max(1, limit));
    return {
        dates: rows.map((row) => (row && row.date) || ''),
        series: names.map((name) => ({
            name,
            data: rows.map((row) => {
                const models = row && Array.isArray(row.models) ? row.models : [];
                const hit = models.find((item) => item && item.model === name);
                return hit ? Number(hit.tokens) || 0 : 0;
            }),
        })),
    };
}

// splitModelSlices 环形图前 N 项 + 「其他」（与 ZCode 一样 5 项 + Other）。
export function splitModelSlices(models, limit = MODEL_SLICE_LIMIT) {
    const sorted = (Array.isArray(models) ? models : [])
        .filter((item) => item && Number(item.tokens) > 0)
        .slice()
        .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0));
    if (sorted.length <= limit) return {items: sorted, other: null};
    const items = sorted.slice(0, limit - 1);
    const rest = sorted.slice(limit - 1);
    const sum = (key) => rest.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    return {
        items,
        other: {
            model: '其他',
            tokens: sum('tokens'),
            inputTokens: sum('inputTokens'),
            outputTokens: sum('outputTokens'),
            requests: sum('requests'),
            share: sum('share'),
            merged: rest.length,
        },
    };
}

// emptySnapshot 查询失败/无数据时的兜底结构，避免渲染层到处判空。
export function emptySnapshot(range = '30d') {
    return {
        generatedAt: 0,
        range,
        summary: {
            totalTokens: 0, peakDayTokens: 0, peakDay: '', longestSessionMs: 0,
            currentStreakDays: 0, longestStreakDays: 0, activeDays: 0,
            totalSessions: 0, totalRequests: 0, firstDay: '', lastDay: '',
        },
        heatmap: {startDate: '', endDate: '', maxTokens: 0, days: []},
        dailyModelUsage: [],
        models: [],
    };
}
