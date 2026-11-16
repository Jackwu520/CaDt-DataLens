package cmdbridge

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"datalens/internal/envvars"
	"datalens/internal/executil"
	"datalens/internal/procctl"
)

// 进程桥：为内置终端面板以外的场景（插件命令、git 浅集成等）提供受控的命令执行能力。
// 信任模型与插件一致：页面 JS（含插件）可以启动本机进程，只安装可信来源的插件。

type CommandResult struct {
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

const (
	commandOutputCap   = int64(8 << 20) // 单命令输出上限 8 MB
	commandMaxTimeout  = 120000         // 插件同步命令超时上限 120 s
	commandLineMaxSize = 64 << 10       // 单行上限 64 KB
)

type limitedWriter struct {
	w     *bytes.Buffer
	limit int64
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	room := lw.limit - int64(lw.w.Len())
	if room <= 0 {
		return len(p), nil // 丢弃超出部分
	}
	if int64(len(p)) > room {
		lw.w.Write(p[:room])
		return len(p), nil
	}
	lw.w.Write(p)
	return len(p), nil
}

// RunCommandSync 同步执行一个命令并收集输出；非零退出码不是错误（通过 Code 返回）。
func (b *Bridge) RunCommandSync(exe string, args []string, cwd string, timeoutMs int) (*CommandResult, error) {
	return b.runCommandSyncRegistered("", exe, args, cwd, timeoutMs, commandMaxTimeout)
}

// runCommandSyncRegistered：runId 非空时把取消函数注册进 共享消息表（可被 procctl.Stop 杀掉）。
// maxMs 是调用方的超时上限（插件 120 s / AI 前台 600 s）；超界或非正数回落默认 20 s。
func (b *Bridge) runCommandSyncRegistered(id, exe string, args []string, cwd string, timeoutMs, maxMs int) (*CommandResult, error) {
	if err := procctl.NormalizeArgs(exe, args); err != nil {
		return nil, err
	}
	if maxMs <= 0 {
		maxMs = commandMaxTimeout
	}
	if timeoutMs <= 0 || timeoutMs > maxMs {
		timeoutMs = 20000
	}
	dir, err := procctl.WorkDir(cwd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	if id != "" {
		if err := procctl.Register(id, cancel); err != nil {
			return nil, err
		}
		defer procctl.Unregister(id)
	}
	cmd := exec.CommandContext(ctx, exe, args...)
	procctl.ApplyCancel(cmd)
	cmd.Dir = dir
	cmd.Env = envvars.MergeEnv(os.Environ())
	executil.HideCommandWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &stdout, limit: commandOutputCap}
	cmd.Stderr = &limitedWriter{w: &stderr, limit: commandOutputCap}
	runErr := cmd.Run()
	res := &CommandResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctx.Err() == context.DeadlineExceeded {
		return res, fmt.Errorf("命令超时（%d ms）", timeoutMs)
	}
	if ctx.Err() != nil && ctx.Err() != context.DeadlineExceeded {
		// 被用户停止（AIStopShellRun）：返回明确错误供前端标注「用户已停止」
		return res, fmt.Errorf("命令已被用户停止")
	}
	if exitErr, ok := runErr.(*exec.ExitError); ok {
		res.Code = exitErr.ExitCode()
		return res, nil
	}
	if runErr != nil {
		return nil, runErr
	}
	return res, nil
}

// AIStopShellRun 停止一次 run_command 的同步执行（按前端生成的 runId 杀进程树）；不存在时静默成功。
func (b *Bridge) AIStopShellRun(id string) {
	procctl.Stop(strings.TrimSpace(id))
}

// StartCommand 流式执行：按行发出 cmd-out {id, stream, data} 事件，结束时发出 cmd-exit {id, code}。
// id 由调用方（前端/插件）生成并保证唯一。
func (b *Bridge) StartCommand(id, exe string, args []string, cwd string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("id 不能为空")
	}
	if err := procctl.NormalizeArgs(exe, args); err != nil {
		return err
	}
	dir, err := procctl.WorkDir(cwd)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := procctl.Register(id, cancel); err != nil {
		cancel()
		return err
	}

	cmd := exec.CommandContext(ctx, exe, args...)
	procctl.ApplyCancel(cmd)
	cmd.Dir = dir
	cmd.Env = envvars.MergeEnv(os.Environ())
	executil.HideCommandWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		procctl.Stop(id)
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		procctl.Stop(id)
		return err
	}
	if err := cmd.Start(); err != nil {
		procctl.Stop(id)
		return err
	}
	go func() {
		var wg sync.WaitGroup
		emitLines := func(pipe interface{ Read([]byte) (int, error) }, stream string) {
			defer wg.Done()
			buf := make([]byte, 0, commandLineMaxSize)
			chunk := make([]byte, 4096)
			total := int64(0)
			for {
				n, readErr := pipe.Read(chunk)
				if n > 0 {
					total += int64(n)
					buf = append(buf, chunk[:n]...)
					for {
						idx := bytes.IndexByte(buf, '\n')
						if idx < 0 {
							if len(buf) > commandLineMaxSize {
								b.emitCommandEvent(id, stream, string(buf[:commandLineMaxSize]))
								buf = buf[:0]
							}
							break
						}
						b.emitCommandEvent(id, stream, string(buf[:idx]))
						buf = buf[:copy(buf, buf[idx+1:])]
					}
					if total > commandOutputCap {
						b.emitCommandEvent(id, stream, "…输出超过 8 MB 上限，已截断…")
						break
					}
				}
				if readErr != nil {
					if len(buf) > 0 {
						b.emitCommandEvent(id, stream, string(buf))
					}
					return
				}
			}
		}
		wg.Add(2)
		go emitLines(stdout, "out")
		go emitLines(stderr, "err")
		// 取消时主动关闭读端：taskkill 可能留下握着管道的孤儿子进程（Cygwin 偶发
		// 「操作不被支持」杀不掉），不关管道 wg.Wait 要等它自然退出，作业会卡在 running。
		readersDone := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				_ = stdout.Close()
				_ = stderr.Close()
			case <-readersDone:
			}
		}()
		wg.Wait()
		close(readersDone)
		code := 0
		if waitErr := cmd.Wait(); waitErr != nil {
			if ctx.Err() != nil {
				code = -1 // 被 taskkill/取消终止：wrapper 的退出码无意义，统一记 -1
			} else if exitErr, ok := waitErr.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		procctl.Stop(id)
		finishCommandJob(id, code)
		emit("cmd-exit", map[string]string{"id": id, "code": fmt.Sprintf("%d", code)})
	}()
	return nil
}

