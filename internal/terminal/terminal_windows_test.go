//go:build windows

package terminal

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	pty "github.com/aymanbagabas/go-pty"
)

func TestTerminalSessionEchoAndClose(t *testing.T) {
	var mu sync.Mutex
	var out strings.Builder
	emit := func(event string, data interface{}) {
		mu.Lock()
		defer mu.Unlock()
		if event == "term-out" {
			if m, ok := data.(map[string]string); ok {
				out.WriteString(m["data"])
			}
		}
	}
	session, err := startTermSession("t-test", "cmd", 80, 24, "", emit)
	if err != nil {
		t.Fatalf("创建会话失败: %v", err)
	}
	defer session.closeAll()

	// 等待 cmd 横幅/提示符
	deadline := time.Now().Add(8 * time.Second)
	got := ""
	for time.Now().Before(deadline) {
		mu.Lock()
		got = out.String()
		mu.Unlock()
		if strings.Contains(got, "Microsoft Windows") || strings.Contains(got, ">") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !strings.Contains(got, "Microsoft Windows") && !strings.Contains(got, ">") {
		t.Fatalf("8 秒内未收到 cmd 启动输出: %q", got)
	}

	// resize 不应报错
	if err := session.resize(100, 30); err != nil {
		t.Fatalf("resize 失败: %v", err)
	}

	// 写入 echo 命令并等待回显
	mu.Lock()
	out.Reset()
	mu.Unlock()
	if err := session.write("echo CADT_TEST_OK_9137\r\n"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	deadline = time.Now().Add(8 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		mu.Lock()
		s := out.String()
		mu.Unlock()
		if strings.Contains(s, "CADT_TEST_OK_9137") {
			found = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !found {
		mu.Lock()
		tail := out.String()
		mu.Unlock()
		t.Fatalf("未回显 echo 结果，最近输出: %q", tail)
	}
}

func TestTermShellCommandRejectsUnknown(t *testing.T) {
	if _, err := termShellArgs("bash"); err == nil {
		t.Fatal("未知 shell 应被拒绝")
	}
}

func TestTermShellAutoDefault(t *testing.T) {
	args, err := termShellArgs("")
	if err != nil {
		t.Fatalf("默认 shell 应可用: %v", err)
	}
	if pwsh := findPwsh(); pwsh != "" {
		if strings.ToLower(args[0]) != strings.ToLower(pwsh) {
			t.Fatalf("默认应使用 pwsh，实际: %v", args)
		}
		return
	}
	if strings.ToLower(args[0]) != "powershell.exe" {
		t.Fatalf("无 pwsh 时默认应回退 powershell，实际: %v", args)
	}
}

func TestTermShellsList(t *testing.T) {
	app := &Terminal{}
	shells := app.TermShells()
	ids := map[string]bool{}
	for _, s := range shells {
		ids[s["id"]] = true
	}
	if !ids["powershell"] || !ids["cmd"] {
		t.Fatalf("shell 列表应始终包含 powershell 与 cmd: %v", shells)
	}
	if pwsh := findPwsh(); pwsh != "" {
		if !ids["pwsh"] {
			t.Fatalf("本机有 PowerShell 7（%s）但列表未包含 pwsh", pwsh)
		}
		args, err := termShellArgs("pwsh")
		if err != nil {
			t.Fatalf("pwsh 参数生成失败: %v", err)
		}
		if strings.ToLower(args[0]) != strings.ToLower(pwsh) {
			t.Fatalf("pwsh 参数异常: %v", args)
		}
	} else if ids["pwsh"] {
		t.Fatalf("本机没有 pwsh，但列表包含 pwsh: %v", shells)
	}
	if bash := findGitBash(); bash != "" {
		if !ids["gitbash"] {
			t.Fatalf("本机有 Git Bash（%s）但列表未包含 gitbash", bash)
		}
		args, err := termShellArgs("gitbash")
		if err != nil {
			t.Fatalf("gitbash 参数生成失败: %v", err)
		}
		if !strings.Contains(strings.ToLower(args[0]), "bash.exe") || len(args) < 3 {
			t.Fatalf("gitbash 参数异常: %v", args)
		}
	}
}

// —— AI 读输出用的滚动缓冲 ——

func TestTermBufferKeepsTailOnly(t *testing.T) {
	s := &termSession{id: "t-buf"}
	chunk := strings.Repeat("x", 1024)
	for i := 0; i < (termBufferBytes/len(chunk))+8; i++ {
		s.append(chunk)
	}
	if len(s.buf) > termBufferBytes {
		t.Fatalf("缓冲超上限：%d > %d", len(s.buf), termBufferBytes)
	}
	s.append("TAIL-MARK")
	if !strings.HasSuffix(string(s.buf), "TAIL-MARK") {
		t.Fatal("最新输出必须留在缓冲尾部")
	}
	if s.seq <= int64(termBufferBytes) {
		t.Fatalf("seq 应累计全部写入字节，实际 %d", s.seq)
	}
}

func TestTermTailTruncatesOnRuneBoundary(t *testing.T) {
	s := &termSession{id: "t-tail"}
	s.append("前缀中文内容")
	// maxChars 落在一个中文字符中间时，必须从完整的 rune 起始处开始
	text, truncated := s.tail(4)
	if !truncated {
		t.Fatal("超长应标截断")
	}
	if !utf8.ValidString(text) {
		t.Fatalf("截断后必须是合法 UTF-8：%q", text)
	}
	// 按字节截断只保证「合法 UTF-8 + 是原文的尾部」，不保证整整两个汉字都在
	if len(text) > 4 || !strings.HasSuffix("前缀中文内容", text) || !strings.HasSuffix(text, "容") {
		t.Fatalf("应保留尾部若干完整字符，实际 %q", text)
	}
	full, cut := s.tail(0)
	if cut || full != "前缀中文内容" {
		t.Fatalf("maxChars=0 应返回全文且不标截断：%q cut=%v", full, cut)
	}
}

func TestTermReadUnknownSession(t *testing.T) {
	app := &Terminal{}
	if _, err := app.TermRead("term-not-exist", 100); err == nil {
		t.Fatal("未知会话应报错")
	}
}

func TestTermReadAndListAfterExit(t *testing.T) {
	app := &Terminal{}
	session := &termSession{id: "t-fake-exit", shell: "cmd", cwd: `C:\`}
	session.append("line-1\r\nline-2\r\n")
	terminals.mu.Lock()
	terminals.sessions[session.id] = session
	terminals.order = append(terminals.order, session.id)
	terminals.mu.Unlock()
	defer func() {
		terminals.mu.Lock()
		delete(terminals.sessions, session.id)
		for i, id := range terminals.order {
			if id == session.id {
				terminals.order = append(terminals.order[:i], terminals.order[i+1:]...)
				break
			}
		}
		terminals.mu.Unlock()
	}()

	// 未退出：exited=false
	res, err := app.TermRead(session.id, 0)
	if err != nil {
		t.Fatalf("TermRead: %v", err)
	}
	if res.Exited || !strings.Contains(res.Text, "line-2") {
		t.Fatalf("未退出会话的读数异常：%+v", res)
	}

	// 标记退出后仍可读（AI 要拿到最后的输出），exited=true 且带退出码
	session.bufMu.Lock()
	session.exited = true
	session.exitCode = 7
	session.bufMu.Unlock()
	res, err = app.TermRead(session.id, 0)
	if err != nil {
		t.Fatalf("退出后 TermRead: %v", err)
	}
	if !res.Exited || res.ExitCode != 7 {
		t.Fatalf("退出状态未反映：%+v", res)
	}

	list := app.TermList()
	found := false
	for _, info := range list {
		if info.ID != session.id {
			continue
		}
		found = true
		if !info.Exited || info.ExitCode != 7 || info.Last != "line-2" {
			t.Fatalf("TermList 条目异常：%+v", info)
		}
	}
	if !found {
		t.Fatalf("TermList 应包含已退出会话：%+v", list)
	}
}

func TestLastTermLine(t *testing.T) {
	if got := lastTermLine("a\r\nb\r\n\r\n"); got != "b" {
		t.Fatalf("应取最后一行非空输出，实际 %q", got)
	}
	if got := lastTermLine(""); got != "" {
		t.Fatalf("空输入应为空，实际 %q", got)
	}
	long := strings.Repeat("y", 500)
	if got := lastTermLine(long); len(got) != 160 {
		t.Fatalf("超长行应截到 160，实际 %d", len(got))
	}
}

// stubPty 只用来数 Close 次数：go-pty 的 Close 不幂等
//（每次都 ClosePseudoConsole + 关两条管道），所以释放次数必须钉成 1。
type stubPty struct{ closes int }

func (s *stubPty) Read([]byte) (int, error)           { return 0, io.EOF }
func (s *stubPty) Write(b []byte) (int, error)        { return len(b), nil }
func (s *stubPty) Close() error                       { s.closes++; return nil }
func (s *stubPty) Name() string                       { return "stub-pty" }
func (s *stubPty) Resize(int, int) error              { return nil }
func (s *stubPty) Fd() uintptr                        { return 0 }
func (s *stubPty) Command(string, ...string) *pty.Cmd { return &pty.Cmd{} }
func (s *stubPty) CommandContext(context.Context, string, ...string) *pty.Cmd {
	return &pty.Cmd{}
}

// TestTermReleasePtyOnlyOnce 覆盖「进程退出 + 用户关闭」两条路径叠在一起时，
// ConPTY 句柄只被释放一次。二次 ClosePseudoConsole 与二次 Process.Wait 是同一类毛病：
// 原始句柄被重复归还，之后谁拿到这个号谁踩空。
func TestTermReleasePtyOnlyOnce(t *testing.T) {
	stub := &stubPty{}
	cancels := 0
	session := &termSession{id: "t-release-once", p: stub, cancel: func() { cancels++ }}

	session.finish(3)
	session.closeAll()

	if stub.closes != 1 {
		t.Fatalf("ConPTY 被释放 %d 次，应为 1 次", stub.closes)
	}
	if cancels == 0 {
		t.Fatal("释放前必须 cancel 叫醒阻塞在 Read 上的读取 goroutine")
	}
	session.bufMu.Lock()
	exited, code := session.exited, session.exitCode
	session.bufMu.Unlock()
	if !exited || code != 3 {
		t.Fatalf("finish 的退出状态丢了：exited=%v code=%d", exited, code)
	}
}

// TestTermExitCodeAfterRealProcessExit 走真实进程退出链路：
// cmd.Wait() 收进程 → 退出码取自 ProcessState（不再二次 Process.Wait）→
// 之后再 terminate/closeAll（不能碰已回收的进程句柄）。
// 这条链在修好之前会把 go test 的进程搞崩，崩点却落在无关的目录监视用例上。
func TestTermExitCodeAfterRealProcessExit(t *testing.T) {
	var mu sync.Mutex
	var out strings.Builder
	emit := func(event string, data interface{}) {
		if event != "term-out" {
			return
		}
		m, ok := data.(map[string]string)
		if !ok {
			return
		}
		mu.Lock()
		out.WriteString(m["data"])
		mu.Unlock()
	}
	session, err := startTermSession("t-exit-7", "cmd", 80, 24, "", emit)
	if err != nil {
		t.Fatalf("创建会话失败：%v", err)
	}
	defer session.closeAll()

	// 等提示符出来再下命令，否则首行可能被吞
	ready := time.Now().Add(8 * time.Second)
	for time.Now().Before(ready) {
		mu.Lock()
		text := out.String()
		mu.Unlock()
		if strings.Contains(text, ">") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := session.write("exit 7\r"); err != nil {
		t.Fatalf("写入退出命令失败：%v", err)
	}

	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		session.bufMu.Lock()
		exited, code := session.exited, session.exitCode
		session.bufMu.Unlock()
		if exited {
			if code != 7 {
				t.Fatalf("退出码应为 7，实际 %d", code)
			}
			session.terminate() // 已退出的会话不得再 Kill
			session.closeAll()
			if session.p == nil {
				t.Fatal("closeAll 不应把 pty 引用清空")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("等待进程退出超时")
}

// ---- RunningSessionCount 的空闲判定：shell 有活后代才算「正在运行」 ----

func TestDescendantExists(t *testing.T) {
	// 表驱动：self=100。纯函数喂构造数据，锁竞态与真实快照解耦。
	cases := []struct {
		name  string
		procs []procInfo
		want  bool
	}{
		{"无子进程（空闲提示符）", []procInfo{{pid: 100, ppid: 1}}, false},
		{"直接子进程", []procInfo{{pid: 100, ppid: 1}, {pid: 200, ppid: 100}}, true},
		{"多级后代", []procInfo{{pid: 100, ppid: 1}, {pid: 200, ppid: 100}, {pid: 300, ppid: 200}}, true},
		{"兄弟分支无关", []procInfo{{pid: 100, ppid: 1}, {pid: 200, ppid: 1}, {pid: 300, ppid: 200}}, false},
		{"父 PID 环不自爆", []procInfo{{pid: 100, ppid: 300}, {pid: 200, ppid: 100}, {pid: 300, ppid: 200}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := descendantExists(100, tc.procs); got != tc.want {
				t.Fatalf("descendantExists(100) = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestHasAliveDescendantRealProcess(t *testing.T) {
	// 真实快照链路：起一个 cmd 包 ping 的进程树，轮询断言有/无后代两个方向。
	// 进程生命周期本测试内闭环、超时有界（各 3s），不依赖 ConPTY。
	cmd := exec.Command("cmd", "/c", "ping", "-n", "5", "127.0.0.1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("启动测试进程失败: %v", err)
	}
	pid := uint32(cmd.Process.Pid)

	alive := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if hasAliveDescendant(pid) {
			alive = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !alive {
		t.Fatal("shell 挂着运行中的子命令时应判定有活后代")
	}

	// 杀整棵树：Process.Kill 只杀 cmd、ping 会孤儿化（ppid 仍指向已死的 cmd），
	// 快照里孤儿仍是「后代」——产品语义正是如此（宁多拦不误杀），测试要用 /T 清干净。
	kill := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = kill.Run()
	_, _ = cmd.Process.Wait()

	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !hasAliveDescendant(pid) {
			return // 后代已清空：空闲判定成立
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("进程树结束后应判定无活后代")
}

func TestUtf8IncompleteTail(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"空串", "", 0},
		{"纯 ASCII", "abc 123", 0},
		{"完整 3 字节字符", "ab\xe4\xb8\xad", 0},
		{"块尾恰好对齐完整字符", "\xe4\xb8\xad", 0},
		{"3 字节截断剩 2", "ab\xe4\xb8", 2},
		{"3 字节截断剩 1", "ab\xe4", 1},
		{"4 字节完整表情", "\xf0\x9f\x98\x80", 0},
		{"4 字节截断剩 3", "\xf0\x9f\x98", 3},
		{"4 字节截断剩 2", "\xf0\x9f", 2},
		{"2 字节截断剩 1", "a\xc3", 1},
		{"非法首字节", "\xff", 0},
		{"纯续字节尾巴", "\x80\x80", 0},
		{"中文跨块场景", "路径 D:/data\xe4\xb8", 2},
	}
	for _, c := range cases {
		if got := utf8IncompleteTail([]byte(c.in)); got != c.want {
			t.Errorf("%s: utf8IncompleteTail(%q) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}
