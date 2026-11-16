// Package sessionindex：AI 会话搜索的派生 SQLite 索引（JSONL 是唯一真源，可随时重建）。
// AppDataDir 由宿主（main）注入；Store 只要求 List / Read 两个只读能力。
package sessionindex

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// AI 会话搜索索引：JSONL 仍是唯一真源，这里只保存可重建的检索副本。
// 首次搜索时才创建 DB；之后每次写会话只标脏，下一次搜索按会话重建。
const (
	aiIndexFileName  = "ai-index.db"
	aiIndexTextLimit = 200000 // 单条消息入索引的字符上限
)

type SearchHit struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Role      string `json:"role"`
	Name      string `json:"name"`
	Mid       string `json:"mid"`
	LiveIndex int    `json:"liveIndex"`
	Snippet   string `json:"snippet"`
	Kind      string `json:"kind"`
	Ts        int64  `json:"ts,omitempty"`
}

type IndexStats struct {
	Exists    bool  `json:"exists"`
	Sessions  int   `json:"sessions"`
	Messages  int   `json:"messages"`
	Dirty     int   `json:"dirty"`
	Bytes     int64 `json:"bytes"`
	Trigram   bool  `json:"trigram"`
	IndexedAt int64 `json:"indexedAt"`
}

// Store 是索引重建需要的最小会话存储能力（internal/sessionstore 的 Store 满足它）。
type Store interface {
	List() ([]string, error)
	Read(id string) (string, error)
}

type aiIndexMessage struct {
	Mid  string
	Role string
	Name string
	Ts   int64
	Text string
}

var (
	aiIndexMu      sync.Mutex
	aiIndexDB      *sql.DB
	aiIndexDBPath  string
	aiIndexTrigram bool
)

// AppDataDir 宿主注入：应用数据根目录（main/appdata.go 的 appDataRoot）。
var AppDataDir func() string

// Path 返回索引库路径；未注入或无法定位应用数据目录时为空。
func Path() string {
	if AppDataDir == nil {
		return ""
	}
	root := AppDataDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, aiIndexFileName)
}

func Exists() bool {
	path := Path()
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func database() (*sql.DB, error) {
	path := Path()
	if path == "" {
		return nil, errors.New("无法定位应用数据目录")
	}
	aiIndexMu.Lock()
	defer aiIndexMu.Unlock()
	if aiIndexDB != nil && aiIndexDBPath == path {
		return aiIndexDB, nil
	}
	if aiIndexDB != nil {
		_ = aiIndexDB.Close()
		aiIndexDB = nil
	}
	db, trigram, err := openSessionIndex(path)
	if err != nil {
		return nil, err
	}
	aiIndexDB = db
	aiIndexDBPath = path
	aiIndexTrigram = trigram
	return db, nil
}

func openSessionIndex(path string) (*sql.DB, bool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, false, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, false, err
	}
	// 单连接串行化本进程内的索引读写；跨进程由 busy_timeout + WAL 处理。
	db.SetMaxOpenConns(1)
	_ = db.QueryRow("PRAGMA busy_timeout=5000").Scan(new(int))
	_ = db.QueryRow("PRAGMA journal_mode=WAL").Scan(new(string))
	_ = db.QueryRow("PRAGMA synchronous=NORMAL").Scan(new(string))
	if err := ensureSessionIndexSchema(db); err != nil {
		db.Close()
		return nil, false, err
	}
	trigram := false
	var ddl string
	if err := db.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_messages_fts'").Scan(&ddl); err == nil {
		trigram = strings.Contains(strings.ToLower(ddl), "trigram")
	}
	return db, trigram, nil
}

