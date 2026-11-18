package aigroups

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) (*Store, string, *[]string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "ai-groups")
	st := New(root)
	if err := st.EnsureRoot(); err != nil {
		t.Fatalf("EnsureRoot: %v", err)
	}
	recycled := &[]string{}
	st.sessions.DeleteFn = func(path string) error {
		*recycled = append(*recycled, path)
		return os.RemoveAll(path)
	}
	return st, root, recycled
}

func TestValidIDs(t *testing.T) {
	if !ValidGroupID("group-m5x2-c3d") || !ValidAgentID("agent-a1b") {
		t.Fatal("合法 ID 被拒绝")
	}
	for _, bad := range []string{"", "..", "a/b", `a\b`, ".hide", "con", "a b", strings.Repeat("x", 129)} {
		if ValidGroupID(bad) {
			t.Fatalf("非法群 ID 被放行：%q", bad)
		}
		if ValidAgentID(bad) {
			t.Fatalf("非法智能体 ID 被放行：%q", bad)
		}
	}
}

func TestSharedLogAppendReadMeta(t *testing.T) {
	st, _, _ := newTestStore(t)
	id := "group-t1"
	if err := st.Append(id, `{"kind":"header","v":2}`+"\n"+`{"kind":"msg","gid":"gm-1"}`); err != nil {
		t.Fatalf("Append: %v", err)
	}
	meta := `{"v":2,"kind":"group","id":"group-t1","title":"评审"}`
	if err := st.WriteMeta(id, meta); err != nil {
		t.Fatalf("WriteMeta: %v", err)
	}
	// 再追加一批（无尾换行也要正确落行）
	if err := st.Append(id, `{"kind":"msg","gid":"gm-2"}`); err != nil {
		t.Fatalf("Append#2: %v", err)
	}
	body, err := st.Read(id)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("期望 3 行，得 %d：%q", len(lines), body)
	}
	metas, err := st.List()
	if err != nil || len(metas) != 1 || !strings.Contains(metas[0], `"group-t1"`) {
		t.Fatalf("List: %v %v", metas, err)
	}
}

func TestSharedLogRewrite(t *testing.T) {
	st, _, _ := newTestStore(t)
	id := "group-rw"
	if err := st.Append(id, "old\n"); err != nil {
		t.Fatal(err)
	}
	if err := st.Rewrite(id, `{"kind":"msg","gid":"gm-new"}`+"\n"); err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	body, _ := st.Read(id)
	if !strings.Contains(body, "gm-new") || strings.Contains(body, "old") {
		t.Fatalf("Rewrite 后正文不对：%q", body)
	}
}

func TestRemoveGoesToRecycleBin(t *testing.T) {
	st, root, recycled := newTestStore(t)
	id := "group-del"
	if err := st.Append(id, "x\n"); err != nil {
		t.Fatal(err)
	}
	if err := st.Remove(id); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(*recycled) != 1 || !strings.HasSuffix((*recycled)[0], id) {
		t.Fatalf("删除未走回收站回调：%v", *recycled)
	}
	if _, err := os.Stat(filepath.Join(root, id)); !os.IsNotExist(err) {
		t.Fatal("删除后目录仍在")
	}
	// RemoveAll
	if err := st.Append("group-a", "x\n"); err != nil {
		t.Fatal(err)
	}
	if err := st.RemoveAll(); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	if len(*recycled) != 2 {
		t.Fatalf("RemoveAll 未进回收站：%v", *recycled)
	}
}

func TestPrivateLogLifecycle(t *testing.T) {
	st, root, _ := newTestStore(t)
	group, agent := "group-p1", "agent-a"
	// 读不存在的私有日志 → 空串
	if body, err := st.PrivateRead(group, agent); err != nil || body != "" {
		t.Fatalf("空读：%q %v", body, err)
	}
	if err := st.PrivateAppend(group, agent, `{"gid":"gm-1","steps":[]}`+"\n"+`{"gid":"gm-2"}`); err != nil {
		t.Fatalf("PrivateAppend: %v", err)
	}
	if err := st.PrivateAppend(group, agent, `{"gid":"gm-3"}`); err != nil {
		t.Fatalf("PrivateAppend#2: %v", err)
	}
	body, err := st.PrivateRead(group, agent)
	if err != nil {
		t.Fatalf("PrivateRead: %v", err)
	}
	if len(strings.Split(strings.TrimRight(body, "\n"), "\n")) != 3 {
		t.Fatalf("私有日志行数不对：%q", body)
	}
	want := filepath.Join(root, group, "private", agent+".jsonl")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("私有日志路径不对：%v", err)
	}
	// rewrite
	if err := st.PrivateRewrite(group, agent, `{"gid":"gm-clean"}`+"\n"); err != nil {
		t.Fatalf("PrivateRewrite: %v", err)
	}
	body, _ = st.PrivateRead(group, agent)
	if !strings.Contains(body, "gm-clean") || strings.Contains(body, "gm-1") {
		t.Fatalf("Rewrite 后私有日志不对：%q", body)
	}
	// 删群 → 私有日志随目录一起消失（回收站回调替换后直接检查目录）
	if err := st.Remove(group); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(want); !os.IsNotExist(err) {
		t.Fatal("删群后私有日志仍在")
	}
}

func TestPrivateLogRejectsBadIDs(t *testing.T) {
	st, _, _ := newTestStore(t)
	cases := []struct{ group, agent string }{
		{"..", "agent-a"},
		{"group-a", "../escape"},
		{"group-a", "a/b"},
		{"", "agent-a"},
		{"group-a", ""},
	}
	for _, c := range cases {
		if err := st.PrivateAppend(c.group, c.agent, "x\n"); err == nil {
			t.Fatalf("非法 ID 未被拒绝：group=%q agent=%q", c.group, c.agent)
		}
		if _, err := st.PrivateRead(c.group, c.agent); err == nil {
			t.Fatalf("非法 ID 读未拒绝：group=%q agent=%q", c.group, c.agent)
		}
	}
}

func TestPrivateAppendRepairsTornTail(t *testing.T) {
	st, root, _ := newTestStore(t)
	group, agent := "group-torn", "agent-a"
	if err := st.PrivateAppend(group, agent, "line1\n"); err != nil {
		t.Fatal(err)
	}
	// 模拟崩溃半行
	path := filepath.Join(root, group, "private", agent+".jsonl")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"gid":"gm-x`); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := st.PrivateAppend(group, agent, "line2\n"); err != nil {
		t.Fatalf("残行后追加失败：%v", err)
	}
	body, _ := st.PrivateRead(group, agent)
	if strings.Contains(body, "gm-x") {
		t.Fatalf("残行未被修复：%q", body)
	}
	if !strings.Contains(body, "line1\nline2\n") {
		t.Fatalf("修复后内容不对：%q", body)
	}
}
