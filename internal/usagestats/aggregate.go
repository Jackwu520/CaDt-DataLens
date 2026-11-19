// aggregate.go：事件 → 面板快照的纯函数聚合。日界按本机时区（与用户看到的日历一致），
// 连续天数口径对齐 ZCode：今天没有用量时当前连续天数为 0。
package usagestats

import (
	"sort"
	"time"
)

const (
	dayLayout = "2006-01-02"
	// 热力图最多回看 371 天（53 周）；更早的数据仍计入汇总指标，只是不画格子。
	heatmapMaxDays = 371
)

// rangeDays 返回趋势图/环形图的窗口天数；未知值按 30 天兜底。
func rangeDays(rangeKey string) (int, string) {
	switch rangeKey {
	case "7d":
		return 7, "7d"
	case "30d":
		return 30, "30d"
	default:
		return 30, "30d"
	}
}

// buildSnapshot 把全部事实聚合成一次面板查询的结果（纯函数，供测试）。
func buildSnapshot(events []Event, rangeKey string, now time.Time) Snapshot {
	loc := now.Location()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	days, normalizedRange := rangeDays(rangeKey)
	rangeStart := today.AddDate(0, 0, -(days - 1))
	rangeStartKey := rangeStart.Format(dayLayout)

	dayTokens := make(map[string]int64)
	dayRequests := make(map[string]int)
	dayModels := make(map[string]map[string]int64)
	modelAgg := make(map[string]*ModelUsage)
	sessionSpan := make(map[string][2]int64)
	var total int64
	var longestTurn int64

	nowMs := now.UnixMilli()
	for _, e := range events {
		if e.TurnMs > longestTurn {
			longestTurn = e.TurnMs
		}
		tokens := effectiveTotal(e)
		ts := e.Ts
		if ts > nowMs {
			ts = nowMs // 时钟回拨/异常时间戳：归到当前时刻，保证汇总与热力图口径一致
		}
		day := dayKey(ts, loc)
		model := e.Model
		if model == "" {
			model = unknownModelName
		}
		total += tokens
		dayTokens[day] += tokens
		dayRequests[day]++
		if dayModels[day] == nil {
			dayModels[day] = make(map[string]int64, 2)
		}
		dayModels[day][model] += tokens
		if day >= rangeStartKey {
			agg := modelAgg[model]
			if agg == nil {
				agg = &ModelUsage{Model: model}
				modelAgg[model] = agg
			}
			agg.Tokens += tokens
			agg.InputTokens += e.PromptTokens
			agg.OutputTokens += e.CompletionTokens
			agg.Requests++
		}
		if e.SessionID != "" {
			span := sessionSpan[e.SessionID]
			if span[0] == 0 || ts < span[0] {
				span[0] = ts
			}
			if ts > span[1] {
				span[1] = ts
			}
			sessionSpan[e.SessionID] = span
		}
	}

	summary := buildSummary(dayTokens, sessionSpan, total, len(events), longestTurn, today, loc)
	return Snapshot{
		GeneratedAt:     now.UnixMilli(),
		Range:           normalizedRange,
		Summary:         summary,
		Heatmap:         buildHeatmap(dayTokens, dayRequests, summary.FirstDay, today, loc),
		DailyModelUsage: buildDailyModelUsage(dayModels, rangeStart, days),
		Models:          buildModelList(modelAgg),
	}
}

// effectiveTotal 一条事实的 token 总量：优先 API 的 total，缺失时回退输入+输出。
func effectiveTotal(e Event) int64 {
	if e.TotalTokens > 0 {
		return e.TotalTokens
	}
	total := e.PromptTokens + e.CompletionTokens
	if total < 0 {
		return 0
	}
	return total
}

func dayKey(ts int64, loc *time.Location) string {
	return time.UnixMilli(ts).In(loc).Format(dayLayout)
}

// dayNumber 把日期映射成稳定的整数序号（按日历天，不受时区偏移影响）。
func dayNumber(t time.Time) int {
	y, mo, d := t.Date()
	return int(time.Date(y, mo, d, 0, 0, 0, 0, time.UTC).Unix() / 86400)
}