func ensureSessionIndexSchema(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT '',
			workspace TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL DEFAULT 0,
			archived_at INTEGER NOT NULL DEFAULT 0,
			message_count INTEGER NOT NULL DEFAULT 0,
			archived_count INTEGER NOT NULL DEFAULT 0,
			dirty INTEGER NOT NULL DEFAULT 1,
			indexed_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS messages (
			session_id TEXT NOT NULL,
			live_index INTEGER NOT NULL,
			mid TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			ts INTEGER NOT NULL DEFAULT 0,
			text TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON messages(session_id, live_index)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	if _, err := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='trigram')`); err != nil {
		// 旧版 SQLite 没有 trigram tokenizer 时退回默认分词，搜索会自动走 LIKE 兜底。
		if _, err2 := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(text, content='messages', content_rowid='rowid')`); err2 != nil {
			return err2
		}
	}
	triggers := []string{
		`CREATE TRIGGER IF NOT EXISTS ai_messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO ai_messages_fts(rowid, text) VALUES (new.rowid, new.text);
		END`,
		`CREATE TRIGGER IF NOT EXISTS ai_messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO ai_messages_fts(ai_messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
		END`,
		`CREATE TRIGGER IF NOT EXISTS ai_messages_au AFTER UPDATE ON messages BEGIN
			INSERT INTO ai_messages_fts(ai_messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
			INSERT INTO ai_messages_fts(rowid, text) VALUES (new.rowid, new.text);
		END`,
	}
	for _, stmt := range triggers {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

// replayIndexEvents 只做检索需要的轻量重放：msg / truncate / archive / reset。
func replayIndexEvents(raw string) (live, archived []aiIndexMessage) {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event struct {
			T    string `json:"t"`
			A    int    `json:"a"`
			Mid  string `json:"mid"`
			Keep int    `json:"keep"`
			M    *struct {
				Role      string `json:"role"`
				Content   string `json:"content"`
				Reasoning string `json:"reasoning"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
				Ts        int64  `json:"ts"`
			} `json:"m"`
		}
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		switch event.T {
		case "msg":
			if event.M == nil {
				continue
			}
			parts := make([]string, 0, 4)
			if event.M.Content != "" {
				parts = append(parts, event.M.Content)
			}
			if event.M.Reasoning != "" {
				parts = append(parts, event.M.Reasoning)
			}
			if event.M.Name != "" {
				parts = append(parts, event.M.Name)
			}
			if event.M.Arguments != "" {
				parts = append(parts, event.M.Arguments)
			}
			text := strings.TrimSpace(strings.Join(parts, "\n"))
			if text == "" {
				continue
			}
			if runes := []rune(text); len(runes) > aiIndexTextLimit {
				text = string(runes[:aiIndexTextLimit])
			}
			message := aiIndexMessage{Mid: event.Mid, Role: event.M.Role, Name: event.M.Name, Ts: event.M.Ts, Text: text}
			if event.A == 1 {
				archived = append(archived, message)
			} else {
				live = append(live, message)
			}
		case "truncate":
			keep := event.Keep
			if keep < 0 {
				keep = 0
			}
			if keep < len(live) {
				live = live[:keep]
			}
		case "archive":
			keep := event.Keep
			if keep < 0 {
				keep = 0
			}
			if keep > len(live) {
				keep = len(live)
			}
			archived = append(archived, live[:keep]...)
			live = append([]aiIndexMessage(nil), live[keep:]...)
		case "reset":
			live = nil
			archived = nil
		}
	}
	return live, archived
}

func indexSessionLog(db *sql.DB, id, raw string) error {
	live, archived := replayIndexEvents(raw)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM messages WHERE session_id=?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO messages(session_id, live_index, mid, role, name, ts, text) VALUES(?,?,?,?,?,?,?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for index, message := range live {
		if _, err := stmt.Exec(id, index, message.Mid, message.Role, message.Name, message.Ts, message.Text); err != nil {
			stmt.Close()
			_ = tx.Rollback()
			return err
		}
	}
	for _, message := range archived {
		if _, err := stmt.Exec(id, -1, message.Mid, message.Role, message.Name, message.Ts, message.Text); err != nil {
			stmt.Close()
			_ = tx.Rollback()
			return err
		}
	}
	stmt.Close()
	if _, err := tx.Exec(`UPDATE sessions SET message_count=?, archived_count=?, dirty=0, indexed_at=? WHERE id=?`,
		len(live), len(archived), time.Now().UnixMilli(), id); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

type aiIndexMeta struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Workspace     string `json:"workspace"`
	UpdatedAt     int64  `json:"updatedAt"`
	ArchivedAt    int64  `json:"archivedAt"`
	MessageCount  int    `json:"messageCount"`
	ArchivedCount int    `json:"archivedCount"`
}

func syncSessionIndex(db *sql.DB, store Store) error {
	metas, err := store.List()
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(metas))
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, raw := range metas {
		var meta aiIndexMeta
		if json.Unmarshal([]byte(raw), &meta) != nil || meta.ID == "" {
			continue
		}
		seen[meta.ID] = true
		if _, err := tx.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, archived_at, message_count, archived_count, dirty, indexed_at)
			VALUES(?,?,?,?,?,?,?,1,0)
			ON CONFLICT(id) DO UPDATE SET
				title=excluded.title, workspace=excluded.workspace, updated_at=excluded.updated_at,
				archived_at=excluded.archived_at`,
			meta.ID, meta.Title, meta.Workspace, meta.UpdatedAt, meta.ArchivedAt, meta.MessageCount, meta.ArchivedCount); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	rows, err := tx.Query(`SELECT id FROM sessions`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	stale := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			_ = tx.Rollback()
			return err
		}
		if !seen[id] {
			stale = append(stale, id)
		}
	}
	rows.Close()
	for _, id := range stale {
		if _, err := tx.Exec(`DELETE FROM messages WHERE session_id=?`, id); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.Exec(`DELETE FROM sessions WHERE id=?`, id); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	rows, err = db.Query(`SELECT id FROM sessions WHERE dirty=1 ORDER BY updated_at DESC`)
	if err != nil {
		return err
	}
	dirtyIDs := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		dirtyIDs = append(dirtyIDs, id)
	}
	rows.Close()
	for _, id := range dirtyIDs {
		raw, err := store.Read(id)
		if err != nil {
			continue
		}
		if err := indexSessionLog(db, id, raw); err != nil {
			return err
		}
	}
	return nil
}

func makeSearchSnippet(text, query string, radius int) string {
	lowerText := strings.ToLower(text)
	lowerQuery := strings.ToLower(query)
	pos := strings.Index(lowerText, lowerQuery)
	if pos < 0 {
		runes := []rune(text)
		if len(runes) > radius*2 {
			runes = runes[:radius*2]
		}
		return string(runes)
	}
	start := pos - radius
	if start < 0 {
		start = 0
	}
	for start > 0 && !utf8.RuneStart(text[start]) {
		start--
	}
	end := pos + len(query) + radius
	if end > len(text) {
		end = len(text)
	}
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end++
	}
	matchEnd := pos + len(query)
	if matchEnd > len(text) {
		matchEnd = len(text)
	}
	prefix := "…"
	if start == 0 {
		prefix = ""
	}
	suffix := "…"
	if end >= len(text) {
		suffix = ""
	}
	return prefix + text[start:pos] + "\x01" + text[pos:matchEnd] + "\x02" + text[matchEnd:end] + suffix
}

