package memo

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func withDeps(t *testing.T, dir string) {
	t.Helper()
	base := dir
	SetDeps(Deps{AppDataDir: func() string { return base }})
	t.Cleanup(func() { SetDeps(Deps{}) })
}

func pngDataURL(size int) string {
	raw := make([]byte, size)
	copy(raw, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
}

func mtimeOf(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.ModTime().UnixMilli()
}

func TestLoadMissingReturnsDefault(t *testing.T) {
	withDeps(t, t.TempDir())
	out, err := Load("workspace", filepath.Join(t.TempDir(), "ws"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var env envelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("信封解析失败: %v", err)
	}
	if env.Data != defaultDoc() || env.MtimeMs != 0 {
		t.Fatalf("缺文件应返回默认结构与 mtime=0，得到 %s", out)
	}
}

func TestSaveLoadRoundtripAndCAS(t *testing.T) {
	withDeps(t, t.TempDir())
	ws := t.TempDir()

	// 首次保存：base=0，写成功并回传新 mtime
	first := Save("workspace", ws, `{"version":1,"blocks":[]}`, 0)
	if !first.OK || first.MtimeMs == 0 {
		t.Fatalf("首次保存应成功并带回 mtime：%+v", first)
	}
	path := filepath.Join(ws, ".cadt", "memo", "memo.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("memo.json 未落盘: %v", err)
	}

	// 用正确 mtime 再写一次：成功
	second := Save("workspace", ws, `{"version":1,"blocks":[],"updatedAt":2}`, first.MtimeMs)
	if !second.OK {
		t.Fatalf("mtime 相符应写成功：%+v", second)
	}

	// 用过期 mtime 写：报冲突
	stale := Save("workspace", ws, `{"version":1,"blocks":[]}`, first.MtimeMs)
	if !stale.Conflict || !strings.HasPrefix(stale.Error, conflictPrefix) {
		t.Fatalf("过期 mtime 应报冲突：%+v", stale)
	}

	// base=0 但文件已存在（载入时没有、期间别人建了）：拒绝覆盖
	covered := Save("workspace", ws, `{"version":1,"blocks":[]}`, 0)
	if !covered.Conflict {
		t.Fatalf("base=0 且文件已存在应报冲突：%+v", covered)
	}

	// 读回：信封 data 与最后一次成功写入一致
	out, err := Load("workspace", ws)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var env envelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("信封解析失败: %v", err)
	}
	if !strings.Contains(env.Data, `"updatedAt":2`) {
		t.Fatalf("读回内容不符：%s", env.Data)
	}
	if env.MtimeMs == 0 {
		t.Fatalf("存在文件时 mtime 不应为 0")
	}
}

func TestSaveGlobalScope(t *testing.T) {
	base := t.TempDir()
	withDeps(t, base)
	res := Save("global", "", `{"version":1,"blocks":[]}`, 0)
	if !res.OK {
		t.Fatalf("全局保存失败：%+v", res)
	}
	if _, err := os.Stat(filepath.Join(base, "memo", "memo.json")); err != nil {
		t.Fatalf("全局 memo.json 未落盘: %v", err)
	}
}

func TestSaveValidation(t *testing.T) {
	withDeps(t, t.TempDir())
	ws := t.TempDir()
	cases := []struct {
		name    string
		scope   string
		ws      string
		doc     string
		wantErr string
	}{
		{"未知作用域", "other", "", "{}", "未知作用域"},
		{"工作区缺根", "workspace", "", "{}", "没有打开的工作区"},
		{"空内容", "workspace", ws, "  ", "没有可保存的内容"},
		{"坏 JSON", "workspace", ws, "{not json", "不是合法 JSON"},
		{"超尺寸", "global", "", `{"pad":"` + strings.Repeat("x", docLimitBytes) + `"}`, "超过上限"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := Save(tc.scope, tc.ws, tc.doc, 0)
			if res.OK || res.Conflict || !strings.Contains(res.Error, tc.wantErr) {
				t.Fatalf("应报 %q，得到 %+v", tc.wantErr, res)
			}
		})
	}
}

