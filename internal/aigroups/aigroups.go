// Package aigroups：AI 群聊磁盘存储（方案 docs/unfinished-plans/ai-group-chat.md §6.5）。
// 共享群聊对话复用 internal/sessionstore 引擎（Root 换成 ai-groups）：原子 append、
// 跨进程写锁、meta 原子替换、回收站删除、残行修复全部继承；私有过程日志
// private/<agentId>.jsonl 在本包实现（群目录锁 + 包级互斥 + 残行修复 + fsync）。
//
// 目录布局：<appdata>/ai-groups/<groupId>/{meta.json, session.v1.jsonl, private/<agentId>.jsonl}
// 与 ai-sessions 分根的原因（§6.5）：「清空所有 AI 会话」不会误删群聊；群聊不混进
// 会话列表 / 会话搜索索引 / 会话投递目标；群聊生命周期独立治理。
package aigroups

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/sessionlock"
	"datalens/internal/sessionstore"
)

const (
	// RootDirName 应用数据目录下的群聊根目录。
	RootDirName = "ai-groups"
	// privateDirName 群目录下的私有过程日志子目录。
	privateDirName = "private"
	// privateLockName 与 sessionstore 的会话锁同名：同一群目录内共享日志与私有日志
	// 的写完全串行，避免两把锁交错出乱序。
	privateLockName  = ".session.lock"
	privateLockWait  = 5 * time.Second
	privateReadLimit = 64 << 20
)

// AppDataDir 宿主注入应用数据目录（根壳 groupstore_app.go 的 init 接线）。
var AppDataDir func() string

// Store 群聊存储：共享对话委托 sessionstore.Store，私有日志由本包实现。
type Store struct {
	sessions *sessionstore.Store
	root     string
}

// New 以指定根目录建 Store（测试注入临时目录用）。
func New(root string) *Store {
	return &Store{sessions: sessionstore.New(root), root: root}
}

// Default 按宿主注入的应用数据目录建 Store；未注入时返回错误。
func Default() (*Store, error) {
	if AppDataDir == nil || AppDataDir() == "" {
		return nil, fmt.Errorf("应用数据目录不可用")
	}
	return New(filepath.Join(AppDataDir(), RootDirName)), nil
}

// ValidGroupID / ValidAgentID 沿用会话 ID 规则（非空、≤128、仅 [A-Za-z0-9._-]、
// 不以 . 开头、拒 Windows 保留名）——两个 ID 都直接拼路径，规则从严。
func ValidGroupID(id string) bool { return sessionstore.ValidSessionID(id) }
func ValidAgentID(id string) bool { return sessionstore.ValidSessionID(id) }

// Root 返回存储根目录。
func (s *Store) Root() string { return s.root }

// ---- 共享群聊对话：全部委托 sessionstore（原子 append / 残行修复 / 跨进程锁 / 回收站继承） ----

// EnsureRoot 建根目录。
func (s *Store) EnsureRoot() error { return s.sessions.EnsureRoot() }

// List 返回各群 meta.json 原文（损坏时由 sessionstore 用正文首行 header 兜底）。
func (s *Store) List() ([]string, error) { return s.sessions.List() }

// Read 整份共享对话 JSONL。
func (s *Store) Read(id string) (string, error) { return s.sessions.Read(id) }

// Append 追加群消息事件（JSONL 文本，自动补尾行）。
func (s *Store) Append(id, payload string) error { return s.sessions.Append(id, payload) }

// Rewrite 原子替换共享对话（状态与日志不一致时的兜底）。
func (s *Store) Rewrite(id, payload string) error { return s.sessions.Rewrite(id, payload) }

// WriteMeta 原子替换群 meta.json。
func (s *Store) WriteMeta(id, payload string) error { return s.sessions.WriteMeta(id, payload) }

// Remove 单个群目录进回收站——私有日志随目录一起删除（方案验收 17）。
func (s *Store) Remove(id string) error { return s.sessions.Remove(id) }

// RemoveAll 整个 ai-groups 根进回收站（存储清理用）。
func (s *Store) RemoveAll() error { return s.sessions.RemoveAll() }

// ---- 私有过程日志：private/<agentId>.jsonl（仅本人与用户可读，§3.13） ----

// privateMu 同进程内私有日志写互斥（与 sessionstore 的 appendMu 同款考量：
// 各绑定方法各建 Store 实例，包级锁才能保证追加串行）。
var privateMu sync.Mutex

// privatePath 校验并拼出私有日志路径；groupID / agentID 都走严格 ID 校验，
// 杜绝路径逃逸（../、绝对路径、分隔符）。
func (s *Store) privatePath(groupID, agentID string) (string, error) {
	if !ValidGroupID(groupID) {
		return "", fmt.Errorf("非法群 ID：%q", groupID)
	}
	if !ValidAgentID(agentID) {
		return "", fmt.Errorf("非法智能体 ID：%q", agentID)
	}
	return filepath.Join(s.root, groupID, privateDirName, agentID+".jsonl"), nil
}

// PrivateRead 读某成员的私有过程日志；不存在返回空串。
func (s *Store) PrivateRead(groupID, agentID string) (string, error) {
	path, err := s.privatePath(groupID, agentID)
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
	if info.Size() > privateReadLimit {
		return "", fmt.Errorf("私有日志 %d MB，超过 %d MB 上限",
			info.Size()/(1<<20), privateReadLimit/(1<<20))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// PrivateAppend 追加私有过程步骤（JSONL 文本）；写前修残行、写后 fsync、失败回滚。
func (s *Store) PrivateAppend(groupID, agentID, payload string) error {
	if payload == "" {
		return nil
	}
	if !strings.HasSuffix(payload, "\n") {
		payload += "\n"
	}
	path, err := s.privatePath(groupID, agentID)
	if err != nil {
		return err
	}
	groupDir := filepath.Join(s.root, groupID)
	if err := os.MkdirAll(filepath.Join(groupDir, privateDirName), 0o755); err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(groupDir, privateLockName), privateLockWait)
	if err != nil {
		return fmt.Errorf("群聊私有日志正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()
	privateMu.Lock()
	defer privateMu.Unlock()
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
	af, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer af.Close()
	if _, err := af.WriteString(payload); err != nil {
		_ = af.Truncate(before)
		return err
	}
	if err := af.Sync(); err != nil {
		_ = af.Truncate(before)
		return err
	}
	return nil
}

// PrivateRewrite 原子替换私有日志（预留：坏行清理 / 用户手动整理）。
func (s *Store) PrivateRewrite(groupID, agentID, payload string) error {
	path, err := s.privatePath(groupID, agentID)
	if err != nil {
		return err
	}
	groupDir := filepath.Join(s.root, groupID)
	if err := os.MkdirAll(filepath.Join(groupDir, privateDirName), 0o755); err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(groupDir, privateLockName), privateLockWait)
	if err != nil {
		return fmt.Errorf("群聊私有日志正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()
	privateMu.Lock()
	defer privateMu.Unlock()
	return atomfile.WriteFileAtomic(path, []byte(payload))
}
