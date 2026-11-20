package sessionindex

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"datalens/internal/sessionstore"
)

func newTestSessionIndex(t *testing.T) (*sql.DB, bool) {
	t.Helper()
	db, trigram, err := openSessionIndex(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, trigram
}

func TestReplayIndexEvents(t *testing.T) {
	raw := strings.Join([]string{
		`{"v":1,"t":"header","id":"s1"}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"甲","ts":1}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"assistant","content":"乙","ts":2}}`,
		`{"v":1,"t":"msg","mid":"m3","m":{"role":"user","content":"丙","ts":3}}`,
		`{"v":1,"t":"truncate","keep":2}`,
		`{"v":1,"t":"msg","mid":"m4","m":{"role":"user","content":"丁","ts":4}}`,
		`{"v":1,"t":"archive","keep":1}`,
		`{"v":1,"t":"msg","a":1,"mid":"m5","m":{"role":"user","content":"归档","ts":5}}`,
	}, "\n") + "\n"
	live, archived := replayIndexEvents(raw)
	if len(live) != 2 || live[0].Text != "乙" || live[1].Text != "丁" {
		t.Fatalf("live = %+v", live)
	}
	if len(archived) != 2 || archived[0].Text != "甲" || archived[1].Text != "归档" {
		t.Fatalf("archived = %+v", archived)
	}
}

func TestSessionIndexSearch(t *testing.T) {
	db, trigram := newTestSessionIndex(t)
	raw := strings.Join([]string{
		`{"v":1,"t":"header","id":"s1"}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"帮我搜索测试内容","ts":1}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"assistant","content":"搜索结果在这里","ts":2}}`,
		`{"v":1,"t":"msg","mid":"m3","m":{"role":"tool","name":"read_file","arguments":"{\"path\":\"a.json\"}","content":"读取成功","ts":3}}`,
	}, "\n") + "\n"
	if _, err := db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, message_count) VALUES('s1','搜索会话','D:/w',1,0)`); err != nil {
		t.Fatal(err)
	}
	if err := indexSessionLog(db, "s1", raw); err != nil {
		t.Fatal(err)
	}
	// 3 个字符：走 FTS trigram（若不可用则自动 LIKE）
	hits, err := searchSessionIndex(db, trigram, "搜索测", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatalf("trigram=%v 时 3 字查询应有结果", trigram)
	}
	if hits[0].SessionID != "s1" || hits[0].Kind != "message" {
		t.Fatalf("hits[0] = %+v", hits[0])
	}
	if !strings.Contains(hits[0].Snippet, "\x01") || !strings.Contains(hits[0].Snippet, "\x02") {
		t.Fatalf("snippet 应带匹配标记：%q", hits[0].Snippet)
	}
	// 2 个字符：走 LIKE
	hits, err = searchSessionIndex(db, trigram, "内容", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("2 字查询应有结果")
	}
	// 工具名/参数也能搜到
	hits, err = searchSessionIndex(db, trigram, "read_file", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("工具名应可搜索")
	}
}

func TestSessionIndexExcludesArchived(t *testing.T) {
	db, trigram := newTestSessionIndex(t)
	raw := strings.Join([]string{
		`{"v":1,"t":"header","id":"s1"}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"早已归档的内容","ts":1}}`,
		`{"v":1,"t":"archive","keep":1}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"仍在的消息","ts":2}}`,
	}, "\n") + "\n"
	if _, err := db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at) VALUES('s1','s1','',1)`); err != nil {
		t.Fatal(err)
	}
	if err := indexSessionLog(db, "s1", raw); err != nil {
		t.Fatal(err)
	}
	hits, err := searchSessionIndex(db, trigram, "早已归档", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, hit := range hits {
		if hit.Kind == "message" {
			t.Fatalf("归档消息不应出现在结果里：%+v", hit)
		}
	}
	hits, err = searchSessionIndex(db, trigram, "仍在", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("未归档消息应可搜索")
	}
}