func searchSessionIndex(db *sql.DB, trigram bool, query string, limit int) ([]SearchHit, error) {
	hits := make([]SearchHit, 0, limit)
	rows, err := db.Query(`SELECT id, title FROM sessions WHERE instr(lower(title), lower(?)) > 0 ORDER BY updated_at DESC LIMIT ?`, query, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			rows.Close()
			return nil, err
		}
		hits = append(hits, SearchHit{SessionID: id, Title: title, LiveIndex: -1, Kind: "title"})
	}
	rows.Close()
	if len(hits) >= limit {
		return hits, nil
	}
	remaining := limit - len(hits)
	useFTS := trigram && utf8.RuneCountInString(query) >= 3
	if useFTS {
		match := `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
		rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.name, m.mid, m.live_index,
			snippet(ai_messages_fts, 0, char(1), char(2), '…', 32)
			FROM ai_messages_fts
			JOIN messages m ON m.rowid = ai_messages_fts.rowid
			JOIN sessions s ON s.id = m.session_id
			WHERE ai_messages_fts MATCH ? AND m.live_index >= 0
			ORDER BY bm25(ai_messages_fts) LIMIT ?`, match, remaining)
	} else {
		rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.name, m.mid, m.live_index, m.text
			FROM messages m JOIN sessions s ON s.id = m.session_id
			WHERE m.live_index >= 0 AND instr(lower(m.text), lower(?)) > 0
			ORDER BY s.updated_at DESC, m.live_index DESC LIMIT ?`, query, remaining)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var hit SearchHit
		var snippet string
		if err := rows.Scan(&hit.SessionID, &hit.Title, &hit.Role, &hit.Name, &hit.Mid, &hit.LiveIndex, &snippet); err != nil {
			return nil, err
		}
		if !useFTS {
			snippet = makeSearchSnippet(snippet, query, 60)
		}
		hit.Snippet = snippet
		hit.Kind = "message"
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

// ---------- 写路径钩子（索引未创建时零开销） ----------

func MarkDirty(id string) {
	if !Exists() {
		return
	}
	db, err := database()
	if err != nil {
		return
	}
	_, _ = db.Exec(`INSERT INTO sessions(id, dirty, indexed_at) VALUES(?,1,0)
		ON CONFLICT(id) DO UPDATE SET dirty=1`, id)
}

func UpdateMeta(id, metaJSON string) {
	if !Exists() {
		return
	}
	db, err := database()
	if err != nil {
		return
	}
	var meta aiIndexMeta
	if json.Unmarshal([]byte(metaJSON), &meta) != nil || meta.ID == "" {
		return
	}
	_, _ = db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, archived_at, message_count, archived_count, dirty, indexed_at)
		VALUES(?,?,?,?,?,?,?,1,0)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title, workspace=excluded.workspace, updated_at=excluded.updated_at,
			archived_at=excluded.archived_at, message_count=excluded.message_count,
			archived_count=excluded.archived_count`,
		id, meta.Title, meta.Workspace, meta.UpdatedAt, meta.ArchivedAt, meta.MessageCount, meta.ArchivedCount)
}

