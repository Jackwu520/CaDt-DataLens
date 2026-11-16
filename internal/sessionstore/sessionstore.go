// Package sessionstore：AI 会话磁盘存储引擎——每个会话一个目录，正文为追加式 JSONL，
// 元数据为原子替换的 meta.json。AppDataDir 由宿主（main）注入。
package sessionstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/recycle"
	"datalens/internal/sessionlock"
)

// AI 会话磁盘存储：每个会话一个目录，正文为追加式 JSONL，元数据为原子替换的 meta.json。
// 布局：<appdata>/ai-sessions/<id>/{meta.json,session.v1.jsonl,images/}
const (
	SessionsDirName    = "ai-sessions"
	aiSessionMetaName  = "meta.json"
	aiSessionLogName   = "session.v1.jsonl"
	ImagesDir          = "images"
	aiSessionLockName  = ".session.lock"
	aiSessionLockWait  = 5 * time.Second
	aiSessionReadLimit = 64 << 20 // 单会话正文上限：超过后拒绝加载，提示先压缩
	aiSessionMetaLimit = 1 << 20
	aiSessionIDMax     = 128
	aiSessionImageMax  = 120
)

type Store struct {
	Root     string
	DeleteFn func(string) error
}

// 同进程内所有 App 方法各建一个 store，追加互斥必须是包级的。
var appendMu sync.Mutex

func New(root string) *Store {
	return &Store{Root: root, DeleteFn: recycle.Move}
}

// AppDataDir 宿主注入：应用数据根目录（main/appdata.go 的 appDataRoot）。
var AppDataDir func() string

func Default() (*Store, error) {
	if AppDataDir == nil {
		return nil, errors.New("会话存储未注入应用数据目录")
	}
	base := AppDataDir()
	if base == "" {
		return nil, errors.New("无法定位应用数据目录")
	}
	return New(filepath.Join(base, SessionsDirName)), nil
}

// ValidSessionID 限制会话 id 可安全拼进路径：不含分隔符、不以点开头、不是 . / ..。
func ValidSessionID(id string) bool {
	if id == "" || len(id) > aiSessionIDMax || id[0] == '.' {
		return false
	}
	if isWindowsReservedName(id) {
		return false
	}
	for _, ch := range id {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

// isWindowsReservedName 拒绝 CON/NUL/COM1 等设备名（带扩展名同样被系统占用）。
func isWindowsReservedName(name string) bool {
	base := strings.ToUpper(strings.TrimSuffix(name, filepath.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) {
		return base[3] >= '1' && base[3] <= '9'
	}
	return false
}

func (s *Store) EnsureRoot() error {
	if s.Root == "" {
		return errors.New("会话存储目录为空")
	}
	return os.MkdirAll(s.Root, 0o755)
}

func (s *Store) sessionDir(id string) (string, error) {
	if !ValidSessionID(id) {
		return "", fmt.Errorf("非法会话 id：%q", id)
	}
	if s.Root == "" {
		return "", errors.New("会话存储目录为空")
	}
	return filepath.Join(s.Root, id), nil
}

func (s *Store) ensureSessionDir(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	if err := s.EnsureRoot(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建会话目录失败：%w", err)
	}
	return dir, nil
}

// withSessionLock 在会话目录的锁文件上取跨进程独占锁；超时返回可读错误。
// 读取不加锁；只有追加/整份重写/写 meta 这类写操作需要。
func (s *Store) withSessionLock(id string, fn func(dir string) error) error {
	dir, err := s.ensureSessionDir(id)
	if err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(dir, aiSessionLockName), aiSessionLockWait)
	if err != nil {
		return fmt.Errorf("会话正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()
	return fn(dir)
}

func (s *Store) logPath(id string) (string, error) {
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, aiSessionLogName), nil
}

func validSessionImageName(name string) bool {
	if name == "" || len(name) > aiSessionImageMax || name[0] == '.' {
		return false
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
	default:
		return false
	}
	if isWindowsReservedName(name) {
		return false
	}
	for _, ch := range name {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.':
		default:
			return false
		}
	}
	return true
}

func (s *Store) ImagePath(id, name string) (string, error) {
	if !validSessionImageName(name) {
		return "", fmt.Errorf("非法图片名：%q", name)
	}
	dir, err := s.sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, ImagesDir, name), nil
}

// list 只读各会话的 meta.json，不触碰正文；meta 缺失/损坏时用正文 header 兜底。
func (s *Store) List() ([]string, error) {
	if err := s.EnsureRoot(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !ValidSessionID(entry.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.Root, entry.Name(), aiSessionMetaName))
		if err != nil || len(raw) == 0 || len(raw) > aiSessionMetaLimit || !json.Valid(raw) {
			// meta 丢失/损坏时用正文首行 header 兜底，避免整段会话从列表里消失。
			raw = synthesizeMetaFromHeader(filepath.Join(s.Root, entry.Name(), aiSessionLogName), entry.Name())
			if len(raw) == 0 {
				continue
			}
		}
		out = append(out, string(raw))
	}
	return out, nil
}

