// windowreg/inbox.go：跨窗口投递信箱（Deliver / Take / Ack）。
//
// 接管采用 claim 独占创建协议（2026-11-20 实施定稿，第三版）：
//   take 与投递方撤回对同一 <reqId>.claim 做 O_EXCL 独占创建，内核保证恰一方成功
//   —— claim 到的 side 拥有该请求的处置权。claim 由 Ack 时释放（接管方处理完回执
//   后删掉），崩溃残留由 cleanupInbox 按超龄清理。
//   为什么不能用 rename：Win10+ POSIX 语义下「同一文件对象可被多个预打开的句柄
//   先后改名」，remove+rename 与 rename+rename 都实测双双成功（竞态用例复现），
//   两个 API 各自报成功但文件只有一个落点，双方无法就「谁赢了」达成一致；
//   O_EXCL 创建没有「先打开再操作」的竞态窗口，跨平台成立。
//   时效：接管后 now - ts > 3s 的请求 ack("expired") 丢弃——投递方早已放弃，迟到
//   处理只会造成双开。
package windowreg

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"datalens/internal/atomfile"
)

// InboxWatchKind 是根壳给信箱目录挂 resource-changed 监听用的 kind 名，
// 前端按 payload.kind === 'window-inbox' 分支（与 memo / ai-session 同一模式）。
const InboxWatchKind = "window-inbox"

const (
	requestTTL       = 3 * time.Second  // take 侧时效：超过视为投递方已放弃
	ackPollInterval  = 50 * time.Millisecond
	perCandidateWait = 1500 * time.Millisecond // 单候选 ack 上限，受总预算约束
	staleAckMaxAge   = 10 * time.Second        // 超过它才算孤儿回执，可清理
)

// Request 是信箱里的一条投递请求。只含定位信息，不接受任何命令或路径操作。
type Request struct {
	ReqID     string `json:"reqId"`
	From      string `json:"from"`
	Workspace string `json:"workspace"`
	SessionID string `json:"sessionId"`
	TS        int64  `json:"ts"`
}

// Ack 是目标窗口写回的回执。status: ok / mismatch / expired。
type Ack struct {
	ReqID    string `json:"reqId"`
	Status   string `json:"status"`
	WindowID string `json:"windowId"`
	TS       int64  `json:"ts"`
}

// Deliver 找到 workspace 归一匹配的存活候选窗口并投递，返回被复用的 windowId
//（空 = 没有可用窗口，调用方退化开新窗口）。wait 是跨候选共享的总预算。
func Deliver(root, workspace, sessionID, fromWindowID string, wait time.Duration) (string, error) {
	ws := NormalizeWorkspace(workspace)
	if ws == "" {
		return "", nil
	}
	candidates, err := matchCandidates(root, ws, fromWindowID)
	if err != nil {
		return "", err
	}
	if len(candidates) == 0 {
		return "", nil
	}
	deadline := time.Now().Add(wait)
	for _, cand := range candidates {
		if time.Now().After(deadline) {
			break
		}
		windowID, retryable, derr := deliverOne(root, cand, ws, sessionID, fromWindowID, deadline)
		if derr != nil {
			return "", derr
		}
		if windowID != "" {
			return windowID, nil
		}
		if !retryable {
			break // 剩余预算不足，别再空转候选
		}
	}
	return "", nil
}

// matchCandidates 扫注册表，返回 workspace 匹配且存活的候选（按 heartbeat 降序）。
// 排除投递方自身：meta 与 UI 工作区短暂不一致时可自投自收（表现为本窗口莫名切会话）。
func matchCandidates(root, ws, fromWindowID string) ([]Entry, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("窗口注册表根目录读取失败: %w", err)
	}
	var found []Entry
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if fromWindowID != "" && e.Name() == fromWindowID {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(root, e.Name(), "meta.json"))
		if readErr != nil {
			continue // 非窗口目录或尚未写完 meta
		}
		var entry Entry
		if json.Unmarshal(raw, &entry) != nil || entry.Workspace == "" {
			continue
		}
		if entry.Workspace != ws || !alive(root, entry.WindowID) {
			continue
		}
		found = append(found, entry)
	}
	sort.Slice(found, func(i, j int) bool { return found[i].Heartbeat > found[j].Heartbeat })
	return found, nil
}

