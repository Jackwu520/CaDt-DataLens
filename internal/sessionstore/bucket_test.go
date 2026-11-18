package sessionstore

// bucket_test.go：工作区短哈希分桶布局的向量与流程测试。
// 哈希向量与前端 test/ai/ai-session-scope.test.mjs 的 workspaceKey 断言互为镜像：
// 两侧输入必须相同、归一语义必须一致（桶名只由 Go 侧计算，前端 key 用于 UI 分组对账）。

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceBucketKeyVectors(t *testing.T) {
	cases := []struct {
		name      string
		workspace string
		want      string
	}{
		{"本仓库工作区", `D:\OraSkyC\Project\CandySweet\CaDt-DataLens`, "35dc7bd8"},
		{"正斜杠同路径", "D:/OraSkyC/Project/CandySweet/CaDt-DataLens", "35dc7bd8"},
		{"尾斜杠", "D:/Foo/Bar/", "335d5c8a"},
		{"盘符与段大小写", `d:\Foo\BAR`, "335d5c8a"},
		{"叠斜杠", "D:/mixed//slashes/", "02f5a654"},
		{"点段清理", "a/./b/../c", "24586ae9"},
		{"URL scheme 保留", "file://D:/x/y", "d3934be2"},
		{"空工作区", "", UnboundBucketName},
		{"纯空白", "   ", UnboundBucketName},
		{"裸根斜杠", "/", UnboundBucketName},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := WorkspaceBucketKey(tc.workspace)
			if got != tc.want {
				t.Fatalf("WorkspaceBucketKey(%q) = %q, want %q", tc.workspace, got, tc.want)
			}
			if got != UnboundBucketName && !isBucketDirName(got) {
				t.Fatalf("桶名 %q 不满足 isBucketDirName", got)
			}
		})
	}
}

func TestIsBucketDirName(t *testing.T) {
	for _, ok := range []string{"35dc7bd8", "00000000", "ffffffff", UnboundBucketName} {
		if !isBucketDirName(ok) {
			t.Fatalf("%q 应识别为桶名", ok)
		}
	}
	for _, no := range []string{"session-x", ".locks", "35dc7bd", "35dc7bd88", "35DC7BD8", "zzzzzzzz", ""} {
		if isBucketDirName(no) {
			t.Fatalf("%q 不应识别为桶名", no)
		}
	}
}

// headerLine 造一条新会话首行 header（与 ai-session-disk.js 的 encodeSessionHeader 对齐）。
func headerLine(id, workspace string) string {
	raw, err := json.Marshal(map[string]string{
		"v": "1", "t": "header", "id": id, "title": "T", "workspace": workspace,
	})
	if err != nil {
		panic(err)
	}
	return string(raw) + "\n"
}

// TestBucketedCreateListAndResolve：新会话按 header.workspace 落桶、ws.json 写入、
// List 两层遍历、按 id 扫桶解析读写。
func TestBucketedCreateListAndResolve(t *testing.T) {
	store := NewBucketed(t.TempDir())
	ws := "D:/Work/Demo"
	id := "session-b1"
	if err := store.AppendWithCreate(id, headerLine(id, ws), true); err != nil {
		t.Fatal(err)
	}
	bucket := WorkspaceBucketKey(ws)
	dir := filepath.Join(store.Root, bucket, id)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("会话未落桶 %s: %v", dir, err)
	}
	if _, err := os.Stat(filepath.Join(dir, aiSessionLogName)); err != nil {
		t.Fatalf("正文未落盘: %v", err)
	}
	infoRaw, err := os.ReadFile(filepath.Join(store.Root, bucket, bucketInfoName))
	if err != nil {
		t.Fatalf("ws.json 未写入: %v", err)
	}
	var info map[string]string
	if err := json.Unmarshal(infoRaw, &info); err != nil || info["workspace"] != ws {
		t.Fatalf("ws.json = %s, err = %v", infoRaw, err)
	}

	// 按 id 扫桶解析：meta / 正文 / 追加都能找到同一目录。
	if err := store.WriteMeta(id, `{"id":"`+id+`","workspace":"`+ws+`","title":"x"}`); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendWithCreate(id, `{"t":"msg"}`+"\n", false); err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("List = %#v, err = %v", list, err)
	}
	if !strings.Contains(list[0], `"workspace":"`+ws+`"`) {
		t.Fatalf("meta 未保留 workspace: %s", list[0])
	}
	body, err := store.Read(id)
	if err != nil || body != headerLine(id, ws)+`{"t":"msg"}`+"\n" {
		t.Fatalf("body = %q, err = %v", body, err)
	}
}