func buildSummary(dayTokens map[string]int64, sessionSpan map[string][2]int64, total int64, requests int, longestTurn int64, today time.Time, loc *time.Location) Summary {
	summary := Summary{
		TotalTokens:   total,
		TotalRequests: requests,
		TotalSessions: len(sessionSpan),
	}
	if longestTurn > 0 {
		summary.LongestSessionMs = longestTurn
	} else {
		// 老数据没有 turnMs：回退到会话首末消息跨度（含挂起时间，仅作兜底）。
		for _, span := range sessionSpan {
			if ms := span[1] - span[0]; ms > summary.LongestSessionMs {
				summary.LongestSessionMs = ms
			}
		}
	}
	// 活跃日 = 当天 token > 0（与 ZCode 一致：只有工具调用没有模型 token 的天不算）。
	dayNums := make([]int, 0, len(dayTokens))
	dayByNum := make(map[int]string, len(dayTokens))
	var peak int64
	for day, tokens := range dayTokens {
		if tokens <= 0 {
			continue
		}
		parsed, err := time.ParseInLocation(dayLayout, day, loc)
		if err != nil {
			continue
		}
		num := dayNumber(parsed)
		dayNums = append(dayNums, num)
		dayByNum[num] = day
		if tokens > peak || (tokens == peak && (summary.PeakDay == "" || day < summary.PeakDay)) {
			peak = tokens
			summary.PeakDay = day
		}
	}
	sort.Ints(dayNums)
	summary.ActiveDays = len(dayNums)
	summary.PeakDayTokens = peak
	if len(dayNums) > 0 {
		summary.FirstDay = dayByNum[dayNums[0]]
		summary.LastDay = dayByNum[dayNums[len(dayNums)-1]]
	}
	summary.LongestStreakDays = longestStreak(dayNums)
	summary.CurrentStreakDays = currentStreak(dayNums, dayNumber(today))
	return summary
}

// longestStreak 已排序日序号的最长连续段。
func longestStreak(sorted []int) int {
	longest, run := 0, 0
	for i, num := range sorted {
		if i > 0 && num == sorted[i-1]+1 {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
	}
	return longest
}

// currentStreak 从今天往前数连续活跃天数；今天没有用量则为 0（ZCode 口径）。
func currentStreak(sorted []int, todayNum int) int {
	if len(sorted) == 0 || sorted[len(sorted)-1] < todayNum {
		return 0
	}
	active := make(map[int]bool, len(sorted))
	for _, num := range sorted {
		active[num] = true
	}
	count := 0
	for num := todayNum; active[num]; num-- {
		count++
	}
	return count
}

// buildHeatmap 从最早活跃日（最多回看 371 天）到今天，每个自然日一格。
func buildHeatmap(dayTokens map[string]int64, dayRequests map[string]int, firstDay string, today time.Time, loc *time.Location) Heatmap {
	heatmap := Heatmap{EndDate: today.Format(dayLayout)}
	if firstDay == "" {
		return heatmap
	}
	start, err := time.ParseInLocation(dayLayout, firstDay, loc)
	if err != nil {
		return heatmap
	}
	earliest := today.AddDate(0, 0, -(heatmapMaxDays - 1))
	if start.Before(earliest) {
		start = earliest
	}
	heatmap.StartDate = start.Format(dayLayout)
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		key := d.Format(dayLayout)
		tokens := dayTokens[key]
		if tokens > heatmap.MaxTokens {
			heatmap.MaxTokens = tokens
		}
		heatmap.Days = append(heatmap.Days, HeatmapDay{Date: key, Tokens: tokens, Requests: dayRequests[key]})
	}
	return heatmap
}

// buildDailyModelUsage 查询窗口内每天一行（缺失日期补空 models，前端直接当 x 轴用）。
func buildDailyModelUsage(dayModels map[string]map[string]int64, start time.Time, days int) []DailyModel {
	out := make([]DailyModel, 0, days)
	for i := 0; i < days; i++ {
		day := start.AddDate(0, 0, i)
		key := day.Format(dayLayout)
		models := make([]ModelTokens, 0, len(dayModels[key]))
		for model, tokens := range dayModels[key] {
			models = append(models, ModelTokens{Model: model, Tokens: tokens})
		}
		sort.Slice(models, func(a, b int) bool {
			if models[a].Tokens != models[b].Tokens {
				return models[a].Tokens > models[b].Tokens
			}
			return models[a].Model < models[b].Model
		})
		out = append(out, DailyModel{Date: key, Models: models})
	}
	return out
}

// buildModelList 查询窗口内的模型排行与占比。
func buildModelList(modelAgg map[string]*ModelUsage) []ModelUsage {
	var rangeTotal int64
	for _, agg := range modelAgg {
		rangeTotal += agg.Tokens
	}
	out := make([]ModelUsage, 0, len(modelAgg))
	for _, agg := range modelAgg {
		if rangeTotal > 0 {
			agg.Share = float64(agg.Tokens) / float64(rangeTotal)
		}
		out = append(out, *agg)
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].Tokens != out[b].Tokens {
			return out[a].Tokens > out[b].Tokens
		}
		return out[a].Model < out[b].Model
	})
	return out
}
