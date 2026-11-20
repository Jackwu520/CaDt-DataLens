package main

// event_owner.go：流式事件的窗口归属路由（P2 可选收紧，P3 后补）。
//
// 终端 / 命令 / 运行 / 浏览器标签 / 阅读搜索的输出事件天然带 id。前端在创建资源后
// 调用 RegisterEventOwner(kind, id)（调用方窗口经 ctx 归属）；引擎 emit 时按 id 查
// 归属窗口：命中则用该窗口对象发射（sender=窗口名，其他窗口丢弃）；未命中（创建竞态，
// 事件先于创建返回）仍走应用级广播，由消费端按 id 过滤——与收紧前行为一致。

import (
	"context"
	"strings"
	"sync"
)

type ownerKey struct{ kind, id string }

var eventOwners = struct {
	sync.RWMutex
	m map[ownerKey]string
}{m: make(map[ownerKey]string)}

// eventOwnerLimit 防无界增长：浏览器标签等没有天然退出事件的资源靠上限兜底。
const eventOwnerLimit = 8192

// RegisterEventOwner 登记资源 id 属于调用方窗口。
func (a *App) RegisterEventOwner(ctx context.Context, kind, id string) error {
	name := callerWindowName(ctx)
	kind = strings.TrimSpace(kind)
	id = strings.TrimSpace(id)
	if name == "" || kind == "" || id == "" {
		return nil
	}
	eventOwners.Lock()
	if len(eventOwners.m) >= eventOwnerLimit {
		eventOwners.m = make(map[ownerKey]string)
	}
	eventOwners.m[ownerKey{kind, id}] = name
	eventOwners.Unlock()
	return nil
}

// UnregisterEventOwner 摘除登记（阅读搜索等一次性请求结束时调用）。
func (a *App) UnregisterEventOwner(ctx context.Context, kind, id string) error {
	eventOwners.Lock()
	delete(eventOwners.m, ownerKey{strings.TrimSpace(kind), strings.TrimSpace(id)})
	eventOwners.Unlock()
	return nil
}

// routeOwnedEvent 按 id 找归属窗口定向发射；未命中回退应用广播。
func routeOwnedEvent(kind, event string, data any) {
	field := "id"
	if kind == "reading" {
		field = "requestID"
	}
	id := payloadString(data, field)
	if id != "" {
		key := ownerKey{kind, id}
		eventOwners.RLock()
		name := eventOwners.m[key]
		eventOwners.RUnlock()
		if name != "" {
			if st := winReg.get(name); st != nil {
				if w := st.window(); w != nil {
					w.EmitEvent(event, data)
					if strings.HasSuffix(event, "-exit") {
						eventOwners.Lock()
						delete(eventOwners.m, key)
						eventOwners.Unlock()
					}
					return
				}
			}
		}
	}
	emitAppEvent(event, data)
}

// payloadString 从事件载荷里取字符串字段（各引擎载荷为 map[string]string 或 map[string]interface{}）。
func payloadString(data any, field string) string {
	switch v := data.(type) {
	case map[string]string:
		return v[field]
	case map[string]interface{}:
		if s, ok := v[field].(string); ok {
			return s
		}
	case interface{ GetID() string }:
		if field == "id" {
			return v.GetID()
		}
	}
	return ""
}
