package aitransport

// 本地限流器测试：RPM 滑动窗口、429 冻结回灌、排队可被 ctx 打断、排队事件。

import (
	"context"
	"testing"
	"time"
)

func testCfg(rpm int) Config {
	return Config{BaseURL: "https://rate.test/v1", Model: "test-model", RPMLimit: rpm}
}

func TestRateLimiterRPMWindow(t *testing.T) {
	resetRateLimiter()
	cfg := testCfg(2)
	key := rateKey(cfg)
	for i := 0; i < 2; i++ {
		if wait, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit); !ok {
			t.Fatalf("第 %d 次应放行，却要求等 %v", i+1, wait)
		}
	}
	wait, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit)
	if ok {
		t.Fatal("超过 RPM 上限仍放行")
	}
	if wait <= 0 || wait > rateWindow {
		t.Fatalf("等待时长应落在 (0, 1min]，实际 %v", wait)
	}
}

func TestRateLimiterUnlimitedTracksNothing(t *testing.T) {
	resetRateLimiter()
	cfg := testCfg(0)
	key := rateKey(cfg)
	for i := 0; i < 50; i++ {
		if _, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit); !ok {
			t.Fatal("不限速时应始终放行")
		}
	}
	if gate := aiRateLimiter.gates[key]; gate != nil && len(gate.stamps) != 0 {
		t.Fatalf("不限速时不该记账，实际记了 %d 条", len(gate.stamps))
	}
}

func TestRateLimiterKeyIsolatesModels(t *testing.T) {
	resetRateLimiter()
	a := testCfg(1)
	b := Config{BaseURL: "https://rate.test/v1", Model: "other-model", RPMLimit: 1}
	if _, ok := aiRateLimiter.tryAcquire(rateKey(a), a.RPMLimit); !ok {
		t.Fatal("模型 A 首次应放行")
	}
	// 模型 A 已占满，不能影响模型 B
	if _, ok := aiRateLimiter.tryAcquire(rateKey(b), b.RPMLimit); !ok {
		t.Fatal("不同模型应各算一份配额")
	}
}

func TestRateLimiterKeyNormalizesBaseURL(t *testing.T) {
	x := Config{BaseURL: "https://Rate.Test/v1/", Model: "m"}
	y := Config{BaseURL: "https://rate.test/v1", Model: "m"}
	if rateKey(x) != rateKey(y) {
		t.Fatalf("尾斜杠/大小写差异不应拆成两份配额：%q vs %q", rateKey(x), rateKey(y))
	}
}

func TestFreezeBlocksUntilExpiry(t *testing.T) {
	resetRateLimiter()
	cfg := testCfg(60)
	key := rateKey(cfg)
	aiRateLimiter.freezeUntil(key, time.Now().Add(120*time.Millisecond))
	if _, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit); ok {
		t.Fatal("冻结期内不该放行")
	}
	time.Sleep(150 * time.Millisecond)
	if _, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit); !ok {
		t.Fatal("冻结到期后应放行")
	}
}

func TestFreezeOnlyExtends(t *testing.T) {
	resetRateLimiter()
	key := "https://rate.test/v1|m"
	later := time.Now().Add(time.Hour)
	aiRateLimiter.freezeUntil(key, later)
	aiRateLimiter.freezeUntil(key, time.Now().Add(time.Minute))
	// 第二次更短，不应把冻结时间提前（否则后续请求会提前撞墙）
	aiRateLimiter.mu.Lock()
	got := aiRateLimiter.gates[key].frozenUntil
	aiRateLimiter.mu.Unlock()
	if !got.Equal(later) {
		t.Fatalf("冻结时间被缩短：期望 %v，实际 %v", later, got)
	}
}

func TestAcquireSlotRespectsContext(t *testing.T) {
	resetRateLimiter()
	cfg := testCfg(1)
	key := rateKey(cfg)
	if _, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit); !ok {
		t.Fatal("占位请求应放行")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := acquireSlot(ctx, cfg, "id-ctx", func(string, any) {}, func() {})
	if err == nil {
		t.Fatal("排队中 ctx 取消应返回错误")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("取消响应太慢：%v", elapsed)
	}
}

func TestAcquireSlotEmitsQueueEvent(t *testing.T) {
	resetRateLimiter()
	cfg := testCfg(1)
	key := rateKey(cfg)
	if _, ok := aiRateLimiter.tryAcquire(key, cfg.RPMLimit); !ok {
		t.Fatal("占位请求应放行")
	}
	var got []QueuePayload
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_ = acquireSlot(ctx, cfg, "id-q", func(event string, payload any) {
		if event != EventQueue {
			return
		}
		if p, ok := payload.(QueuePayload); ok {
			got = append(got, p)
		}
	}, func() {})
	if len(got) == 0 {
		t.Fatal("排队时应发出 ai-queue 事件，否则用户看到的是纯空转")
	}
	if got[0].Id != "id-q" || got[0].WaitMs <= 0 {
		t.Fatalf("排队事件内容不对：%+v", got[0])
	}
}

func TestAcquireSlotPassesThroughWhenUnconfigured(t *testing.T) {
	resetRateLimiter()
	cfg := testCfg(0)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	if err := acquireSlot(ctx, cfg, "id-fast", func(string, any) {}, func() {}); err != nil {
		t.Fatalf("未配置限速时不应报错：%v", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("未配置限速时不应有可感知延迟，实际 %v", elapsed)
	}
}
