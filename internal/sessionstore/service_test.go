package sessionstore

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

func withServiceAppData(t *testing.T) {
	t.Helper()
	old := AppDataDir
	dir := t.TempDir()
	AppDataDir = func() string { return dir }
	t.Cleanup(func() { AppDataDir = old })
}

func TestServiceSessionLifecycle(t *testing.T) {
	withServiceAppData(t)
	oldBody, oldMeta, oldRemove, oldClear := OnBodyChange, OnMetaChange, OnRemove, OnClear
	t.Cleanup(func() {
		OnBodyChange, OnMetaChange, OnRemove, OnClear = oldBody, oldMeta, oldRemove, oldClear
	})
	var bodies, metas []string
	removed, cleared := "", false
	OnBodyChange = func(id string) { bodies = append(bodies, id) }
	OnMetaChange = func(id, data string) { metas = append(metas, id+"|"+data) }
	OnRemove = func(id string) { removed = id }
	OnClear = func() { cleared = true }

	svc := &Service{}
	root, err := svc.AISessionStoreRoot()
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("会话根目录未创建: %v", err)
	}
	if err := svc.AISessionAppend("s1", `{"t":"header"}`, true); err != nil {
		t.Fatal(err)
	}
	if err := svc.AISessionRewrite("s1", `{"t":"header"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AISessionWriteMeta("s1", `{"title":"x"}`); err != nil {
		t.Fatal(err)
	}
	list, err := svc.AISessionList()
	if err != nil || len(list) != 1 || !strings.Contains(list[0], `"x"`) {
		t.Fatalf("list = %#v, err = %v", list, err)
	}
	body, err := svc.AISessionRead("s1")
	if err != nil {
		t.Fatal(err)
	}
	if body != "{\"t\":\"header\"}\n" {
		t.Fatalf("body = %q", body)
	}
	if err := svc.AISessionDelete("s1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AISessionDeleteAll(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(bodies, ",") != "s1,s1" {
		t.Fatalf("正文标脏 = %#v", bodies)
	}
	if len(metas) != 1 || metas[0] != `s1|{"title":"x"}` {
		t.Fatalf("meta 标脏 = %#v", metas)
	}
	if removed != "s1" || !cleared {
		t.Fatalf("removed = %q, cleared = %v", removed, cleared)
	}
}

func TestServiceImageRoundTrip(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	raw := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
	rel, err := svc.AISessionSaveImage("s1", "shot.png", dataURL)
	if err != nil {
		t.Fatal(err)
	}
	if rel != "images/shot.png" {
		t.Fatalf("rel = %q", rel)
	}
	got, err := svc.AISessionReadImage("s1", "shot.png")
	if err != nil {
		t.Fatal(err)
	}
	if got != dataURL {
		t.Fatalf("data URL 不一致: %q", got)
	}
	if _, err := svc.AISessionSaveImage("s1", "big.png", "data:image/png;base64,"+strings.Repeat("A", 17<<20)); err == nil {
		t.Fatal("超大图片应报错")
	}
	if _, err := svc.AISessionReadImage("s1", "../meta.json"); err == nil {
		t.Fatal("路径穿越应报错")
	}
}

// 视频落盘往返：与图片同构，落 videos/ 子目录；超限与路径穿越拒绝。
func TestServiceVideoRoundTrip(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	mp4 := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 1, 2, 3}
	dataURL := "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(mp4)
	rel, err := svc.AISessionSaveVideo("s1", "clip.mp4", dataURL)
	if err != nil {
		t.Fatal(err)
	}
	if rel != "videos/clip.mp4" {
		t.Fatalf("rel = %q", rel)
	}
	got, err := svc.AISessionReadVideo("s1", "clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if got != dataURL {
		t.Fatalf("data URL 不一致: %q", got)
	}
	if _, err := svc.AISessionSaveVideo("s1", "big.mp4", "data:video/mp4;base64,"+strings.Repeat("A", 25<<20)); err == nil {
		t.Fatal("超大视频应报错")
	}
	if _, err := svc.AISessionReadVideo("s1", "../meta.json"); err == nil {
		t.Fatal("路径穿越应报错")
	}
	// 读回非 mp4 内容（落盘后被人改过）也要拒绝
	if _, err := svc.AISessionSaveVideo("s1", "fake.mp4", "data:video/mp4;base64,"+base64.StdEncoding.EncodeToString([]byte("plain"))); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AISessionReadVideo("s1", "fake.mp4"); err == nil {
		t.Fatal("非 mp4 内容应拒绝")
	}
}