// deliverOne 向单个候选投递并等回执。
// 返回 (windowId, retryable, err)：windowId 非空 = 复用成功；retryable = 还有预算可试下一候选。
func deliverOne(root string, cand Entry, ws, sessionID, fromWindowID string, deadline time.Time) (string, bool, error) {
	inbox := filepath.Join(root, cand.WindowID, "inbox")
	reqID := newReqID()
	reqPath := filepath.Join(inbox, reqID+".json")
	req := Request{
		ReqID:     reqID,
		From:      fromWindowID,
		Workspace: ws,
		SessionID: sessionID,
		TS:        time.Now().UnixMilli(),
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return "", false, fmt.Errorf("投递请求序列化失败: %w", err)
	}
	if err := atomfile.WriteFileAtomic(reqPath, raw); err != nil {
		return "", true, nil // 目标目录可能正被 Sweep 清掉：试下一候选
	}

	waitAck := func(until time.Time) (string, bool) { // 返回 (status, done)
		for time.Now().Before(until) {
			status, ok := readAck(inbox, reqID)
			if ok {
				return status, true
			}
			time.Sleep(ackPollInterval)
		}
		return "", false
	}

	// 单候选等待上限受总预算约束。
	candDeadline := time.Now().Add(perCandidateWait)
	if candDeadline.After(deadline) {
		candDeadline = deadline
	}
	if status, done := waitAck(candDeadline); done {
		return ackOutcome(status, cand.WindowID)
	}
	// 超时：尝试撤回。撤回与接管对同一 <reqId>.claim 做 O_EXCL 独占创建，恰一方
	// 得手（见包注释——remove/rename 方案在 Win10+ POSIX 语义下均不互斥，已弃用）。
	claimed, claimErr := claimRequest(inbox, reqID)
	if claimErr != nil {
		return "", true, nil // IO 错误：按未接管换候选（安全侧）
	}
	if claimed {
		// 撤回赢：目标从未接管，安全清场换候选。
		_ = os.Remove(reqPath)
		releaseClaim(inbox, reqID)
		return "", true, nil
	}
	// claim 已存在 = 目标已接管（接管后死亡也是这个分支）。目标已死则 ack 永远
	// 不会来：按未接管换候选——否则投递方误判「已被接管」返回成功，结果既不开
	// 新窗也没人打开会话（静默失败）。
	if !alive(root, cand.WindowID) {
		return "", true, nil
	}
	// 已被接管：继续等 ack 至总预算。
	if status, done := waitAck(deadline); done {
		return ackOutcome(status, cand.WindowID)
	}
	// 接管方还活着但迟迟不回执——信任它会处理，不再开新窗口（宁可漏开不双开）。
	// 但若接管期间目标又退出了，ack 已不可能到来、会话将无人打开：退回未接管，
	// 让投递方开新窗口（接管方死后残留随目录被 Sweep 清掉，无双开风险）。
	if !alive(root, cand.WindowID) {
		return "", true, nil
	}
	return cand.WindowID, false, nil
}

// ackOutcome 把回执翻译成 Deliver 的返回值。
func ackOutcome(status, windowID string) (string, bool, error) {
	switch status {
	case "ok":
		return windowID, false, nil
	case "mismatch", "expired":
		return "", true, nil // 该候选没接下：换下一候选
	default:
		return "", true, nil // 未知状态按没接下处理
	}
}

// readAck 读请求的回执；不存在返回 ("", false)。
func readAck(inbox, reqID string) (string, bool) {
	if !validReqID(reqID) {
		return "", false
	}
	raw, err := os.ReadFile(filepath.Join(inbox, reqID+".ack"))
	if err != nil {
		return "", false
	}
	var ack Ack
	if json.Unmarshal(raw, &ack) != nil {
		return "", false
	}
	return ack.Status, true
}

