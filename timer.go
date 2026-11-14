// timer.go：AI 计时工具的 Go 侧计时器（类一-11）。
// 纯内存、不持久化：应用退出即全部消失（工具描述已告知 AI 这一点）。
// 计时放后端而不是前端 setTimeout：窗口最小化或 WebView 节流时前端定时器会漂移，
// 后端 time.AfterFunc 不受影响；倒计时到点经 ai-timer-fired 事件广播，
// 由前端注入系统消息唤醒对应会话（与定时任务同一投递通道）。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	aiTimerMaxActive  = 30            // 应用内同时运行的计时器总上限（会话内 5 个由前端按会话归属判定，done 不计入）
	aiTimerMaxSeconds = 24 * 60 * 60  // 单个计时时长上限：24 小时（更长的等待应改用定时任务）
)

// AITimerInfo 计时器状态（JSON 字段与前端 ai-timer.js 对齐）。
type AITimerInfo struct {
	Id      string `json:"id"`
	Mode    string `json:"mode"` // countdown=倒计时 countup=正计时
	Label   string `json:"label"`
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"` // 倒计时到点时间；正计时为 0
}

type aiTimerEntry struct {
	info  AITimerInfo
	timer *time.Timer
}

// AITimerStartResult StartTimer 的返回：启动后的全量列表 + 新建的计时器。
type AITimerStartResult struct {
	List    []AITimerInfo `json:"list"`
	Created AITimerInfo   `json:"created"`
}

// AITimerStopResult StopTimer 的返回：剩余列表 + 被停计时器（Found=false 表示 id 不存在）。
type AITimerStopResult struct {
	List    []AITimerInfo `json:"list"`
	Stopped AITimerInfo   `json:"stopped"`
	Found   bool          `json:"found"`
}

// aiTimerRegistry 计时器注册表；onFire 在倒计时到点时回调（App 侧发事件，测试侧捕获）。
type aiTimerRegistry struct {
	mu     sync.Mutex
	timers map[string]*aiTimerEntry
	onFire func(AITimerInfo)
}

func newAITimerRegistry(onFire func(AITimerInfo)) *aiTimerRegistry {
	return &aiTimerRegistry{
		timers: map[string]*aiTimerEntry{},
		onFire: onFire,
	}
}

func randomAITimerId() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "t-" + hex.EncodeToString(b), nil
}

func (r *aiTimerRegistry) listLocked() []AITimerInfo {
	list := make([]AITimerInfo, 0, len(r.timers))
	for _, entry := range r.timers {
		list = append(list, entry.info)
	}
	for i := 1; i < len(list); i++ { // 按启动时间排序，便于前端稳定展示
		for j := i; j > 0 && list[j].StartMs < list[j-1].StartMs; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	return list
}

// start 启动一个计时器，返回启动后的全量列表与新计时器。
func (r *aiTimerRegistry) start(mode string, seconds int, label string) (AITimerStartResult, error) {
	empty := AITimerStartResult{}
	if mode != "countdown" && mode != "countup" {
		return empty, fmt.Errorf("mode 必须是 countdown 或 countup")
	}
	if mode == "countdown" && (seconds < 1 || seconds > aiTimerMaxSeconds) {
		return empty, fmt.Errorf("倒计时时长须在 1–%d 秒之间", aiTimerMaxSeconds)
	}
	if seconds > aiTimerMaxSeconds {
		return empty, fmt.Errorf("计时时长上限为 %d 秒", aiTimerMaxSeconds)
	}
	id, err := randomAITimerId()
	if err != nil {
		return empty, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.timers) >= aiTimerMaxActive {
		return empty, fmt.Errorf("最多同时运行 %d 个计时器，请先停止部分计时器", aiTimerMaxActive)
	}
	now := time.Now().UnixMilli()
	entry := &aiTimerEntry{info: AITimerInfo{Id: id, Mode: mode, Label: label, StartMs: now}}
	if mode == "countdown" {
		entry.info.EndMs = now + int64(seconds)*1000
		entry.timer = time.AfterFunc(time.Duration(seconds)*time.Second, func() { r.fire(id) })
	}
	r.timers[id] = entry
	return AITimerStartResult{List: r.listLocked(), Created: entry.info}, nil
}

// stop 停止指定计时器；返回剩余列表与被停计时器信息（正计时的已计时长由前端按 now-StartMs 计算）。
func (r *aiTimerRegistry) stop(id string) (AITimerStopResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := AITimerStopResult{List: r.listLocked()}
	entry, ok := r.timers[id]
	if !ok {
		return result, nil
	}
	if entry.timer != nil {
		entry.timer.Stop()
	}
	result.Stopped = entry.info
	result.Found = true
	delete(r.timers, id)
	result.List = r.listLocked()
	return result, nil
}

// list 当前全部计时器快照。
func (r *aiTimerRegistry) list() []AITimerInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listLocked()
}

// fire 倒计时到点（AfterFunc 回调）：从注册表移除并触发 onFire。
func (r *aiTimerRegistry) fire(id string) {
	r.mu.Lock()
	entry, ok := r.timers[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	info := entry.info
	delete(r.timers, id)
	r.mu.Unlock()
	if r.onFire != nil {
		r.onFire(info)
	}
}

// aiTimersIf 惰性初始化注册表（NewApp 零值构造，字段按需创建）。
func (a *App) aiTimersIf() *aiTimerRegistry {
	a.aiTimersMu.Lock()
	defer a.aiTimersMu.Unlock()
	if a.aiTimers == nil {
		a.aiTimers = newAITimerRegistry(func(info AITimerInfo) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "ai-timer-fired", info)
			}
		})
	}
	return a.aiTimers
}

// StartTimer 启动计时器（前端 AI 工具 start_timer 调用）。
func (a *App) StartTimer(mode string, seconds int, label string) (AITimerStartResult, error) {
	return a.aiTimersIf().start(mode, seconds, label)
}

// StopTimer 停止计时器（前端 AI 工具 stop_timer 调用），并广播停止事件让各窗口清掉胶囊。
func (a *App) StopTimer(id string) (AITimerStopResult, error) {
	result, err := a.aiTimersIf().stop(id)
	if err != nil {
		return result, err
	}
	if result.Found && a.ctx != nil {
		runtime.EventsEmit(a.ctx, "ai-timer-stopped", result.Stopped)
	}
	return result, nil
}

// ListTimers 当前运行中的计时器（面板重开/窗口重载时恢复胶囊）。
func (a *App) ListTimers() ([]AITimerInfo, error) {
	r := a.aiTimersIf()
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listLocked(), nil
}