func TestSaveBadJSONFileFallsBackToDefault(t *testing.T) {
	withDeps(t, t.TempDir())
	ws := t.TempDir()
	path := filepath.Join(ws, ".cadt", "memo", "memo.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := Load("workspace", ws)
	if err != nil {
		t.Fatalf("坏 JSON 不应让 Load 失败: %v", err)
	}
	var env envelope
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatal(err)
	}
	if env.Data != defaultDoc() || env.MtimeMs == 0 {
		t.Fatalf("坏 JSON 应兜底默认结构且保留真实 mtime：%s", out)
	}
}

func TestSaveImage(t *testing.T) {
	withDeps(t, t.TempDir())
	ws := t.TempDir()

	rel, err := SaveImage("workspace", ws, pngDataURL(64))
	if err != nil {
		t.Fatalf("SaveImage: %v", err)
	}
	if !strings.HasPrefix(rel, "img/img-") || !strings.HasSuffix(rel, ".png") {
		t.Fatalf("返回路径不符：%s", rel)
	}
	raw, err := os.ReadFile(filepath.Join(ws, ".cadt", "memo", filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("贴图未落盘: %v", err)
	}
	if len(raw) != 64 {
		t.Fatalf("字节数不符：%d", len(raw))
	}

	// 全局作用域同理
	if _, err := SaveImage("global", "", pngDataURL(8)); err != nil {
		t.Fatalf("全局贴图失败: %v", err)
	}
}

func TestSaveImageRejects(t *testing.T) {
	withDeps(t, t.TempDir())
	ws := t.TempDir()
	// 非 base64 data URL
	if _, err := SaveImage("workspace", ws, "data:image/png,hello"); err == nil {
		t.Fatal("非 base64 应拒绝")
	}
	// 魔数不认识的类型：声明 png、实际是文本
	fake := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not an image at all"))
	if _, err := SaveImage("workspace", ws, fake); err == nil || !strings.Contains(err.Error(), "不支持的图片类型") {
		t.Fatalf("魔数不符应拒绝: %v", err)
	}
	// 超尺寸
	big := "data:image/png;base64," + base64.StdEncoding.EncodeToString(make([]byte, imageLimitBytes+1))
	if _, err := SaveImage("workspace", ws, big); err == nil || !strings.Contains(err.Error(), "超过大小上限") {
		t.Fatalf("超尺寸应拒绝: %v", err)
	}
}

func TestWorkspacePathIsFixedInsideWorkspace(t *testing.T) {
	withDeps(t, t.TempDir())
	// memo 目录由引擎拼装（<ws>/.cadt/memo），workspace 参数传什么都改不了目标，
	// 越界只可能来自 workspace 本身被换掉——验证Abs后仍在工作区内即可。
	ws := filepath.Join(t.TempDir(), "proj")
	res := Save("workspace", ws, `{"version":1,"blocks":[]}`, 0)
	if !res.OK {
		t.Fatalf("保存失败：%+v", res)
	}
	path := filepath.Join(ws, ".cadt", "memo", "memo.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("应落在工作区内: %v", err)
	}
}

func TestMtimeSlackToleratesPrecision(t *testing.T) {
	// CAS 比对放宽 2 秒：同一次写入后立刻用同一 mtime 重复保存不应误判冲突
	withDeps(t, t.TempDir())
	ws := t.TempDir()
	if res := Save("workspace", ws, `{"version":1,"blocks":[]}`, 0); !res.OK {
		t.Fatalf("首次保存失败：%+v", res)
	}
	path := filepath.Join(ws, ".cadt", "memo", "memo.json")
	mt := mtimeOf(t, path)
	time.Sleep(5 * time.Millisecond)
	if res := Save("workspace", ws, `{"version":1,"blocks":[],"n":1}`, mt); !res.OK {
		t.Fatalf("同 mtime 重写不应冲突：%+v", res)
	}
}
