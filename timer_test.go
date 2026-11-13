package main

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestTimerRegistry() (*aiTimerRegistry, *[]AITimerInfo, *sync.Mutex) {
	fired := &[]AITimerInfo{}
	var mu sync.Mutex
	reg := newAITimerRegistry(func(info AITimerInfo) {
		mu.Lock()
		*fired = append(*fired, info)
		mu.Unlock()
	})
	return reg, fired, &mu
}

func TestAITimerStartValidation(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	tests := []struct {
		name    string
		mode    string
		seconds int
		wantErr string
	}{
		{name: "非法模式", mode: "alarm", seconds: 60, wantErr: "mode 必须是"},
		{name: "倒计时零秒", mode: "countdown", seconds: 0, wantErr: "倒计时时长须在"},
		{name: "倒计时负数", mode: "countdown", seconds: -5, wantErr: "倒计时时长须在"},
		{name: "超过 24 小时", mode: "countdown", seconds: 24*60*60 + 1, wantErr: "倒计时时长须在"},
		{name: "正计时超上限", mode: "countup", seconds: 24*60*60 + 1, wantErr: "计时时长上限"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := reg.start(tt.mode, tt.seconds, "测试")
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("start(%s, %d) 错误 = %v, 期望包含 %q", tt.mode, tt.seconds, err, tt.wantErr)
			}
		})
	}
}

func TestAITimerStartCountdownAndCountup(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	before := time.Now().UnixMilli()
	result, err := reg.start("countdown", 300, "等待构建")
	if err != nil {
		t.Fatalf("启动倒计时失败: %v", err)
	}
	created := result.Created
	if created.Mode != "countdown" || created.Label != "等待构建" {
		t.Fatalf("created 字段不符: %+v", created)
	}
	if created.EndMs != created.StartMs+300_000 {
		t.Fatalf("EndMs = %d, 期望 StartMs+300000", created.EndMs)
	}
	if created.StartMs < before-1000 || created.StartMs > time.Now().UnixMilli() {
		t.Fatalf("StartMs 不在合理时间范围内: %d", created.StartMs)
	}
	if len(result.List) != 1 || result.List[0].Id != created.Id {
		t.Fatalf("列表未包含新计时器: %+v", result.List)
	}
	// 正计时：seconds 被忽略，EndMs 为 0
	countupResult, err := reg.start("countup", 0, "调试计时")
	if err != nil {
		t.Fatalf("启动正计时失败: %v", err)
	}
	if countupResult.Created.EndMs != 0 {
		t.Fatalf("正计时 EndMs 应为 0, 实际 %d", countupResult.Created.EndMs)
	}
	if len(reg.list()) != 2 {
		t.Fatalf("注册表应有 2 个计时器, 实际 %d", len(reg.list()))
	}
}

func TestAITimerMaxActive(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	for i := 0; i < aiTimerMaxActive; i++ {
		if _, err := reg.start("countup", 0, "占用"); err != nil {
			t.Fatalf("第 %d 个计时器不应报错: %v", i+1, err)
		}
	}
	if _, err := reg.start("countup", 0, "超限"); err == nil || !strings.Contains(err.Error(), "最多同时运行") {
		t.Fatalf("超上限应报错, 实际 %v", err)
	}
}

func TestAITimerFireAndStop(t *testing.T) {
	reg, fired, mu := newTestTimerRegistry()
	first, _ := reg.start("countdown", 300, "倒计时")
	// 到点：移除并回调一次
	reg.fire(first.Created.Id)
	mu.Lock()
	count := len(*fired)
	mu.Unlock()
	if count != 1 {
		t.Fatalf("fire 应回调一次, 实际 %d", count)
	}
	if len(reg.list()) != 0 {
		t.Fatalf("到点后应从注册表移除, 剩余 %d", len(reg.list()))
	}
	// 重复 fire 不再回调
	reg.fire(first.Created.Id)
	mu.Lock()
	count = len(*fired)
	mu.Unlock()
	if count != 1 {
		t.Fatalf("重复 fire 不应回调, 实际 %d", count)
	}
	// 停止：AfterFunc 已 Stop，之后 fire 不回调
	created2, _ := reg.start("countdown", 300, "要停止的")
	stopResult, err := reg.stop(created2.Created.Id)
	if err != nil || !stopResult.Found || stopResult.Stopped.Id != created2.Created.Id {
		t.Fatalf("stop 返回不符: err=%v result=%+v", err, stopResult)
	}
	if len(stopResult.List) != 0 {
		t.Fatalf("停止后列表长度 = %d, 期望 0", len(stopResult.List))
	}
	reg.fire(created2.Created.Id)
	mu.Lock()
	count = len(*fired)
	mu.Unlock()
	if count != 1 {
		t.Fatalf("停止后 fire 不应回调, 实际 %d", count)
	}
	// 停止不存在的 id：Found=false 且不报错
	missing, err := reg.stop("t-not-exist")
	if err != nil || missing.Found {
		t.Fatalf("停止不存在的 id 应返回 Found=false, err=%v result=%+v", err, missing)
	}
}

func TestAITimerStopCountupElapsed(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	created, _ := reg.start("countup", 0, "正计时")
	time.Sleep(20 * time.Millisecond)
	stopResult, err := reg.stop(created.Created.Id)
	if err != nil || !stopResult.Found {
		t.Fatalf("停止正计时失败: err=%v", err)
	}
	if time.Now().UnixMilli()-stopResult.Stopped.StartMs < 15 {
		t.Fatalf("已计时长应 ≥15ms, StartMs=%d", stopResult.Stopped.StartMs)
	}
}

// AfterFunc 真实触发链路：1 秒倒计时到点回调 onFire。
func TestAITimerAfterFuncFires(t *testing.T) {
	reg, fired, mu := newTestTimerRegistry()
	created, err := reg.start("countdown", 1, "真实触发")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		firedCount := len(*fired)
		mu.Unlock()
		if firedCount == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	firedCount := len(*fired)
	mu.Unlock()
	t.Fatalf("3 秒内未收到到点回调（id=%s, 回调数=%d）", created.Created.Id, firedCount)
}
