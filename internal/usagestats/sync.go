// sync.go：会话 JSONL 的增量导入——按「字节偏移 + 文件大小/mtime」游标只读新增行，
// 尾行不完整不推进（下一轮补全后重读），文件被截断时从 0 重来。
package usagestats

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// prefixHashBytes 游标前 64 字节参与指纹：文件被截断/重写后再次增长时，
// 只看 size/offset 会从新文件中间续读，前半段完整行就永久丢了。
const prefixHashBytes = 64

func hashFilePrefix(f *os.File, offset int64) string {
	if offset <= 0 {
		return ""
	}
	start := offset - prefixHashBytes
	if start < 0 {
		start = 0
	}
	buf := make([]byte, offset-start)
	if _, err := f.ReadAt(buf, start); err != nil {
		return ""
	}
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:8])
}

func prefixMatches(f *os.File, offset int64, want string) bool {
	if want == "" {
		return false // 旧游标没有指纹：保守从头重读一次
	}
	return hashFilePrefix(f, offset) == want
}

// sessionLog 一个会话正文文件；ID 取自目录名（sessionstore 的目录名就是会话 id）。
// Size/Mtime 在遍历时顺带取好，扫描时不再重复 stat。
type sessionLog struct {
	Kind  string // kindSession / kindGroup
	ID    string
	Path  string
	Size  int64
	Mtime int64
}

// collectSessionLogs 枚举全部会话正文：兼容分桶布局 <root>/<ws8>/<id>/ 与旧平铺 <root>/<id>/。
func collectSessionLogs() []sessionLog {
	root := dataRoot()
	if root == "" {
		return nil
	}
	out := collectSessions(filepath.Join(root, sessionsDirName))
	out = append(out, collectGroups(filepath.Join(root, groupsDirName))...)
	return out
}

// collectSessions 枚举主会话正文：分桶 <root>/<ws8>/<id>/ 与旧平铺 <root>/<id>/。
func collectSessions(base string) []sessionLog {
	buckets, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	out := make([]sessionLog, 0, 32)
	for _, bucket := range buckets {
		if !bucket.IsDir() || bucket.Name() == ".locks" {
			continue
		}
		bucketPath := filepath.Join(base, bucket.Name())
		if info, ok := statSessionLog(bucketPath); ok {
			// 旧平铺布局：目录名就是会话 id
			out = append(out, sessionLog{
				Kind: kindSession, ID: bucket.Name(), Path: filepath.Join(bucketPath, sessionLogName),
				Size: info.Size(), Mtime: info.ModTime().UnixNano(),
			})
			continue
		}
		sessions, err := os.ReadDir(bucketPath)
		if err != nil {
			continue
		}
		for _, session := range sessions {
			if !session.IsDir() {
				continue
			}
			dir := filepath.Join(bucketPath, session.Name())
			if info, ok := statSessionLog(dir); ok {
				out = append(out, sessionLog{
					Kind: kindSession, ID: session.Name(), Path: filepath.Join(dir, sessionLogName),
					Size: info.Size(), Mtime: info.ModTime().UnixNano(),
				})
			}
		}
	}
	return out
}

// collectGroups 枚举群聊共享对话（平铺 <root>/<id>/session.v1.jsonl）。
// 群聊消息不在 ai-sessions 下，不扫这里会漏掉群成员/主持人的模型消耗。
func collectGroups(base string) []sessionLog {
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	out := make([]sessionLog, 0, 8)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == ".locks" {
			continue
		}
		dir := filepath.Join(base, entry.Name())
		if info, ok := statSessionLog(dir); ok {
			out = append(out, sessionLog{
				Kind: kindGroup, ID: groupKeyPrefix + entry.Name(), Path: filepath.Join(dir, sessionLogName),
				Size: info.Size(), Mtime: info.ModTime().UnixNano(),
			})
		}
	}
	return out
}

func statSessionLog(dir string) (os.FileInfo, bool) {
	info, err := os.Stat(filepath.Join(dir, sessionLogName))
	if err != nil || info.IsDir() {
		return nil, false
	}
	return info, true
}

// logEvent 只声明统计需要的最小字段；正文与工具参数不解析，避免大消息拖慢回填。
type logEvent struct {
	V   int    `json:"v"`
	T   string `json:"t"`
	Mid string `json:"mid"`
	M   struct {
		Role         string      `json:"role"`
		Model        string      `json:"model"`
		ModelAccount string      `json:"modelAccount"`
		Ts           int64       `json:"ts"`
		TurnMs       int64       `json:"turnMs"`
		ModelMs      int64       `json:"modelMs"`
		FirstTokenMs int64       `json:"firstTokenMs"`
		StatusCode   int         `json:"statusCode"`
		Usage        *UsageField `json:"usage"`
	} `json:"m"`
}

// syncSessionLog 导入单个会话文件的新增内容，返回本次新解析出的事实条数。
// size/mtime 来自遍历时的 stat；扫描期间文件又被追加也没关系，下轮会补。
func syncSessionLog(item sessionLog, states map[string]syncState) (int, error) {
	size := item.Size
	mtime := item.Mtime
	state, ok := states[item.ID]
	if ok && state.Size == size && state.Mtime == mtime {
		return 0, nil // 文件没变：不打开、不读取
	}
	offset := int64(0)
	if ok && state.Offset > 0 && state.Offset <= size {
		offset = state.Offset
	}
	f, err := os.Open(item.Path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	// 游标前 64 字节不匹配 = 文件被截断/整份重写（reset 后继续写也可能超过旧 offset）：
	// 从头重读，绝不允许从新文件中间续读。
	if offset > 0 && !prefixMatches(f, offset, state.PrefixHash) {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	reader := bufio.NewReaderSize(f, 64*1024)
	consumed := offset
	events := make([]Event, 0, 8)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			consumed += int64(len(line))
			parse := parseSessionLogLine
			if item.Kind == kindGroup {
				parse = parseGroupLogLine
			}
			if ev, ok := parse(item.ID, line); ok {
				events = append(events, ev)
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				return 0, readErr
			}
			break
		}
	}
	// 读取期间文件可能又被追加：记下 max(读前大小, 已消费偏移)，否则下轮
	// 「offset <= size」校验会失败并从头重读（幂等但浪费）。
	storedSize := size
	if consumed > storedSize {
		storedSize = consumed
	}
	if err := saveScanResult(item.ID, events, consumed, storedSize, mtime, hashFilePrefix(f, consumed), time.Now().UnixMilli()); err != nil {
		return 0, err
	}
	return len(events), nil
}

