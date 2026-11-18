package resourcelease

import (
	"sync"

	"datalens/internal/sessionlock"
)

// keyState 是单个锁路径在本进程内的引用状态。
//
// 每把 key 一把互斥锁：AcquireWait 在等待 OS 锁时只阻塞本 key，不会拖住其它
// 资源的获取/释放（这是“一个慢盘卡死全应用”的根治点）。全局 map 锁只保护
// map 本身，绝不跨 IO 持有。
type keyState struct {
	mu        sync.Mutex
	path      string
	shared    int
	exclusive int
	noShare   bool // 破坏性独占：本进程后续 Acquire/AcquireWait/AcquireShared 一律 busy
	lock      *sessionlock.FileLock
	owner     Owner
}

var (
	managerMu sync.Mutex
	states    = map[string]*keyState{}
)

// getState 取/建某个 key 的状态。
//
// 零引用的 key 不删除：删除与“另一个 goroutine 已拿到 *keyState 正在等锁”
// 之间存在竞态，会让 manager 丢失对底层 OS 锁的记账。entry 很小，进程生命周期
// 内保留是安全的；数量上限是该进程打开过的资源数。
func getState(key string) *keyState {
	managerMu.Lock()
	st := states[key]
	if st == nil {
		st = &keyState{path: key}
		states[key] = st
	}
	managerMu.Unlock()
	return st
}

// release 递减本进程对某个 key 的引用；归零时释放内核锁。
func (st *keyState) release(mode Mode) {
	st.mu.Lock()
	switch mode {
	case Shared:
		if st.shared > 0 {
			st.shared--
		}
	case Exclusive:
		if st.exclusive > 0 {
			st.exclusive--
		}
	}
	if st.shared == 0 && st.exclusive == 0 && st.lock != nil {
		st.lock.Release()
		st.lock = nil
		st.owner = Owner{}
		st.noShare = false
	}
	st.mu.Unlock()
}
