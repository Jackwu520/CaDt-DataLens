// lease_service.go：群聊讨论租约的绑定层（multi-instance-sync P6 收尾）。
//
// 粒度 = 整场讨论（含主持人讨论 / 自由聊天的连续发言）：一个群同一时刻只有
// 一个窗口在主持，第二个窗口发起讨论返回 busy（「群聊正在另一窗口讨论」）。
// 结构与会话回合租约同构（根门闩共享 + 群独占，锁文件在被保护目录之外），
// 进程内重入按归属窗口名分桶；窗口关闭按归属释放。
package aigroups

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"datalens/internal/resourcelease"
)

// OwnerForCall 返回绑定调用方窗口名（main 注入 callerWindowName）。
// 空串 = 兼容测试与非绑定路径（单桶语义）。
var OwnerForCall func(ctx context.Context) string

func groupOwnerKey(ctx context.Context) string {
	if OwnerForCall != nil {
		return strings.TrimSpace(OwnerForCall(ctx))
	}
	return ""
}

// GroupLeaseStatus 群聊讨论租约的获取/探测结果。
type GroupLeaseStatus struct {
	Acquired bool                `json:"acquired"`
	Busy     bool                `json:"busy"`
	Owner    resourcelease.Owner `json:"owner,omitempty"`
}

type groupLeaseEntry struct {
	gate    *resourcelease.Lease
	group   *resourcelease.Lease
	holders map[string]int
	owner   resourcelease.Owner
}

var (
	groupLeaseMu sync.Mutex
	groupLeases  = map[string]*groupLeaseEntry{}
)

// GroupGatePath 群聊根门闩（在 ai-groups 根之外，根被改名/移动时不失效）。
func (s *Store) GroupGatePath() string {
	return s.root + ".gate"
}

// GroupLeasePath 群讨论租约路径（.locks/ 在被保护目录之外；同 id 重建仍撞同一把锁）。
func (s *Store) GroupLeasePath(id string) (string, error) {
	if !ValidGroupID(id) {
		return "", fmt.Errorf("非法群聊 id：%q", id)
	}
	if err := os.MkdirAll(filepath.Join(s.root, ".locks"), 0o755); err != nil {
		return "", err
	}
	return filepath.Join(s.root, ".locks", id+".turn.lease"), nil
}

// GroupLeaseAcquire 取群讨论租约（根门闩共享 + 群独占，非阻塞）。
// 同窗口重入计数；跨窗口（或跨进程）Busy。
func (g *GroupStore) GroupLeaseAcquire(ctx context.Context, id, label string) (GroupLeaseStatus, error) {
	st, err := g.store()
	if err != nil {
		return GroupLeaseStatus{}, err
	}
	if !ValidGroupID(id) {
		return GroupLeaseStatus{}, fmt.Errorf("非法群聊 id：%q", id)
	}
	if err := st.EnsureRoot(); err != nil {
		return GroupLeaseStatus{}, err
	}
	ownerKey := groupOwnerKey(ctx)

	groupLeaseMu.Lock()
	if entry := groupLeases[id]; entry != nil {
		if _, held := entry.holders[ownerKey]; held {
			entry.holders[ownerKey]++
			res := GroupLeaseStatus{Acquired: true, Owner: entry.owner}
			groupLeaseMu.Unlock()
			return res, nil
		}
		res := GroupLeaseStatus{Busy: true, Owner: entry.owner}
		groupLeaseMu.Unlock()
		return res, nil
	}
	groupLeaseMu.Unlock()

	gate, err := resourcelease.AcquireShared(st.GroupGatePath())
	if err != nil {
		if resourcelease.IsBusy(err) {
			return GroupLeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err)}, nil
		}
		return GroupLeaseStatus{}, fmt.Errorf("获取群聊根门闩失败：%w", err)
	}
	leasePath, err := st.GroupLeasePath(id)
	if err != nil {
		gate.Release()
		return GroupLeaseStatus{}, err
	}
	owner := resourcelease.Owner{
		PID:       os.Getpid(),
		Label:     groupLeaseLabel(label, ownerKey),
		StartedAt: time.Now().UnixMilli(),
		Version:   1,
	}
	lease, err := resourcelease.Acquire(leasePath, owner)
	if err != nil {
		gate.Release()
		if resourcelease.IsBusy(err) {
			return GroupLeaseStatus{Busy: true, Owner: resourcelease.BusyOwner(err)}, nil
		}
		return GroupLeaseStatus{}, fmt.Errorf("获取群聊讨论锁失败：%w", err)
	}

	// 双检：并发 Acquire 可能已经入表；把本次多拿的 ref 还回去。
	groupLeaseMu.Lock()
	if entry := groupLeases[id]; entry != nil {
		entry.holders[ownerKey]++
		res := GroupLeaseStatus{Acquired: true, Owner: entry.owner}
		groupLeaseMu.Unlock()
		lease.Release()
		gate.Release()
		return res, nil
	}
	groupLeases[id] = &groupLeaseEntry{
		gate:    gate,
		group:   lease,
		holders: map[string]int{ownerKey: 1},
		owner:   owner,
	}
	groupLeaseMu.Unlock()
	return GroupLeaseStatus{Acquired: true, Owner: owner}, nil
}