// groupLogEvent 群聊共享对话的一行：平铺字段，与主会话的 {t,m} 信封不同。
type groupLogEvent struct {
	Kind         string      `json:"kind"`
	Gid          string      `json:"gid"`
	Role         string      `json:"role"`
	Ts           int64       `json:"ts"`
	Model        string      `json:"model"`
	ModelAccount string      `json:"modelAccount"`
	AgentName    string      `json:"agentName"`
	StatusCode   int         `json:"statusCode"`
	Usage        *UsageField `json:"usage"`
	Timing       *struct {
		TotalMs int64 `json:"totalMs"`
		TtftMs  int64 `json:"ttftMs"`
	} `json:"timing"`
}

// parseGroupLogLine 从群聊消息行里取一条 assistant usage 事实（纯函数，供测试）。
// 幂等键用持久化的消息 gid（与前端上报同 key），不依赖 ts 精度。
func parseGroupLogLine(sessionID string, line []byte) (Event, bool) {
	if len(line) == 0 {
		return Event{}, false
	}
	var raw groupLogEvent
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{}, false
	}
	if raw.Kind != "msg" || raw.Role != "assistant" || raw.Usage == nil {
		return Event{}, false
	}
	ts := raw.Ts
	if ts <= 0 {
		return Event{}, false
	}
	if ts < 1e12 {
		ts *= 1000
	}
	model := strings.TrimSpace(raw.Model)
	if model == "" {
		model = unknownModelName
	}
	key := strings.TrimSpace(raw.Gid)
	if key == "" {
		key = strconv.FormatInt(ts, 10)
	}
	// 供应商列显示账号名；老群聊消息没有 modelAccount，退回成员名（至少能辨认模型配置）。
	account := strings.TrimSpace(raw.ModelAccount)
	if account == "" {
		account = strings.TrimSpace(raw.AgentName)
	}
	ev := Event{
		ID:               sessionID + ":" + key,
		SessionID:        sessionID,
		Ts:               ts,
		Model:            clampText(model, maxModelNameLen),
		ModelAccount:     clampText(account, maxModelNameLen),
		PromptTokens:     clampTokens(raw.Usage.PromptTokens),
		CompletionTokens: clampTokens(raw.Usage.CompletionTokens),
		TotalTokens:      clampTokens(raw.Usage.TotalTokens),
		CachedTokens:     clampTokens(raw.Usage.CachedTokens),
		CacheWriteTokens: clampTokens(raw.Usage.CacheWriteTokens),
		StatusCode:       clampStatusCode(raw.StatusCode),
	}
	if raw.Timing != nil {
		ev.TurnMs = clampTokens(raw.Timing.TotalMs)
		ev.ModelMs = clampTokens(raw.Timing.TotalMs)
		ev.TtftMs = clampTokens(raw.Timing.TtftMs)
	}
	if ev.TotalTokens <= 0 {
		ev.TotalTokens = ev.PromptTokens + ev.CompletionTokens
	}
	return ev, true
}

// parseSessionLogLine 从一行 JSONL 里取一条 assistant usage 事实（纯函数，供测试）。
func parseSessionLogLine(sessionID string, line []byte) (Event, bool) {
	if len(line) == 0 {
		return Event{}, false
	}
	var raw logEvent
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{}, false
	}
	if raw.T != "msg" || raw.M.Role != "assistant" || raw.M.Usage == nil {
		return Event{}, false
	}
	ts := raw.M.Ts
	if ts <= 0 {
		return Event{}, false // 没有时间戳归不了日，宁缺勿错
	}
	if ts < 1e12 {
		ts *= 1000
	}
	model := strings.TrimSpace(raw.M.Model)
	if model == "" {
		model = unknownModelName
	}
	usage := raw.M.Usage
	ev := Event{
		ID:               sessionID + ":" + strconv.FormatInt(ts, 10),
		SessionID:        sessionID,
		Ts:               ts,
		Model:            clampText(model, maxModelNameLen),
		ModelAccount:     clampText(strings.TrimSpace(raw.M.ModelAccount), maxModelNameLen),
		PromptTokens:     clampTokens(usage.PromptTokens),
		CompletionTokens: clampTokens(usage.CompletionTokens),
		TotalTokens:      clampTokens(usage.TotalTokens),
		CachedTokens:     clampTokens(usage.CachedTokens),
		CacheWriteTokens: clampTokens(usage.CacheWriteTokens),
		TurnMs:           clampTokens(raw.M.TurnMs),
		ModelMs:          clampTokens(raw.M.ModelMs),
		TtftMs:           clampTokens(raw.M.FirstTokenMs),
		StatusCode:       clampStatusCode(raw.M.StatusCode),
	}
	if ev.TotalTokens <= 0 {
		ev.TotalTokens = ev.PromptTokens + ev.CompletionTokens
	}
	return ev, true
}