func Delete(id string) {
	if !Exists() {
		return
	}
	db, err := database()
	if err != nil {
		return
	}
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_, _ = tx.Exec(`DELETE FROM messages WHERE session_id=?`, id)
	_, _ = tx.Exec(`DELETE FROM sessions WHERE id=?`, id)
	_ = tx.Commit()
}

func Clear() {
	if !Exists() {
		return
	}
	db, err := database()
	if err != nil {
		return
	}
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_, _ = tx.Exec(`DELETE FROM messages`)
	_, _ = tx.Exec(`DELETE FROM sessions`)
	_ = tx.Commit()
}

// ---------- 全局搜索接入：仅未归档会话，详细 / 简要两档（global-search 面板用） ----------

const (
	aiScopedSearchMaxLimit   = 100
	aiScopedSearchBriefScan  = int64(32) << 20 // 简要模式逐行扫描的总字节上限，封顶内存
	aiScopedSearchSyncBudget = 1500 * time.Millisecond
	aiScopedSearchTimeBudget = 3 * time.Second // 整次搜索的墙钟上限
)

// ScopedSearchResult 全局搜索「搜索 AI 会话」的结果集；
// Truncated 表示因条数 / 字节 / 时长预算提前截断。
type ScopedSearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
	Brief     bool        `json:"brief"`
}

