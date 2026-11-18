// lease_service.go：会话回合租约的 Wails 绑定层。
//
// 一次 Acquire 同时拿「根门闩共享 + 会话独占」，Release 按相反顺序释放。与
// sessionstore.withSessionLock 的短租约共用 resourcelease 的进程内 refcount：
// 同一回合里的 Append/WriteMeta 不会自锁，别的窗口持有回合锁时写路径返回
// ErrSessionBusy（字符串前缀 session-busy:）。
package sessionstore

import (
	"fmt"
	"os"
	"sync"
	"time"

	"datalens/internal/resourcelease"
)

// LogStat 是会话正文的磁盘状态，交接协议用它判断“另一个窗口是否写过”。
type LogStat struct {
	Exists  bool  `json:"exists"`
	MtimeMs int64 `json:"mtimeMs"`
	Size    int64 `json:"size"`
}

// LeaseStatus 是租约获取/探测结果。
type LeaseStatus struct {
	Acquired bool                `json:"acquired"` // 本进程是否持有
	Busy     bool                `json:"busy"`     // 是否被其它进程持有
	Owner    resourcelease.Owner `json:"owner,omitempty"`
	Stat     LogStat             `json:"stat,omitempty"`
}

type sessionLeaseEntry struct {
	root    *resourcelease.Lease
	session *resourcelease.Lease
	refs    int
	owner   resourcelease.Owner
}

var (
	sessionLeaseMu sync.Mutex
	sessionLeases  = map[string]*sessionLeaseEntry{}
)

// AISessionLeaseAcquire 取会话回合租约（根共享 + 会话独占）。
//
// purpose 只用于调试/展示；timeoutMs=0 时非阻塞，>0 时在“根共享”下短等
// 目标会话（根独占的清理不会反向等待会话租约，不会形成 ABBA）。
func (s *Service) AISessionLeaseAcquire(id, purpose, label string, timeoutMs int) (LeaseStatus, error) {
	store, err := s.store()
	if err != nil {
		return LeaseStatus{}, err
	}
	if !ValidSessionID(id) {
		return LeaseStatus{}, fmt.Errorf("非法会话 id：%q", id)
	}
	if err := store.EnsureRoot(); err != nil {
		return LeaseStatus{}, err
	}

	sessionLeaseMu.Lock()
	if entry := sessionLeases[id]; entry != nil {
		entry.refs++
		st := LeaseStatus{Acquired: true, Owner: entry.owner, Stat: statLog(store, id)}
		sessionLeaseMu.Unlock()
		return st, nil
	}
	sessionLeaseMu.Unlock()

	rootLease, err := resourcelease.AcquireShared(store.RootGatePath())
	if err != nil {
		if resourcelease.IsBusy(err) {
			return LeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err), Stat: statLog(store, id)}, nil
		}
		return LeaseStatus{}, wrapLeaseErr(err)
	}
	leasePath, err := store.LeasePath(id)
	if err != nil {
		rootLease.Release()
		return LeaseStatus{}, err
	}
	owner := resourcelease.Owner{
		PID:       os.Getpid(),
		Label:     label,
		StartedAt: time.Now().UnixMilli(),
		Version:   1,
	}
	var sessionLease *resourcelease.Lease
	if timeoutMs > 0 {
		sessionLease, err = resourcelease.AcquireWait(leasePath, owner, time.Duration(timeoutMs)*time.Millisecond)
	} else {
		sessionLease, err = resourcelease.Acquire(leasePath, owner)
	}
	if err != nil {
		rootLease.Release()
		if resourcelease.IsBusy(err) {
			return LeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err), Stat: statLog(store, id)}, nil
		}
		return LeaseStatus{}, wrapLeaseErr(err)
	}

	// 双检：并发 Acquire 可能已经入表；把本次多拿的 ref 还回去。
	sessionLeaseMu.Lock()
	if entry := sessionLeases[id]; entry != nil {
		entry.refs++
		st := LeaseStatus{Acquired: true, Owner: entry.owner, Stat: statLog(store, id)}
		sessionLeaseMu.Unlock()
		sessionLease.Release()
		rootLease.Release()
		return st, nil
	}
	entry := &sessionLeaseEntry{root: rootLease, session: sessionLease, refs: 1, owner: owner}
	sessionLeases[id] = entry
	st := LeaseStatus{Acquired: true, Owner: owner, Stat: statLog(store, id)}
	sessionLeaseMu.Unlock()
	return st, nil
}

// AISessionLeaseRelease 释放本进程对这个会话的回合租约；refs 归零才真正解锁。
func (s *Service) AISessionLeaseRelease(id string) error {
	sessionLeaseMu.Lock()
	entry := sessionLeases[id]
	if entry == nil {
		sessionLeaseMu.Unlock()
		return nil
	}
	entry.refs--
	if entry.refs > 0 {
		sessionLeaseMu.Unlock()
		return nil
	}
	delete(sessionLeases, id)
	sessionLeaseMu.Unlock()
	entry.session.Release()
	entry.root.Release()
	return nil
}

// AISessionLeaseStatus 探测会话租约：本进程持有 -> Acquired；别的进程持有 ->
// Busy + Owner；空闲 -> 两者都 false。只用于 UI 提示，不用于写决策。
func (s *Service) AISessionLeaseStatus(id string) (LeaseStatus, error) {
	store, err := s.store()
	if err != nil {
		return LeaseStatus{}, err
	}
	if !ValidSessionID(id) {
		return LeaseStatus{}, fmt.Errorf("非法会话 id：%q", id)
	}
	sessionLeaseMu.Lock()
	entry := sessionLeases[id]
	if entry != nil {
		st := LeaseStatus{Acquired: true, Owner: entry.owner, Stat: statLog(store, id)}
		sessionLeaseMu.Unlock()
		return st, nil
	}
	sessionLeaseMu.Unlock()

	leasePath, err := store.LeasePath(id)
	if err != nil {
		return LeaseStatus{}, err
	}
	owner, busy, err := resourcelease.Probe(leasePath)
	if err != nil {
		return LeaseStatus{}, err
	}
	return LeaseStatus{Busy: busy, Owner: owner, Stat: statLog(store, id)}, nil
}

// AISessionStat 返回会话正文的磁盘状态（不存在时 Exists=false），交接协议用。
func (s *Service) AISessionStat(id string) (LogStat, error) {
	store, err := s.store()
	if err != nil {
		return LogStat{}, err
	}
	if !ValidSessionID(id) {
		return LogStat{}, fmt.Errorf("非法会话 id：%q", id)
	}
	return statLog(store, id), nil
}

func statLog(store *Store, id string) LogStat {
	path, err := store.logPath(id)
	if err != nil {
		return LogStat{}
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return LogStat{}
	}
	return LogStat{Exists: true, MtimeMs: info.ModTime().UnixMilli(), Size: info.Size()}
}