// synthesizeMetaFromHeader 从正文首行 header 重建最小 meta（用于 meta 丢失/损坏的会话）。
func synthesizeMetaFromHeader(logPath, id string) []byte {
	f, err := os.Open(logPath)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n, _ := f.Read(buf)
	if n == 0 {
		return nil
	}
	line := string(buf[:n])
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var header struct {
		T         string `json:"t"`
		Title     string `json:"title"`
		CreatedAt int64  `json:"createdAt"`
		Workspace string `json:"workspace"`
	}
	if json.Unmarshal([]byte(line), &header) != nil || header.T != "header" {
		return nil
	}
	meta := map[string]any{
		"v":             1,
		"id":            id,
		"title":         header.Title,
		"createdAt":     header.CreatedAt,
		"updatedAt":     header.CreatedAt,
		"workspace":     header.Workspace,
		"scope":         "read",
		"messageCount":  0,
		"archivedCount": 0,
		"summary":       nil,
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return nil
	}
	return raw
}

func (s *Store) Read(id string) (string, error) {
	path, err := s.logPath(id)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if info.Size() > aiSessionReadLimit {
		return "", fmt.Errorf("会话正文 %d MB，超过 %d MB 上限；请先压缩或清空该会话",
			info.Size()/(1<<20), aiSessionReadLimit/(1<<20))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// append 在文件末尾追加若干行；写入前修掉上次崩溃留下的半行，
// 写入后 fsync；失败回滚到追加前的长度，避免半批事件留在日志里。
func (s *Store) Append(id string, payload string) error {
	if payload == "" {
		return nil
	}
	if !strings.HasSuffix(payload, "\n") {
		payload += "\n"
	}
	return s.withSessionLock(id, func(dir string) error {
		path := filepath.Join(dir, aiSessionLogName)
		appendMu.Lock()
		defer appendMu.Unlock()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			return err
		}
		before, err := atomfile.RepairTornTail(f)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		// O_APPEND 写：多窗口并发追加也由文件系统保证写到当前末尾。
		af, err := os.OpenFile(path, os.O_RDWR|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		defer af.Close()
		if _, err := af.WriteString(payload); err != nil {
			_ = af.Truncate(before)
			return err
		}
		// 与 dsh 一致：每批落盘后再算提交；掉电最多丢这一批。
		if err := af.Sync(); err != nil {
			_ = af.Truncate(before)
			return err
		}
		return nil
	})
}

// rewrite 原子替换整个正文（迁移、清空、状态与日志不一致时的兜底）。
func (s *Store) Rewrite(id string, payload string) error {
	return s.withSessionLock(id, func(dir string) error {
		return atomfile.WriteFileAtomic(filepath.Join(dir, aiSessionLogName), []byte(payload))
	})
}

func (s *Store) WriteMeta(id string, payload string) error {
	return s.withSessionLock(id, func(dir string) error {
		return atomfile.WriteFileAtomic(filepath.Join(dir, aiSessionMetaName), []byte(payload))
	})
}

// remove 单个会话目录（Windows 走回收站，可撤销）。
func (s *Store) Remove(id string) error {
	dir, err := s.sessionDir(id)
	if err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是会话目录：%s", dir)
	}
	return s.DeleteFn(dir)
}

// removeAll 清空全部会话目录（整根目录进回收站）。
func (s *Store) RemoveAll() error {
	info, err := os.Stat(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是会话目录：%s", s.Root)
	}
	return s.DeleteFn(s.Root)
}
