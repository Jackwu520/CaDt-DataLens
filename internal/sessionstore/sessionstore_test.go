package sessionstore

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// seedSession 建一个带 header 的会话目录；WriteMeta/Rewrite 现在要求目录已存在。
func seedSession(t *testing.T, store *Store, id string) {
	t.Helper()
	if err := store.AppendWithCreate(id, "{}\n", true); err != nil {
		t.Fatal(err)
	}
}

func TestValidAISessionID(t *testing.T) {
	cases := []struct {
		id   string
		want bool
	}{
		{"session-mwbkc7pskomrq", true},
		{"a.b_c-1", true},
		{"", false},
		{".", false},
		{"..", false},
		{".hidden", false},
		{"../escape", false},
		{"a/b", false},
		{"a\\b", false},
		{"a b", false},
		{"CON", false},
		{"com1", false},
		{"console", true},
		{strings.Repeat("a", aiSessionIDMax+1), false},
	}
	for _, tc := range cases {
		if got := ValidSessionID(tc.id); got != tc.want {
			t.Errorf("ValidSessionID(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

func TestAISessionStoreAppendRead(t *testing.T) {
	store := New(t.TempDir())
	if err := store.Append("s1", `{"t":"header"}`); err != nil {
		t.Fatal(err)
	}
	if err := store.Append("s1", `{"t":"msg","n":1}`+"\n"); err != nil {
		t.Fatal(err)
	}
	got, err := store.Read("s1")
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"t\":\"header\"}\n{\"t\":\"msg\",\"n\":1}\n"
	if got != want {
		t.Fatalf("read = %q, want %q", got, want)
	}
}

func TestAISessionStoreReadMissingIsEmpty(t *testing.T) {
	store := New(t.TempDir())
	got, err := store.Read("nope")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("read = %q, want empty", got)
	}
}

func TestAISessionStoreRepairsTornTail(t *testing.T) {
	root := t.TempDir()
	store := New(root)
	dir := filepath.Join(root, "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, aiSessionLogName), []byte("{\"ok\":1}\n{\"torn\":"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := store.Append("s1", `{"next":2}`); err != nil {
		t.Fatal(err)
	}
	got, err := store.Read("s1")
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"ok\":1}\n{\"next\":2}\n"
	if got != want {
		t.Fatalf("read = %q, want %q", got, want)
	}
}

func TestAISessionStoreRepairsHeaderlessTail(t *testing.T) {
	root := t.TempDir()
	store := New(root)
	dir := filepath.Join(root, "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, aiSessionLogName), []byte(`{"torn"`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := store.Append("s1", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Read("s1")
	if got != "{\"a\":1}\n" {
		t.Fatalf("read = %q", got)
	}
}

func TestAISessionStoreRewrite(t *testing.T) {
	store := New(t.TempDir())
	if err := store.Append("s1", "old\n"); err != nil {
		t.Fatal(err)
	}
	if err := store.Rewrite("s1", "new\n"); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Read("s1")
	if got != "new\n" {
		t.Fatalf("read = %q, want new", got)
	}
	entries, err := os.ReadDir(filepath.Join(store.Root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("临时文件未清理：%s", entry.Name())
		}
	}
}

func TestAISessionStoreMetaList(t *testing.T) {
	store := New(t.TempDir())
	seedSession(t, store, "s1")
	seedSession(t, store, "s2")
	seedSession(t, store, "s4")
	if err := store.WriteMeta("s1", `{"id":"s1","title":"一"}`); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta("s2", `{"id":"s2","title":"二"}`); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta("s1", `{"id":"s1","title":"改名"}`); err != nil {
		t.Fatal(err)
	}
	// 没有 meta 的目录、非法名字的目录都要被跳过
	if err := os.MkdirAll(filepath.Join(store.Root, "s3"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(store.Root, "_migration-backup"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta("s4", `{broken`); err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("list 数量 = %d, want 2：%v", len(list), list)
	}
	joined := strings.Join(list, "\n")
	if !strings.Contains(joined, `"title":"改名"`) || !strings.Contains(joined, `"title":"二"`) {
		t.Fatalf("list 内容异常：%s", joined)
	}
}

func TestAISessionStoreRejectsTraversal(t *testing.T) {
	store := New(t.TempDir())
	if err := store.Append("../x", "1\n"); err == nil {
		t.Fatal("append 应拒绝越界 id")
	}
	if _, err := store.Read("../../x"); err == nil {
		t.Fatal("read 应拒绝越界 id")
	}
	if err := store.WriteMeta("a/b", "{}"); err == nil {
		t.Fatal("writeMeta 应拒绝越界 id")
	}
}

func TestAISessionStoreDelete(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	if err := store.Append("s1", "x\n"); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, "s1")); !os.IsNotExist(err) {
		t.Fatalf("会话目录未删除：%v", err)
	}
	if err := store.Remove("s1"); err != nil {
		t.Fatalf("重复删除应静默：%v", err)
	}
}

func TestAISessionStoreDeleteAll(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	seedSession(t, store, "s1")
	seedSession(t, store, "s2")
	if err := store.WriteMeta("s1", "{}"); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta("s2", "{}"); err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.Root); !os.IsNotExist(err) {
		t.Fatalf("会话根目录未删除：%v", err)
	}
}

func TestAISessionStoreListFallsBackToHeader(t *testing.T) {
	store := New(t.TempDir())
	seedSession(t, store, "s1")
	if err := store.WriteMeta("s1", `{"id":"s1","title":"正常"}`); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(store.Root, "s2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	header := `{"v":1,"t":"header","id":"s2","title":"只有正文","createdAt":123,"workspace":"D:/w"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, aiSessionLogName), []byte(header), 0o644); err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("list 数量 = %d, want 2：%v", len(list), list)
	}
	var found bool
	for _, raw := range list {
		if strings.Contains(raw, `"id":"s2"`) && strings.Contains(raw, `"title":"只有正文"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("未从 header 兜底生成 s2：%v", list)
	}
}

func TestValidAISessionImageName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"img-1.png", true},
		{"a.b_c-1.webp", true},
		{"", false},
		{".hidden", false},
		{"a.exe", false},
		{"noext", false},
		{"CON.png", false},
		{"../x.png", false},
		{"a/b.png", false},
		{"a\b.png", false},
		{strings.Repeat("a", aiSessionImageMax+1), false},
	}
	for _, tc := range cases {
		if got := validSessionImageName(tc.name); got != tc.want {
			t.Errorf("validSessionImageName(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestAISessionStoreImagePathRejectsTraversal(t *testing.T) {
	store := New(t.TempDir())
	if _, err := store.ImagePath("s1", "../escape.png"); err == nil {
		t.Fatal("imagePath 应拒绝 ../")
	}
	if _, err := store.ImagePath("../s1", "a.png"); err == nil {
		t.Fatal("imagePath 应拒绝越界会话 id")
	}
	got, err := store.ImagePath("s1", "img-1.png")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got, filepath.Join("s1", ImagesDir, "img-1.png")) {
		t.Fatalf("imagePath = %q", got)
	}
}

func TestAISessionStoreTombstoneBlocksResurrection(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	if err := store.Append("s1", "{}\n"); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("s1"); err != nil {
		t.Fatal(err)
	}
	if err := store.Append("s1", "{}\n"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("删除后 Append 应返回 ErrSessionGone，得到 %v", err)
	}
	if err := store.AppendWithCreate("s1", "{}\n", true); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("删除后 allowCreate 也必须被墓碑挡住，得到 %v", err)
	}
	if err := store.WriteMeta("s1", "{}"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("删除后 WriteMeta 应返回 ErrSessionGone，得到 %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, "s1")); !os.IsNotExist(err) {
		t.Fatalf("墓碑存在时不应重建会话目录：%v", err)
	}
}
