package main

import "testing"

func TestPayloadString(t *testing.T) {
	cases := []struct {
		name  string
		data  any
		field string
		want  string
	}{
		{"map-string id", map[string]string{"id": "t1", "data": "x"}, "id", "t1"},
		{"map-any id", map[string]interface{}{"id": "b2"}, "id", "b2"},
		{"map-any requestID", map[string]interface{}{"requestID": "r3"}, "requestID", "r3"},
		{"missing", map[string]string{"x": "y"}, "id", ""},
		{"wrong type", map[string]interface{}{"id": 42}, "id", ""},
		{"nil", nil, "id", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := payloadString(tc.data, tc.field); got != tc.want {
				t.Fatalf("payloadString(%v, %q) = %q, want %q", tc.data, tc.field, got, tc.want)
			}
		})
	}
}

func TestEventOwnerRegistry(t *testing.T) {
	app := &App{}
	// 无窗口上下文：stateForCaller 回退主窗口；没有主窗口时记空，不 panic。
	if err := app.RegisterEventOwner(nil, "term", "t1"); err != nil {
		t.Fatal(err)
	}
	eventOwners.Lock()
	_, exists := eventOwners.m[ownerKey{"term", "t1"}]
	eventOwners.Unlock()
	if exists {
		t.Fatal("无窗口上下文不应登记 owner")
	}

	// 直接写入登记表，验证查找与摘除（routeOwnedEvent 的查表分支）。
	eventOwners.Lock()
	eventOwners.m[ownerKey{"term", "t2"}] = "main"
	eventOwners.Unlock()
	if err := app.UnregisterEventOwner(nil, "term", "t2"); err != nil {
		t.Fatal(err)
	}
	eventOwners.RLock()
	_, exists = eventOwners.m[ownerKey{"term", "t2"}]
	eventOwners.RUnlock()
	if exists {
		t.Fatal("UnregisterEventOwner 未摘除登记")
	}
}
