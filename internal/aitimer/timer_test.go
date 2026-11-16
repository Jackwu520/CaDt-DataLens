package aitimer

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestTimerRegistry() (*Registry, *[]Info, *sync.Mutex) {
	fired := &[]Info{}
	var mu sync.Mutex
	reg := NewRegistry(
		func(info Info) {
			mu.Lock()
			*fired = append(*fired, info)
			mu.Unlock()
		},
		func(info Info) {
			mu.Lock()
			*fired = append(*fired, info) // autoStop 与 fire 共用捕获通道（事件名在 App 层区分）
			mu.Unlock()
		},
	)
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
			_, err := reg.Start(tt.mode, tt.seconds, "测试")
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("start(%s, %d) 错误 = %v, 期望包含 %q", tt.mode, tt.seconds, err, tt.wantErr)
			}
		})
	}
}

func TestAITimerStartCountdownAndCountup(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	before := time.Now().UnixMilli()
	result, err := reg.Start("countdown", 300, "等待构建")
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
	countupResult, err := reg.Start("countup", 0, "调试计时")
	if err != nil {
		t.Fatalf("启动正计时失败: %v", err)
	}
	if countupResult.Created.EndMs != 0 {
		t.Fatalf("正计时 EndMs 应为 0, 实际 %d", countupResult.Created.EndMs)
	}
	if len(reg.List()) != 2 {
		t.Fatalf("注册表应有 2 个计时器, 实际 %d", len(reg.List()))
	}
}

func TestAITimerMaxActive(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	for i := 0; i < aiTimerMaxActive; i++ {
		if _, err := reg.Start("countup", 0, "占用"); err != nil {
			t.Fatalf("第 %d 个计时器不应报错: %v", i+1, err)
		}
	}
	if _, err := reg.Start("countup", 0, "超限"); err == nil || !strings.Contains(err.Error(), "最多同时运行") {
		t.Fatalf("超上限应报错, 实际 %v", err)
	}
}

func TestAITimerFireAndStop(t *testing.T) {
	reg, fired, mu := newTestTimerRegistry()
	first, _ := reg.Start("countdown", 300, "倒计时")
	// 到点：移除并回调一次
	reg.fire(first.Created.Id)
	mu.Lock()
	count := len(*fired)
	mu.Unlock()
	if count != 1 {
		t.Fatalf("fire 应回调一次, 实际 %d", count)
	}
	if len(reg.List()) != 0 {
		t.Fatalf("到点后应从注册表移除, 剩余 %d", len(reg.List()))
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
	created2, _ := reg.Start("countdown", 300, "要停止的")
	stopResult, err := reg.Stop(created2.Created.Id)
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
	missing, err := reg.Stop("t-not-exist")
	if err != nil || missing.Found {
		t.Fatalf("停止不存在的 id 应返回 Found=false, err=%v result=%+v", err, missing)
	}
}

func TestAITimerStopCountupElapsed(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	created, _ := reg.Start("countup", 0, "正计时")
	time.Sleep(20 * time.Millisecond)
	stopResult, err := reg.Stop(created.Created.Id)
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
	created, err := reg.Start("countdown", 1, "真实触发")
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

func TestMark(t *testing.T) {
	reg, _, _ := newTestTimerRegistry()
	created, _ := reg.Start("countup", 0, "测耗时")
	id := created.Created.Id
	// 打两条标记（一针带备注、一针裸时刻）
	info1, err := reg.Mark(id, "阶段A完成")
	if err != nil || len(info1.Marks) != 1 || info1.Marks[0].Note != "阶段A完成" {
		t.Fatalf("第一条标记不符: err=%v info=%+v", err, info1)
	}
	info2, err := reg.Mark(id, "  ")
	if err != nil || len(info2.Marks) != 2 || info2.Marks[1].Note != "" {
		t.Fatalf("空白备注应归一为空: err=%v info=%+v", err, info2)
	}
	if info2.Marks[1].AtMs < info2.Marks[0].AtMs {
		t.Fatal("标记时刻应单调")
	}
	// 备注超长截断到 200 rune
	long := strings.Repeat("汉", 300)
	info3, err := reg.Mark(id, long)
	if err != nil {
		t.Fatalf("超长备注不应报错: %v", err)
	}
	if got := []rune(info3.Marks[2].Note); len(got) != aiTimerMarkNoteMaxRunes {
		t.Fatalf("备注应截断到 %d rune，实际 %d", aiTimerMarkNoteMaxRunes, len(got))
	}
	// 不存在的 id
	if _, err := reg.Mark("t-not-exist", "x"); err == nil {
		t.Fatal("不存在的计时器打标应报错")
	}
	// 停止后标记随 Stopped 信息带走（前端据此投递时间线）
	stopResult, _ := reg.Stop(id)
	if len(stopResult.Stopped.Marks) != 3 {
		t.Fatalf("停止结果应携带全部标记: %+v", stopResult.Stopped)
	}
	// 标记数上限
	reg2, _, _ := newTestTimerRegistry()
	c2, _ := reg2.Start("countup", 0, "洪泛")
	var lastErr error
	for i := 0; i < aiTimerMaxMarks+1; i++ {
		_, lastErr = reg2.Mark(c2.Created.Id, "")
	}
	if lastErr == nil {
		t.Fatal("超过标记数上限应报错")
	}
}

func TestAITimerCountupAutoStop(t *testing.T) {
	reg, fired, mu := newTestTimerRegistry()
	// 正计时 + 自动停止 1 秒：AfterFunc 到点从注册表移除并回调（Auto=true）
	created, err := reg.Start("countup", 1, "到点自动停")
	if err != nil {
		t.Fatalf("带自动停止的正计时应启动成功: %v", err)
	}
	if created.Created.AutoStopMs <= created.Created.StartMs {
		t.Fatalf("AutoStopMs 应晚于 StartMs: %+v", created.Created)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(*fired)
		mu.Unlock()
		if n >= 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*fired) != 1 {
		t.Fatalf("到点应自动停止并回调一次，实际 %d", len(*fired))
	}
	info := (*fired)[0]
	if !info.Auto || info.Mode != "countup" || info.Id != created.Created.Id {
		t.Fatalf("自动停止事件应带 Auto=true: %+v", info)
	}
	if len(reg.List()) != 0 {
		t.Fatalf("自动停止后应从注册表移除: %+v", reg.List())
	}
	// 手动 stop 的事件不带 Auto
	reg2, fired2, mu2 := newTestTimerRegistry()
	c2, _ := reg2.Start("countup", 0, "手动停")
	reg2.Stop(c2.Created.Id)
	mu2.Lock()
	defer mu2.Unlock()
	// 手动 stop 不走回调（事件由 App 层 StopTimer 发），捕获应为空
	if len(*fired2) != 0 {
		t.Fatalf("手动 stop 不应经回调通道: %+v", *fired2)
	}
}

func TestAITimerCountupNoAutoStop(t *testing.T) {
	reg, fired, mu := newTestTimerRegistry()
	// seconds=0：不设自动停止，等 300ms 也不该回调
	created, _ := reg.Start("countup", 0, "一直计")
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(*fired) != 0 {
		t.Fatalf("无自动停止的正计时不该到点回调: %+v", *fired)
	}
	if created.Created.AutoStopMs != 0 {
		t.Fatalf("seconds=0 时 AutoStopMs 应为 0: %+v", created.Created)
	}
	reg.Stop(created.Created.Id)
}