func TestSyncSessionIndexRebuildsDirty(t *testing.T) {
	store := sessionstore.New(t.TempDir())
	if err := store.Append("s1", `{"v":1,"t":"header","id":"s1","title":"同步会话"}`+"\n"+
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"第一次同步","ts":1}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta("s1", `{"id":"s1","title":"同步会话","workspace":"D:/w","updatedAt":1,"messageCount":1}`); err != nil {
		t.Fatal(err)
	}
	db, trigram := newTestSessionIndex(t)
	if err := syncSessionIndex(db, store); err != nil {
		t.Fatal(err)
	}
	hits, err := searchSessionIndex(db, trigram, "第一次", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("同步后应能搜到第一条消息")
	}
	if err := store.Append("s1", `{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"后来新增的内容","ts":2}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE sessions SET dirty=1 WHERE id='s1'`); err != nil {
		t.Fatal(err)
	}
	if err := syncSessionIndex(db, store); err != nil {
		t.Fatal(err)
	}
	hits, err = searchSessionIndex(db, trigram, "后来新增", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("重建后应能搜到新增消息")
	}
}

// 回归：诊断面板调 Stats 只读索引状态，不能顺带重放脏会话——
// 否则长会话会把「正在分析会话数据…」卡住，用户得点「重建搜索索引」才出数据。
func TestStatsDoesNotRebuildDirtySessions(t *testing.T) {
	dir := t.TempDir()
	AppDataDir = func() string { return dir }
	t.Cleanup(func() { ResetFiles(); AppDataDir = nil })

	store := sessionstore.New(t.TempDir())
	header := `{"v":1,"t":"header","id":"s1","title":"诊断会话"}` + "\n"
	msg1 := `{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"第一次内容","ts":1}}` + "\n"
	if err := store.Append("s1", header+msg1); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta("s1", `{"id":"s1","title":"诊断会话","workspace":"D:/w","updatedAt":1,"messageCount":1}`); err != nil {
		t.Fatal(err)
	}
	// 先建索引（Search 会同步脏会话）
	if _, err := Search(store, "第一次", 10); err != nil {
		t.Fatal(err)
	}
	// 追加新消息并标脏，此时索引里还没有这条新内容
	if err := store.Append("s1", `{"v":1,"t":"msg","mid":"m2","m":{"role":"user","content":"后来新增","ts":2}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	MarkDirty("s1")

	stats, err := Stats(store)
	if err != nil {
		t.Fatal(err)
	}
	if !stats.Exists {
		t.Fatal("索引应已存在")
	}
	if stats.Dirty != 1 {
		t.Fatalf("Stats 不应重建脏会话，期望 dirty=1，实际 %d", stats.Dirty)
	}
}

func TestMakeSearchSnippetMarksMatch(t *testing.T) {
	snippet := makeSearchSnippet("前面一些内容，关键词在这里，后面还有一些内容", "关键词", 8)
	if !strings.Contains(snippet, "\x01关键词\x02") {
		t.Fatalf("snippet = %q", snippet)
	}
}

// 大小写不敏感定位必须在原文偏移上做：ASCII 折叠不能丢（命中原文大小写要原样高亮）。
func TestMakeSearchSnippetFoldsCase(t *testing.T) {
	snippet := makeSearchSnippet("Hello World tail", "world", 4)
	if !strings.Contains(snippet, "\x01World\x02") {
		t.Fatalf("snippet = %q", snippet)
	}
}

// 回归：U+023A Ⱥ / U+023E Ⱦ 小写后会变长（2 → 3 字节），旧实现用 strings.ToLower 的偏移
// 切原文：20 个 Ⱥ 让 lowerText 里的 pos=60 > len(text)=49，旧代码直接 slice bounds panic。
func TestMakeSearchSnippetExpandingLowerRune(t *testing.T) {
	text := strings.Repeat("Ⱥ", 20) + "关键词" + "尾部"
	snippet := makeSearchSnippet(text, "关键词", 6)
	if !strings.Contains(snippet, "\x01关键词\x02") {
		t.Fatalf("应高亮关键词，snippet = %q", snippet)
	}
	if !utf8.ValidString(snippet) {
		t.Fatalf("snippet 必须是合法 UTF-8：%q", snippet)
	}
	// 半径切在多字节字符中间时也必须退到 rune 边界
	narrow := makeSearchSnippet("前缀ȺȾȺȾ关键词后缀", "关键词", 2)
	if !utf8.ValidString(narrow) || !strings.Contains(narrow, "\x01关键词\x02") {
		t.Fatalf("窄半径 snippet 非法：%q", narrow)
	}
}

// 全局搜索接入：详细 = 全文；简要 = 用户消息 + 每轮最后一条 assistant；
// 两种模式都只搜未归档会话，工具消息不参与简要模式。
func TestScopedSessionSearchBriefAndFull(t *testing.T) {
	db, trigram := newTestSessionIndex(t)
	raw := strings.Join([]string{
		`{"v":1,"t":"header","id":"s1"}`,
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"帮我分析日志里的慢查询","ts":1}}`,
		`{"v":1,"t":"msg","mid":"m2","m":{"role":"assistant","content":"中间结论：索引缺失","ts":2}}`,
		`{"v":1,"t":"msg","mid":"m3","m":{"role":"assistant","content":"最终结论：慢查询来自缺索引","ts":3}}`,
		`{"v":1,"t":"msg","mid":"m4","m":{"role":"tool","name":"read_file","arguments":"慢查询","content":"工具输出","ts":4}}`,
		`{"v":1,"t":"msg","mid":"m5","m":{"role":"user","content":"慢查询修好了吗","ts":5}}`,
		`{"v":1,"t":"msg","mid":"m6","m":{"role":"assistant","content":"已修复并验证","ts":6}}`,
	}, "\n") + "\n"
	if _, err := db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at) VALUES('s1','慢查询会话','',1)`); err != nil {
		t.Fatal(err)
	}
	if err := indexSessionLog(db, "s1", raw); err != nil {
		t.Fatal(err)
	}
	// 简要：user 两条都命中；assistant 只留每轮最后一条（m3 / m6），中间的 m2 与工具消息不出现
	deadline := time.Now().Add(3 * time.Second)
	result, err := searchScopedSessionIndex(db, trigram, "慢查询", 50, true, deadline)
	if err != nil {
		t.Fatal(err)
	}
	var mids []string
	for _, hit := range result.Hits {
		if hit.Kind == "message" {
			mids = append(mids, hit.Mid)
		}
	}
	if strings.Join(mids, ",") != "m1,m3,m5" {
		t.Fatalf("简要模式应命中 m1/m3/m5，实际 %v（trigram=%v）", mids, trigram)
	}
	for _, hit := range result.Hits {
		if hit.Role == "tool" {
			t.Fatalf("简要模式不应命中工具消息：%+v", hit)
		}
	}
	// 标题也算命中
	foundTitle := false
	for _, hit := range result.Hits {
		if hit.Kind == "title" && hit.SessionID == "s1" {
			foundTitle = true
		}
	}
	if !foundTitle {
		t.Fatalf("标题命中缺失：%+v", result.Hits)
	}

	// 详细：中间 assistant m2 与工具消息也可命中
	result, err = searchScopedSessionIndex(db, trigram, "索引缺失", 50, false, deadline)
	if err != nil {
		t.Fatal(err)
	}
	foundM2 := false
	for _, hit := range result.Hits {
		if hit.Kind == "message" && hit.Mid == "m2" {
			foundM2 = true
		}
	}
	if !foundM2 {
		t.Fatalf("详细模式应能命中中间 assistant 消息 m2：%+v", result.Hits)
	}
}

// 简要模式的轮判定跨会话复位：每个会话各自的最后一条 assistant 独立计算；
// 会话收尾（扫描结束）时最后一轮的最后一条 assistant 也要参与判定。
func TestScopedSessionSearchBriefPerSessionRounds(t *testing.T) {
	db, trigram := newTestSessionIndex(t)
	for _, id := range []string{"sa", "sb"} {
		raw := strings.Join([]string{
			`{"v":1,"t":"header","id":"` + id + `"}`,
			`{"v":1,"t":"msg","mid":"` + id + `-u1","m":{"role":"user","content":"关键词在第一轮","ts":1}}`,
			`{"v":1,"t":"msg","mid":"` + id + `-a1","m":{"role":"assistant","content":"第一轮回复含关键词","ts":2}}`,
			`{"v":1,"t":"msg","mid":"` + id + `-a2","m":{"role":"assistant","content":"第二轮总结也含关键词","ts":3}}`,
		}, "\n") + "\n"
		if _, err := db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at) VALUES('` + id + `','` + id + `','',1)`); err != nil {
			t.Fatal(err)
		}
		if err := indexSessionLog(db, id, raw); err != nil {
			t.Fatal(err)
		}
	}
	result, err := searchScopedSessionIndex(db, trigram, "关键词", 50, true, time.Now().Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	mids := make([]string, 0)
	for _, hit := range result.Hits {
		if hit.Kind == "message" {
			mids = append(mids, hit.Mid)
		}
	}
	// 每个会话只有一轮：user 命中 + 该轮最后一条 assistant（a2）命中；a1 被最后的 a2 覆盖不出现
	if strings.Join(mids, ",") != "sa-u1,sa-a2,sb-u1,sb-a2" {
		t.Fatalf("跨会话轮判定应各自独立：%v", mids)
	}
}