// groupLeaseLabel 把窗口名并进横幅 label（同进程多窗口 PID 相同，靠窗口名区分）。
func groupLeaseLabel(label, ownerKey string) string {
	label = strings.TrimSpace(label)
	if ownerKey == "" {
		if label == "" {
			return "group"
		}
		return label
	}
	if label == "" {
		return "窗口 " + ownerKey
	}
	return label + " · 窗口 " + ownerKey
}

// GroupLeaseRelease 释放调用方窗口的群讨论租约；最后一个持有者退出才解锁。
func (g *GroupStore) GroupLeaseRelease(ctx context.Context, id string) error {
	ownerKey := groupOwnerKey(ctx)
	groupLeaseMu.Lock()
	entry := groupLeases[id]
	if entry == nil {
		groupLeaseMu.Unlock()
		return nil
	}
	if n := entry.holders[ownerKey]; n > 1 {
		entry.holders[ownerKey] = n - 1
		groupLeaseMu.Unlock()
		return nil
	}
	delete(entry.holders, ownerKey)
	if len(entry.holders) > 0 {
		groupLeaseMu.Unlock()
		return nil
	}
	delete(groupLeases, id)
	groupLeaseMu.Unlock()
	entry.group.Release()
	entry.gate.Release()
	return nil
}

// GroupLeaseStatus 探测群讨论租约：本进程持有 -> Acquired；别的窗口/进程持有 ->
// Busy + Owner；空闲 -> 两者都 false。只用于 UI 提示，不用于写决策。
func (g *GroupStore) GroupLeaseStatus(id string) (GroupLeaseStatus, error) {
	st, err := g.store()
	if err != nil {
		return GroupLeaseStatus{}, err
	}
	if !ValidGroupID(id) {
		return GroupLeaseStatus{}, fmt.Errorf("非法群聊 id：%q", id)
	}
	groupLeaseMu.Lock()
	entry := groupLeases[id]
	if entry != nil {
		res := GroupLeaseStatus{Acquired: true, Owner: entry.owner}
		groupLeaseMu.Unlock()
		return res, nil
	}
	groupLeaseMu.Unlock()

	leasePath, err := st.GroupLeasePath(id)
	if err != nil {
		return GroupLeaseStatus{}, err
	}
	owner, busy, err := resourcelease.Probe(leasePath)
	if err != nil {
		return GroupLeaseStatus{}, err
	}
	return GroupLeaseStatus{Busy: busy, Owner: owner}, nil
}

// GroupLeaseReleaseByOwner 归属窗口关闭时释放它名下的全部群讨论租约；
// 最后一个持有者退出才解锁。返回触及的群数。
func (g *GroupStore) GroupLeaseReleaseByOwner(owner string) int {
	ownerKey := strings.TrimSpace(owner)
	if ownerKey == "" {
		return 0
	}
	groupLeaseMu.Lock()
	ids := make([]string, 0, 2)
	for id, entry := range groupLeases {
		if _, held := entry.holders[ownerKey]; held {
			ids = append(ids, id)
		}
	}
	type pendingRelease struct {
		group *resourcelease.Lease
		gate  *resourcelease.Lease
	}
	releases := make([]pendingRelease, 0, len(ids))
	for _, id := range ids {
		entry := groupLeases[id]
		delete(entry.holders, ownerKey)
		if len(entry.holders) == 0 {
			delete(groupLeases, id)
			releases = append(releases, pendingRelease{entry.group, entry.gate})
		}
	}
	groupLeaseMu.Unlock()
	for _, r := range releases {
		r.group.Release()
		r.gate.Release()
	}
	return len(ids)
}