// claimRequest 对请求做独占接管登记：O_EXCL 创建 <reqId>.claim，内核保证同一
// 请求的接管与撤回恰有一方得手（见包注释——rename 方案在 Win10+ 上不互斥，已弃用）。
// 返回 claimed=false 表示已被对方抢走（或正在处理），无错误。
func claimRequest(inbox, reqID string) (bool, error) {
	f, err := os.OpenFile(filepath.Join(inbox, reqID+".claim"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err == nil {
		_ = f.Close()
		return true, nil
	}
	if os.IsExist(err) {
		return false, nil
	}
	return false, fmt.Errorf("信箱接管登记失败: %w", err)
}

// releaseClaim 释放接管登记（Ack 时调用；崩溃残留由 cleanupInbox 超龄清理）。
func releaseClaim(inbox, reqID string) {
	if validReqID(reqID) {
		_ = os.Remove(filepath.Join(inbox, reqID+".claim"))
	}
}

// Take 取走本窗口 inbox 里按时间最早的一条待处理请求。
// 接管 = 对该请求 O_EXCL 创建 claim 成功；接管与投递方撤回互斥由创建语义保证。
// 请求内容读入内存后即删 .json（claim 保留到 Ack 释放，期间投递方撤回必失败）。
// 无请求 / 请求已被抢走返回 (nil, nil)；过期请求就地 ack("expired") 丢弃。
func (r *Registry) Take() (*Request, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	inbox := r.InboxDir()
	entries, err := os.ReadDir(inbox)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("信箱目录读取失败: %w", err)
	}
	// 先顺手清残留：超龄 claim、孤儿 .ack、atomfile tmp。
	cleanupInbox(inbox, entries)

	// 候选按 mtime 升序：最早优先。被抢走（claim 已存在）就试下一条。
	type candidate struct {
		name string
		mod  time.Time
	}
	var cands []candidate
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".ack") {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		cands = append(cands, candidate{name: name, mod: info.ModTime()})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].mod.Before(cands[j].mod) })

	for _, cand := range cands {
		reqID := strings.TrimSuffix(cand.name, ".json")
		if !validReqID(reqID) {
			_ = os.Remove(filepath.Join(inbox, cand.name)) // 非法文件名直接清掉
			continue
		}
		claimed, claimErr := claimRequest(inbox, reqID)
		if claimErr != nil {
			return nil, claimErr
		}
		if !claimed {
			continue // 已被投递方撤回流程或前一轮 take 占住
		}
		raw, readErr := os.ReadFile(filepath.Join(inbox, cand.name))
		if readErr != nil {
			releaseClaim(inbox, reqID)
			continue // 内容已不在（异常残留），看下一条
		}
		_ = os.Remove(filepath.Join(inbox, cand.name)) // 内容已入内存，.json 使命完成
		var req Request
		if json.Unmarshal(raw, &req) != nil || !validReqID(req.ReqID) {
			releaseClaim(inbox, reqID)
			continue
		}
		// 以文件名为准覆盖内容里的 reqId：两者不一致时回执会写到另一条请求名下（投递方超时）。
		req.ReqID = reqID
		if time.Since(time.UnixMilli(req.TS)) > requestTTL {
			// 投递方早已放弃（开新窗或撤回），迟到处理只会造成双开：丢弃并回执
			//（Ack 内部会释放 claim）。
			_ = r.Ack(req.ReqID, "expired")
			continue
		}
		return &req, nil // claim 保持持有：处理期间投递方撤回必失败，Ack 时释放
	}
	return nil, nil
}

// Ack 写回执并释放接管登记。
func (r *Registry) Ack(reqID, status string) error {
	if !validReqID(reqID) {
		return errors.New("信箱回执拒绝非法请求 id")
	}
	ack := Ack{
		ReqID:    reqID,
		Status:   status,
		WindowID: r.entry.WindowID,
		TS:       time.Now().UnixMilli(),
	}
	raw, err := json.Marshal(ack)
	if err != nil {
		return fmt.Errorf("信箱回执序列化失败: %w", err)
	}
	if err := atomfile.WriteFileAtomic(filepath.Join(r.InboxDir(), reqID+".ack"), raw); err != nil {
		return fmt.Errorf("信箱回执写入失败: %w", err)
	}
	releaseClaim(r.InboxDir(), reqID)
	return nil
}

// cleanupInbox 清理超龄残留：claim（接管方崩溃未及 Ack）、孤儿 .ack（无对应
// .json 的回执——新鲜 ack 可能是投递方正在轮询的回执，只清超龄的）与 atomfile
// tmp（<路径>.<pid>.<ns>.tmp，崩溃时留下；Take 的 .json 过滤本来就不会误收）。
func cleanupInbox(inbox string, entries []os.DirEntry) {
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".tmp") {
			if info, err := e.Info(); err != nil || time.Since(info.ModTime()) > staleAckMaxAge {
				_ = os.Remove(filepath.Join(inbox, name))
			}
			continue
		}
		if strings.HasSuffix(name, ".claim") {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) <= staleAckMaxAge {
				continue // 新鲜 claim：接管方正在处理
			}
			_ = os.Remove(filepath.Join(inbox, name))
			continue
		}
		if strings.HasSuffix(name, ".ack") {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) <= staleAckMaxAge {
				continue // 新鲜回执：投递方可能正在轮询
			}
			reqID := strings.TrimSuffix(name, ".ack")
			if _, err := os.Stat(filepath.Join(inbox, reqID+".json")); os.IsNotExist(err) {
				_ = os.Remove(filepath.Join(inbox, name))
			}
		}
	}
}
