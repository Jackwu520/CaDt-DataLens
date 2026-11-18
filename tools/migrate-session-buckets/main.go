// migrate-session-buckets：AI 会话存储平铺 → 工作区短哈希分桶 的一次性迁移工具。
//
// 背景：2026-11-19 起会话存储改为按工作区分桶（docs/unfinished-plans/session-workspace-buckets.md），
// 桶名 = sessionstore.WorkspaceBucketKey(workspace)（归一 key 的 sha256 前 8 hex；无工作区落 _unbound）。
// 迁移不进程序（不做启动迁移、不留双读兼容），由作者手动在**应用关闭后**执行本工具一次：
//
//	go run ./tools/migrate-session-buckets            # 演练（dry-run，只打印动作）
//	go run ./tools/migrate-session-buckets -apply     # 实际搬移
//
// 每个会话目录：读 meta.json 的 workspace（缺失/损坏时回退正文首行 header，与引擎
// synthesizeMetaFromHeader 同一兜底语义）→ 算桶 → 建桶 + 写 ws.json → rename 进桶。
// 占用中的目录（另一实例开着）rename 会失败：跳过并报告，等下次执行补收。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/sessionstore"
)

func main() {
	apply := flag.Bool("apply", false, "实际搬移（默认 dry-run 只打印动作）")
	verify := flag.Bool("verify", false, "迁移后核对：走真实引擎（NewBucketed().List()）数会话")
	flag.Parse()

	base := os.Getenv("APPDATA")
	if base == "" {
		fmt.Println("无法定位 APPDATA")
		os.Exit(1)
	}
	root := filepath.Join(base, "CandySweet", "CaDt-DataLens", sessionstore.SessionsDirName)
	if *verify {
		verifyLayout(root)
		return
	}
	fmt.Printf("会话根：%s（%s）\n", root, mode(*apply))

	entries, err := os.ReadDir(root)
	if err != nil {
		fmt.Printf("读根目录失败：%v\n", err)
		os.Exit(1)
	}
	moved, skipped, unbound := 0, 0, 0
	for _, entry := range entries {
		if !entry.IsDir() || !sessionstore.ValidSessionID(entry.Name()) {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		ws, err := sessionWorkspace(dir, entry.Name())
		if err != nil {
			fmt.Printf("[跳过] %s：读不到归属（%v）\n", entry.Name(), err)
			skipped++
			continue
		}
		if strings.TrimSpace(ws) == "" {
			unbound++
		}
		bucket := sessionstore.WorkspaceBucketKey(ws)
		bucketDir := filepath.Join(root, bucket)
		target := filepath.Join(bucketDir, entry.Name())
		if _, err := os.Stat(target); err == nil {
			fmt.Printf("[跳过] %s：目标已存在 %s\n", entry.Name(), target)
			skipped++
			continue
		}
		fmt.Printf("[%s] %s -> %s/%s（workspace=%q）\n", mode(*apply), entry.Name(), bucket, entry.Name(), ws)
		if !*apply {
			moved++
			continue
		}
		if err := os.MkdirAll(bucketDir, 0o755); err != nil {
			fmt.Printf("[失败] 建桶 %s：%v\n", bucketDir, err)
			skipped++
			continue
		}
		if ws := strings.TrimSpace(ws); ws != "" {
			if raw, err := json.Marshal(map[string]string{"workspace": ws}); err == nil {
				_ = os.WriteFile(filepath.Join(bucketDir, "ws.json"), raw, 0o644)
			}
		}
		if err := os.Rename(dir, target); err != nil {
			fmt.Printf("[失败] %s：%v（占用中的目录下次执行补收）\n", entry.Name(), err)
			skipped++
			continue
		}
		moved++
	}
	fmt.Printf("\n完成：%d 搬移 / %d 跳过 / %d 无工作区（_unbound）\n", moved, skipped, unbound)
	if !*apply {
		fmt.Println("dry-run 结束，确认无误后加 -apply 执行。")
	}
}

func mode(apply bool) string {
	if apply {
		return "搬移"
	}
	return "演练"
}

// verifyLayout 走真实引擎路径核对：NewBucketed().List() 应数出全部会话，
// 且每个 meta 的 workspace 反算桶名与所在桶一致。
func verifyLayout(root string) {
	os.Chdir(filepath.Dir(root)) // Default() 以 AppDataDir 推根，这里直接注入
	sessionstore.AppDataDir = func() string { return filepath.Dir(root) }
	store, err := sessionstore.Default()
	if err != nil {
		fmt.Printf("引擎初始化失败：%v\n", err)
		os.Exit(1)
	}
	metas, err := store.List()
	if err != nil {
		fmt.Printf("List 失败：%v\n", err)
		os.Exit(1)
	}
	bad := 0
	byBucket := map[string]int{}
	for _, raw := range metas {
		var meta struct {
			Id        string `json:"id"`
			Workspace string `json:"workspace"`
		}
		if json.Unmarshal([]byte(raw), &meta) != nil {
			bad++
			continue
		}
		dir, err := store.SessionDir(meta.Id)
		if err != nil {
			fmt.Printf("[坏] %s：按 id 扫桶找不到目录（%v）\n", meta.Id, err)
			bad++
			continue
		}
		rel, _ := filepath.Rel(root, dir)
		bucket := strings.Split(rel, string(filepath.Separator))[0]
		byBucket[bucket]++
		if want := sessionstore.WorkspaceBucketKey(meta.Workspace); bucket != want {
			fmt.Printf("[错位] %s：在桶 %s，按 workspace 应落 %s\n", meta.Id, bucket, want)
			bad++
		}
	}
	fmt.Printf("核对：List 数出 %d 个会话，%d 个异常；分布 %v\n", len(metas), bad, byBucket)
	if bad != 0 {
		os.Exit(1)
	}
}

// sessionWorkspace 读会话归属：meta.json 优先，缺失/损坏回退正文首行 header。
func sessionWorkspace(dir, id string) (string, error) {
	if raw, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil && len(raw) <= 1<<20 && json.Valid(raw) {
		var meta struct {
			Workspace string `json:"workspace"`
		}
		if json.Unmarshal(raw, &meta) == nil {
			return meta.Workspace, nil
		}
	}
	f, err := os.Open(filepath.Join(dir, "session.v1.jsonl"))
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n, _ := f.Read(buf)
	line := string(buf[:n])
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var header struct {
		T         string `json:"t"`
		Workspace string `json:"workspace"`
	}
	if json.Unmarshal([]byte(line), &header) != nil || header.T != "header" {
		return "", fmt.Errorf("首行不是 header")
	}
	return header.Workspace, nil
}
