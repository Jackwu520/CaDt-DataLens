package plugins

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadPluginAsset(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &Manager{}
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatalf("SetPluginsPathMode: %v", err)
	}
	root, err := pluginsRootFor("appdata")
	if err != nil {
		t.Fatalf("pluginsRootFor: %v", err)
	}
	dir := filepath.Join(root, "demo")
	if err := os.MkdirAll(filepath.Join(dir, "images"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pluginManifestName), []byte(`{"id":"demo","name":"Demo","author":"CandySweet","entry":"main.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte("// demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01}
	assetPath := filepath.Join(dir, "images", "a.png")
	if err := os.WriteFile(assetPath, png, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "nomanifest"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nomanifest", "a.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := app.ReadPluginAsset("demo", "images/a.png")
	if err != nil {
		t.Fatalf("ReadPluginAsset: %v", err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	if got != want {
		t.Fatalf("data URL 不匹配：got %q", got)
	}
	if _, err := app.ReadPluginAsset("demo", `images\a.png`); err != nil {
		t.Fatalf("反斜杠路径应可用：%v", err)
	}
	// 数据/模型类资产（ONNX 语义分类器插件依赖：readAsset 读模型/分词器/worker 脚本）
	if err := os.MkdirAll(filepath.Join(dir, "model"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "model", "tokenizer.json"), []byte(`{"vocab":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "model", "model_quantized.onnx"), []byte("ONNX!"), 0o644); err != nil {
		t.Fatal(err)
	}
	dataAssets := []struct{ path, mime string }{
		{"main.js", "text/javascript"},
		{"model/tokenizer.json", "application/json"},
		{"model/model_quantized.onnx", "application/octet-stream"},
	}
	for _, c := range dataAssets {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(c.path)))
		if err != nil {
			t.Fatal(err)
		}
		gotData, err := app.ReadPluginAsset("demo", c.path)
		if err != nil {
			t.Fatalf("数据资产 %s 应可读：%v", c.path, err)
		}
		wantData := "data:" + c.mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
		if gotData != wantData {
			t.Fatalf("数据资产 %s data URL 不匹配：got %q", c.path, gotData[:40])
		}
	}
	// 未列入白名单的扩展名仍拒绝
	if _, err := app.ReadPluginAsset("demo", "model/model.bin.exe"); err == nil {
		t.Fatalf("未知扩展名应拒绝")
	}

	bad := []struct{ id, path string }{
		{"../demo", "images/a.png"},
		{"Bad/Id", "images/a.png"},
		{"demo", ""},
		{"demo", "../main.js"},
		{"demo", "images/../../main.js"},
		{"demo", "/images/a.png"},
		{"demo", "C:/images/a.png"},
		{"demo", "./images/a.png"},
		{"demo", "images//a.png"},
		{"demo", "images/missing.png"},
		{"demo", "images"},
		{"demo", "model/missing.onnx"},
		{"missing", "images/a.png"},
		{"nomanifest", "a.png"},
	}
	for _, c := range bad {
		if _, err := app.ReadPluginAsset(c.id, c.path); err == nil {
			t.Fatalf("应拒绝 id=%q path=%q", c.id, c.path)
		}
	}
}

func TestReadPluginAssetRejectsOversize(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &Manager{}
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatal(err)
	}
	root, err := pluginsRootFor("appdata")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "big")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pluginManifestName), []byte(`{"id":"big","name":"Big","author":"CandySweet","entry":"main.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte("// big"), 0o644); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, pluginAssetMaxSize+1)
	if err := os.WriteFile(filepath.Join(dir, "big.png"), buf, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := app.ReadPluginAsset("big", "big.png"); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("超大资产应被拒绝：%v", err)
	}
	// 分级上限：数据/模型类用独立大档（512MB，作者拍板）——16MB+1 的 onnx 应通过
	// （真模型 22MB），pluginDataAssetMaxSize+1 才拒绝。
	onnxBuf := make([]byte, pluginAssetMaxSize+1)
	if err := os.WriteFile(filepath.Join(dir, "model.onnx"), onnxBuf, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := app.ReadPluginAsset("big", "model.onnx"); err != nil {
		t.Fatalf("16MB+1 的 onnx 应通过（数据/模型大档）：%v", err)
	}
	bigOnnx, err := os.Create(filepath.Join(dir, "huge.onnx"))
	if err != nil {
		t.Fatal(err)
	}
	// 稀疏文件（Truncate 撑大小、不实分配内存）：size 检查阶段就会拒绝，不会真读内容。
	if err := bigOnnx.Truncate(pluginDataAssetMaxSize + 1); err != nil {
		t.Fatal(err)
	}
	bigOnnx.Close()
	if _, err := app.ReadPluginAsset("big", "huge.onnx"); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("超过数据/模型档上限的模型应被拒绝：%v", err)
	}
}