// TestBucketedListTwoWorkspaces：两个工作区两个桶 + 无工作区落 _unbound，List 全收。
func TestBucketedListTwoWorkspaces(t *testing.T) {
	store := NewBucketed(t.TempDir())
	wsA := "D:/w/a"
	wsB := "D:/w/b"
	for i, ws := range []string{wsA, wsB, ""} {
		id := "session-" + []string{"a", "b", "u"}[i]
		if err := store.AppendWithCreate(id, headerLine(id, ws), true); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(listBucketNames(t, store.Root)); n != 3 {
		t.Fatalf("应有 3 个桶（含 _unbound），实际 %d：%v", n, listBucketNames(t, store.Root))
	}
	if _, err := os.Stat(filepath.Join(store.Root, UnboundBucketName, "session-u")); err != nil {
		t.Fatalf("无工作区会话未落 _unbound: %v", err)
	}
	list, err := store.List()
	if err != nil || len(list) != 3 {
		t.Fatalf("List = %d 项, err = %v", len(list), err)
	}
}

// TestBucketedExistingDirWins：目录已存在时扫桶命中优先，载荷里的 workspace 不参与落位。
func TestBucketedExistingDirWins(t *testing.T) {
	store := NewBucketed(t.TempDir())
	wsA := "D:/w/a"
	wsB := "D:/w/b"
	id := "session-move"
	if err := store.AppendWithCreate(id, headerLine(id, wsA), true); err != nil {
		t.Fatal(err)
	}
	// 修复兜底路径：载荷 header 里换了工作区，但目录已在 A 桶，不能搬走。
	if err := store.AppendWithCreate(id, headerLine(id, wsB), true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, WorkspaceBucketKey(wsA), id)); err != nil {
		t.Fatalf("现存目录应保持在原桶: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, WorkspaceBucketKey(wsB), id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("不应在 B 桶建目录: %v", err)
	}
}

// TestBucketedImageSaveThenHeaderConverge：新会话带附件时图片落盘先于正文 header，
// 两者必须落到同一个桶目录（附件归属由调用方传 workspace，header 追加时现存目录赢）。
func TestBucketedImageSaveThenHeaderConverge(t *testing.T) {
	store := NewBucketed(t.TempDir())
	ws := "D:/w/img"
	id := "session-img"
	// prepareImages 先落图：目录尚不存在，AISessionSaveImage 以 workspace 建目录。
	if err := store.withSessionLock(id, ws, true, func(dir string) error {
		return os.MkdirAll(filepath.Join(dir, ImagesDir), 0o755)
	}); err != nil {
		t.Fatal(err)
	}
	// 随后正文 header 追加必须命中同一个目录。
	if err := store.AppendWithCreate(id, headerLine(id, ws), true); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(store.Root, WorkspaceBucketKey(ws), id)
	if _, err := os.Stat(filepath.Join(dir, aiSessionLogName)); err != nil {
		t.Fatalf("正文应落进图片所在桶目录: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ImagesDir)); err != nil {
		t.Fatalf("图片目录不应移动: %v", err)
	}
}

// TestBucketedGoneWithoutDir：非创建路径对缺失会话报 ErrSessionGone，且不建目录。
func TestBucketedGoneWithoutDir(t *testing.T) {
	store := NewBucketed(t.TempDir())
	if err := store.WriteMeta("session-none", "{}"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("WriteMeta 应报 SessionGone, got %v", err)
	}
	if err := store.Rewrite("session-none", "x"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("Rewrite 应报 SessionGone, got %v", err)
	}
	if entries, _ := os.ReadDir(store.Root); len(entries) != 0 {
		// .locks 是租约文件的合法宿主（取会话独占租约时创建）；除它之外不应建任何目录。
		for _, entry := range entries {
			if entry.Name() != ".locks" {
				t.Fatalf("不应创建目录 %q", entry.Name())
			}
		}
	}
}

// TestBucketedRemoveCleansTombstoneFlow：删除走扫桶定位，删除后写墓碑、扇出写报 Gone。
func TestBucketedRemoveCleansTombstoneFlow(t *testing.T) {
	store := NewBucketed(t.TempDir())
	ws := "D:/w/del"
	id := "session-del"
	if err := store.AppendWithCreate(id, headerLine(id, ws), true); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, WorkspaceBucketKey(ws), id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("删除后会话目录应不存在: %v", err)
	}
	if err := store.AppendWithCreate(id, `{"t":"msg"}`+"\n", false); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("删除后追加应报 SessionGone, got %v", err)
	}
	// 不存在的会话删除：也写墓碑（与平铺语义一致）。
	if err := store.Remove("session-void"); err != nil {
		t.Fatalf("删除缺失会话应幂等: %v", err)
	}
}

// TestFlatLayoutUnchanged：New() 平铺语义保持（aigroups 依赖）。
func TestFlatLayoutUnchanged(t *testing.T) {
	store := New(t.TempDir())
	id := "session-flat"
	if err := store.AppendWithCreate(id, headerLine(id, "D:/w"), true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, id, aiSessionLogName)); err != nil {
		t.Fatalf("平铺布局应直接落 <root>/<id>: %v", err)
	}
	list, err := store.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("平铺 List = %d 项, err = %v", len(list), err)
	}
}

func listBucketNames(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() && isBucketDirName(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	return names
}