// syncSessionIndexBudgeted 带时长预算的脏会话重建：超过预算就停下，
// 剩下的会话等下次搜索继续（dirty 标记仍在）。
func syncSessionIndexBudgeted(db *sql.DB, store Store, maxWait time.Duration) error {
	deadline := time.Now().Add(maxWait)
	metas, err := store.List()
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(metas))
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, raw := range metas {
		var meta aiIndexMeta
		if json.Unmarshal([]byte(raw), &meta) != nil || meta.ID == "" {
			continue
		}
		seen[meta.ID] = true
		if _, err := tx.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, archived_at, message_count, archived_count, dirty, indexed_at)
			VALUES(?,?,?,?,?,?,?,1,0)
			ON CONFLICT(id) DO UPDATE SET
				title=excluded.title, workspace=excluded.workspace, updated_at=excluded.updated_at,
				archived_at=excluded.archived_at`,
			meta.ID, meta.Title, meta.Workspace, meta.UpdatedAt, meta.ArchivedAt, meta.MessageCount, meta.ArchivedCount); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	rows, err := tx.Query(`SELECT id FROM sessions`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	stale := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			_ = tx.Rollback()
			return err
		}
		if !seen[id] {
			stale = append(stale, id)
		}
	}
	rows.Close()
	for _, id := range stale {
		if _, err := tx.Exec(`DELETE FROM messages WHERE session_id=?`, id); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.Exec(`DELETE FROM sessions WHERE id=?`, id); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	rows, err = db.Query(`SELECT id FROM sessions WHERE dirty=1 ORDER BY updated_at DESC`)
	if err != nil {
		return err
	}
	dirtyIDs := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		dirtyIDs = append(dirtyIDs, id)
	}
	rows.Close()
	for _, id := range dirtyIDs {
		if time.Now().After(deadline) {
			return nil
		}
		raw, err := store.Read(id)
		if err != nil {
			continue
		}
		if err := indexSessionLog(db, id, raw); err != nil {
			return err
		}
	}
	return nil
}

// briefSessionSearchHit 简要模式的流式游标：只保留「当前轮的最后一条 assistant」，
// 轮结束（下一条 user / 换会话 / 扫描结束）时才判定它是否命中。
type briefSessionWalk struct {
	sessionID string
	title     string
	// 当前轮最后一条 assistant（最后出现者胜出）
	hasAssistant bool
	mid          string
	liveIndex    int
	ts           int64
	text         string
}

func (w *briefSessionWalk) flush(query string, out *[]SearchHit, limit int) {
	if !w.hasAssistant || len(*out) >= limit {
		w.hasAssistant = false
		return
	}
	if strings.Contains(strings.ToLower(w.text), query) {
		*out = append(*out, SearchHit{
			SessionID: w.sessionID, Title: w.title, Role: "assistant",
			Mid: w.mid, LiveIndex: w.liveIndex, Ts: w.ts,
			Snippet: makeSearchSnippet(w.text, query, 60), Kind: "message",
		})
	}
	w.hasAssistant = false
}

// searchScopedSessionIndex 核心实现：
//   - brief=false（详细）：标题 + 全部 live 消息全文（FTS/LIKE，与侧栏会话搜索同源）；
//   - brief=true（简要）：标题 + 每条 user 消息 + 每轮最后一条 assistant 消息（作为该轮总结），
//     流式扫描带硬预算（总字节 / 墙钟 / 结果条数），超限置 Truncated。
//
// 两种模式都只搜未归档会话（archived_at = 0）与未压缩的 live 消息（live_index >= 0）。
func searchScopedSessionIndex(db *sql.DB, trigram bool, query string, limit int, brief bool, deadline time.Time) (ScopedSearchResult, error) {
	result := ScopedSearchResult{Hits: make([]SearchHit, 0, 16), Brief: brief}
	lowerQuery := strings.ToLower(query)

	// 标题命中
	rows, err := db.Query(`SELECT id, title FROM sessions WHERE archived_at=0 AND instr(lower(title), lower(?)) > 0 ORDER BY updated_at DESC LIMIT ?`, query, limit)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			rows.Close()
			return result, err
		}
		result.Hits = append(result.Hits, SearchHit{SessionID: id, Title: title, LiveIndex: -1, Kind: "title"})
	}
	rows.Close()
	if len(result.Hits) >= limit || time.Now().After(deadline) {
		result.Truncated = len(result.Hits) >= limit
		return result, nil
	}

	if !brief {
		// 详细：复用既有全文检索链路，加未归档过滤
		useFTS := trigram && utf8.RuneCountInString(query) >= 3
		var rows *sql.Rows
		if useFTS {
			match := `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
			rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.name, m.mid, m.live_index, m.ts,
				snippet(ai_messages_fts, 0, char(1), char(2), '…', 32)
				FROM ai_messages_fts
				JOIN messages m ON m.rowid = ai_messages_fts.rowid
				JOIN sessions s ON s.id = m.session_id
				WHERE ai_messages_fts MATCH ? AND m.live_index >= 0 AND s.archived_at = 0
				ORDER BY bm25(ai_messages_fts) LIMIT ?`, match, limit-len(result.Hits))
		} else {
			rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.name, m.mid, m.live_index, m.ts, m.text
				FROM messages m JOIN sessions s ON s.id = m.session_id
				WHERE m.live_index >= 0 AND s.archived_at = 0 AND instr(lower(m.text), lower(?)) > 0
				ORDER BY s.updated_at DESC, m.live_index DESC LIMIT ?`, query, limit-len(result.Hits))
		}
		if err != nil {
			return result, err
		}
		defer rows.Close()
		for rows.Next() {
			var hit SearchHit
			var ts int64
			var text string
			if err := rows.Scan(&hit.SessionID, &hit.Title, &hit.Role, &hit.Name, &hit.Mid, &hit.LiveIndex, &ts, &text); err != nil {
				return result, err
			}
			hit.Ts = ts
			if !useFTS {
				text = makeSearchSnippet(text, query, 60)
			}
			hit.Snippet = text
			hit.Kind = "message"
			result.Hits = append(result.Hits, hit)
		}
		if err := rows.Err(); err != nil {
			return result, err
		}
		result.Truncated = false
		return result, nil
	}

	// 简要：流式扫描未归档会话的 live 消息（按会话 + live_index 顺序），
	// 只保留 user 消息与每轮最后一条 assistant。
	rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.mid, m.live_index, m.ts, m.text
		FROM messages m JOIN sessions s ON s.id = m.session_id
		WHERE m.live_index >= 0 AND s.archived_at = 0
		ORDER BY m.session_id, m.live_index`)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	var walk briefSessionWalk
	scanned := int64(0)
	for rows.Next() {
		if len(result.Hits) >= limit || time.Now().After(deadline) || scanned > aiScopedSearchBriefScan {
			result.Truncated = true
			break
		}
		var sessionID, title, role, mid, text string
		var liveIndex, ts int64
		if err := rows.Scan(&sessionID, &title, &role, &mid, &liveIndex, &ts, &text); err != nil {
			return result, err
		}
		scanned += int64(len(text))
		if walk.sessionID != sessionID {
			walk.flush(lowerQuery, &result.Hits, limit)
			walk = briefSessionWalk{sessionID: sessionID, title: title}
		}
		switch role {
		case "user":
			walk.flush(lowerQuery, &result.Hits, limit)
			if len(result.Hits) < limit && strings.Contains(strings.ToLower(text), lowerQuery) {
				result.Hits = append(result.Hits, SearchHit{
					SessionID: sessionID, Title: title, Role: role,
					Mid: mid, LiveIndex: int(liveIndex), Ts: ts,
					Snippet: makeSearchSnippet(text, query, 60), Kind: "message",
				})
			}
		case "assistant":
			walk.hasAssistant = true
			walk.mid = mid
			walk.liveIndex = int(liveIndex)
			walk.ts = ts
			walk.text = text
		}
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	walk.flush(lowerQuery, &result.Hits, limit)
	result.Truncated = len(result.Hits) >= limit || scanned > aiScopedSearchBriefScan || time.Now().After(deadline)
	return result, nil
}

// AISessionSearchScoped 全局搜索的 AI 会话通道：只搜未归档会话；
// brief=true 时只搜用户消息 + 每轮最后一条 assistant（简要），false 为全文（详细）。
// 硬预算：结果 ≤100 条、简要扫描 ≤32MB、脏索引重建 ≤1.5s、整次 ≤3s。
func ResetFiles() {
	aiIndexMu.Lock()
	if aiIndexDB != nil {
		_ = aiIndexDB.Close()
		aiIndexDB = nil
	}
	aiIndexDBPath = ""
	aiIndexTrigram = false
	path := Path()
	aiIndexMu.Unlock()
	if path == "" {
		return
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
}

// ---------- 查询入口（App 壳与测试共用） ----------

// Search 全量会话搜索（未归档 + 归档都参与）；首次调用会按需同步脏会话。
func Search(store Store, query string, limit int) ([]SearchHit, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return []SearchHit{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	db, err := database()
	if err != nil {
		return nil, err
	}
	if err := syncSessionIndex(db, store); err != nil {
		return nil, err
	}
	return searchSessionIndex(db, aiIndexTrigram, q, limit)
}

// SearchScoped 全局搜索的 AI 会话通道：只搜未归档会话；brief=true 时只搜用户消息
// + 每轮最后一条 assistant（简要），false 为全文（详细）。
// 硬预算：结果 ≤100 条、简要扫描 ≤32MB、脏索引重建 ≤1.5s、整次 ≤3s。
func SearchScoped(store Store, query string, limit int, brief bool) (ScopedSearchResult, error) {
	q := strings.TrimSpace(query)
	result := ScopedSearchResult{Hits: []SearchHit{}, Brief: brief}
	if q == "" {
		return result, nil
	}
	if limit <= 0 || limit > aiScopedSearchMaxLimit {
		limit = 30
	}
	db, err := database()
	if err != nil {
		return result, err
	}
	deadline := time.Now().Add(aiScopedSearchTimeBudget)
	if err := syncSessionIndexBudgeted(db, store, aiScopedSearchSyncBudget); err != nil {
		return result, err
	}
	return searchScopedSessionIndex(db, aiIndexTrigram, q, limit, brief, deadline)
}

// Reindex 显式重建 = 删掉派生索引后从 JSONL 全量重来，也用来恢复损坏的索引。
func Reindex(store Store) (int, error) {
	ResetFiles()
	db, err := database()
	if err != nil {
		return 0, err
	}
	if err := syncSessionIndex(db, store); err != nil {
		return 0, err
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM sessions WHERE dirty=0`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// Stats 返回索引健康度与容量统计；会先同步脏会话。
func Stats(store Store) (IndexStats, error) {
	stats := IndexStats{Exists: Exists()}
	if !stats.Exists {
		return stats, nil
	}
	db, err := database()
	if err != nil {
		return stats, err
	}
	if err := syncSessionIndex(db, store); err != nil {
		return stats, err
	}
	stats.Exists = true
	stats.Trigram = aiIndexTrigram
	if err := db.QueryRow(`SELECT count(*) FROM sessions`).Scan(&stats.Sessions); err != nil {
		return stats, err
	}
	if err := db.QueryRow(`SELECT count(*) FROM messages`).Scan(&stats.Messages); err != nil {
		return stats, err
	}
	if err := db.QueryRow(`SELECT count(*) FROM sessions WHERE dirty=1`).Scan(&stats.Dirty); err != nil {
		return stats, err
	}
	if err := db.QueryRow(`SELECT COALESCE(max(indexed_at),0) FROM sessions`).Scan(&stats.IndexedAt); err != nil {
		return stats, err
	}
	if info, err := os.Stat(Path()); err == nil {
		stats.Bytes = info.Size()
	}
	return stats, nil
}