func (b *Bridge) emitCommandEvent(id, stream, data string) {
	if job := lookupCommandJob(id); job != nil {
		job.writeLine(stream, data)
	}
		// 键必须带引号：map 字面量的键是表达式，裸写 id/stream/data 会把变量值当键名
		//（{"bg-1":"bg-1",...}），前端按 payload.id 分发永远落空，后台终端实时输出全灭。
		emit("cmd-out", map[string]string{"id": id, "stream": stream, "data": strings.ToValidUTF8(data, "\ufffd")})
}

// ---------- AI 后台命令作业（后台终端） ----------
// 在 StartCommand 之上加输出缓冲与状态查询：AICommandStart 启动的作业注册进
// commandJobs，cmd-out 每行同步入缓冲（超限从头丢弃），cmd-exit 记录退出码；
// AICommandStatus 按游标增量读取，AICommandStop 终止并返回最终状态。

const (
	aiJobBufferCap   = 256 << 10       // 单作业输出缓冲 256 KB，超限从头丢弃
	aiJobReadChunk   = 64 << 10        // 单次状态查询最多返回 64 KB 增量
	aiJobMaxFinished = 32              // 保留的已结束作业数，超出淘汰最旧
	aiJobStopWait    = 4 * time.Second // 必须大于 procctl.ApplyCancel 的 WaitDelay（3s），让兜底关闭管道后仍能观察到退出
)

type commandJob struct {
	id      string // 等于 StartCommand 的 id（bg-<seq>）
	shell   string
	command string

	mu        sync.Mutex
	buf       []byte
	base      int64 // buf[0] 在逻辑输出流中的绝对偏移（头部丢弃后前移）
	written   int64 // 已写入逻辑流的总字节数
	dropped   bool  // 是否发生过头部丢弃
	startedAt time.Time
	endedAt   time.Time
	exited    bool
	code      int
}

func (j *commandJob) writeChunk(p []byte) {
	j.mu.Lock()
	j.buf = append(j.buf, p...)
	j.written += int64(len(p))
	if over := len(j.buf) - aiJobBufferCap; over > 0 {
		j.buf = j.buf[over:]
		j.base += int64(over)
		j.dropped = true
	}
	j.mu.Unlock()
}

func (j *commandJob) writeLine(stream, data string) {
	line := data
	if stream == "err" {
		line = "[stderr] " + data
	}
	j.writeChunk([]byte(line + "\n"))
}

// read 返回 since 之后的增量（最多 aiJobReadChunk 字节）与新游标；
// lost 表示 since 之前的内容已因超出缓冲被丢弃。
func (j *commandJob) read(since int64) (text string, cursor int64, lost bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	start := since
	if start < j.base {
		start = j.base
		lost = true
	}
	if start > j.written {
		start = j.written
	}
	end := j.written
	if end-start > aiJobReadChunk {
		end = start + aiJobReadChunk
	}
	return string(j.buf[start-j.base : end-j.base]), end, lost
}