// 归档会话整体排除（archived_at > 0 的会话连标题都不出）。
func TestScopedSessionSearchExcludesArchivedSessions(t *testing.T) {
	db, trigram := newTestSessionIndex(t)
	raw := `{"v":1,"t":"header","id":"s1"}` + "\n" +
		`{"v":1,"t":"msg","mid":"m1","m":{"role":"user","content":"目标内容在这里","ts":1}}` + "\n"
	if _, err := db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, archived_at) VALUES('s1','归档会话','',1,123)`); err != nil {
		t.Fatal(err)
	}
	if err := indexSessionLog(db, "s1", raw); err != nil {
		t.Fatal(err)
	}
	for _, brief := range []bool{true, false} {
		result, err := searchScopedSessionIndex(db, trigram, "目标内容", 50, brief, time.Now().Add(3*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Hits) != 0 {
			t.Fatalf("归档会话不应命中（brief=%v）：%+v", brief, result.Hits)
		}
	}
}

// 结果条数预算：命中超限时置 Truncated。
func TestScopedSessionSearchLimitBudget(t *testing.T) {
	db, trigram := newTestSessionIndex(t)
	raw := strings.Builder{}
	raw.WriteString(`{"v":1,"t":"header","id":"s1"}` + "\n")
	for i := 0; i < 8; i++ {
		line := `{"v":1,"t":"msg","mid":"u` + string(rune('0'+i)) + `","m":{"role":"user","content":"预算词 ` + string(rune('0'+i)) + `","ts":` + string(rune('0'+i)) + `}}` + "\n"
		raw.WriteString(line)
	}
	if _, err := db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at) VALUES('s1','预算','',1)`); err != nil {
		t.Fatal(err)
	}
	if err := indexSessionLog(db, "s1", raw.String()); err != nil {
		t.Fatal(err)
	}
	result, err := searchScopedSessionIndex(db, trigram, "预算词", 3, true, time.Now().Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Hits) != 3 || !result.Truncated {
		t.Fatalf("limit=3 时应恰好 3 条且 Truncated=true：%d 条，%+v", len(result.Hits), result)
	}
}