var (
	commandJobsMu sync.Mutex
	commandJobs   = map[string]*commandJob{}
	commandJobSeq int
)

func registerCommandJob(id, shell, command string) *commandJob {
	job := &commandJob{id: id, shell: shell, command: command, startedAt: time.Now()}
	commandJobsMu.Lock()
	commandJobs[id] = job
	commandJobsMu.Unlock()
	return job
}

func unregisterCommandJob(id string) {
	commandJobsMu.Lock()
	delete(commandJobs, id)
	commandJobsMu.Unlock()
}

func lookupCommandJob(id string) *commandJob {
	commandJobsMu.Lock()
	defer commandJobsMu.Unlock()
	return commandJobs[id]
}

// finishCommandJob 记录退出码；已结束作业保留最近 aiJobMaxFinished 个供查询，其余淘汰最旧。
func finishCommandJob(id string, code int) {
	commandJobsMu.Lock()
	defer commandJobsMu.Unlock()
	if job := commandJobs[id]; job != nil {
		job.mu.Lock()
		if !job.exited {
			job.exited = true
			job.code = code
			job.endedAt = time.Now()
		}
		job.mu.Unlock()
	}
	type endedJob struct {
		id    string
		ended time.Time
	}
	var ended []endedJob
	for jid, j := range commandJobs {
		j.mu.Lock()
		isEnded := j.exited
		at := j.endedAt
		j.mu.Unlock()
		if isEnded {
			ended = append(ended, endedJob{jid, at})
		}
	}
	if len(ended) <= aiJobMaxFinished {
		return
	}
	sort.Slice(ended, func(i, k int) bool { return ended[i].ended.Before(ended[k].ended) })
	for _, e := range ended[:len(ended)-aiJobMaxFinished] {
		delete(commandJobs, e.id)
	}
}

type AICommandJobStatus struct {
	JobId       string `json:"jobId"`
	State       string `json:"state"` // running | exited | notfound
	Shell       string `json:"shell"`
	Command     string `json:"command"`
	Code        int    `json:"code"`
	DurationMs  int64  `json:"durationMs"`
	Output      string `json:"output"`
	Cursor      int64  `json:"cursor"`
	Truncated   bool   `json:"truncated"`
	StartedAtMs int64  `json:"startedAtMs"`
}

func (b *Bridge) commandJobStatus(jobId string, since int64) *AICommandJobStatus {
	commandJobsMu.Lock()
	job := commandJobs[jobId]
	commandJobsMu.Unlock()
	if job == nil {
		return &AICommandJobStatus{JobId: jobId, State: "notfound"}
	}
	st := &AICommandJobStatus{JobId: job.id, Shell: job.shell, Command: job.command, StartedAtMs: job.startedAt.UnixMilli()}
	job.mu.Lock()
	exited, code, endedAt := job.exited, job.code, job.endedAt
	job.mu.Unlock()
	if exited {
		st.State = "exited"
		st.Code = code
		st.DurationMs = endedAt.Sub(job.startedAt).Milliseconds()
	} else {
		st.State = "running"
		st.DurationMs = time.Since(job.startedAt).Milliseconds()
	}
	st.Output, st.Cursor, st.Truncated = job.read(since)
	return st
}

// AICommandStatus 查询后台作业状态与自 since 游标以来的增量输出。
func (b *Bridge) AICommandStatus(jobId string, since int64) (*AICommandJobStatus, error) {
	if strings.TrimSpace(jobId) == "" {
		return nil, fmt.Errorf("jobId 不能为空")
	}
	return b.commandJobStatus(jobId, since), nil
}

// AICommandStop 终止后台作业并等待其退出（最多 4 s），返回包含全部缓冲输出的最终状态。
func (b *Bridge) AICommandStop(jobId string) (*AICommandJobStatus, error) {
	if strings.TrimSpace(jobId) == "" {
		return nil, fmt.Errorf("jobId 不能为空")
	}
	commandJobsMu.Lock()
	job := commandJobs[jobId]
	commandJobsMu.Unlock()
	if job != nil {
		job.mu.Lock()
		exited := job.exited
		job.mu.Unlock()
		if !exited {
			procctl.Stop(jobId)
			deadline := time.Now().Add(aiJobStopWait)
			for {
				job.mu.Lock()
				exited = job.exited
				job.mu.Unlock()
				if exited || time.Now().After(deadline) {
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
		}
	}
	return b.commandJobStatus(jobId, 0), nil
}

// StopCommand 终止一个流式命令。
func (b *Bridge) StopCommand(id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("id 不能为空")
	}
	if !procctl.Stop(id) {
		return fmt.Errorf("没有正在运行的命令 %q", id)
	}
	return nil
}
