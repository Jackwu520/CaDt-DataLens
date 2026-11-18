//go:build windows

package cmdbridge

import (
	"strings"
	"sync"
	"testing"
	"time"

	"datalens/internal/shellpath"
)

func TestAIShellPriority(t *testing.T) {
	shell, exe, args, err := aiShellInvocation("echo hi", "", false)
	if err != nil {
		t.Fatalf("自动选择不应报错: %v", err)
	}
	switch {
	case shellpath.FindGitBash() != "":
		if shell != "Git Bash" || !strings.Contains(strings.ToLower(exe), "bash") {
			t.Fatalf("应优先 Git Bash，实际 %s (%s)", shell, exe)
		}
		if len(args) < 3 || args[len(args)-1] != "echo hi" {
			t.Fatalf("Git Bash 参数异常: %v", args)
		}
	case shellpath.FindPwsh() != "":
		if shell != "PowerShell 7" || !strings.Contains(strings.ToLower(exe), "pwsh") {
			t.Fatalf("无 Git Bash 时应优先 pwsh，实际 %s (%s)", shell, exe)
		}
	default:
		if !strings.Contains(shell, "PowerShell") && !strings.Contains(shell, "Command Prompt") {
			t.Fatalf("未找到预期 shell: %s", shell)
		}
	}
}

// 显式 shell 优先于自动优先级；不可用的 shell 必须报错——静默回退会让人以为命令
// 跑在别的语言环境里（「在 Git Bash 里写 powershell -Command」那类坑就是这么来的）。
func TestAIShellExplicitSelection(t *testing.T) {
	if shellpath.FindPwsh() != "" {
		name, exe, args, err := aiShellInvocation("Get-Date", "pwsh", false)
		if err != nil {
			t.Fatalf("显式 pwsh 应成功: %v", err)
		}
		if name != "PowerShell 7" || !strings.Contains(strings.ToLower(exe), "pwsh") {
			t.Fatalf("显式 pwsh 选错 shell: %s (%s)", name, exe)
		}
		if len(args) < 2 || args[len(args)-2] != "-Command" {
			t.Fatalf("PowerShell 参数异常: %v", args)
		}
		if shellpath.FindGitBash() != "" {
			// 本机同时有 Git Bash：显式指定必须压过它，否则等于没指定
			shell, bashExe, _, _ := aiShellInvocation("echo hi", "", false)
			if shell != "Git Bash" {
				t.Fatalf("前提不成立：自动档应优先 Git Bash，实际 %s (%s)", shell, bashExe)
			}
		}
	} else {
		if _, _, _, err := aiShellInvocation("Get-Date", "pwsh", false); err == nil {
			t.Fatal("本机没有 pwsh 时应报错，而不是回退到别的 shell")
		}
	}

	if _, _, _, err := aiShellInvocation("echo hi", "zsh", false); err == nil {
		t.Fatal("未知 shell 应被拒绝")
	}
	if shellpath.FindGitBash() != "" {
		name, _, _, err := aiShellInvocation("echo hi", "gitbash", false)
		if err != nil || name != "Git Bash" {
			t.Fatalf("显式 gitbash 应成功: %s err=%v", name, err)
		}
	}
	// 沙箱档永不允许 Git Bash（受限令牌下 Cygwin 起不来）：显式请求也只能报错，
	// 不允许悄悄换一个 shell 继续跑。
	if _, _, _, err := aiShellInvocation("echo hi", "gitbash", true); err == nil {
		t.Fatal("沙箱档请求 Git Bash 应报错")
	}
	if _, _, _, err := aiShellInvocation("echo hi", "cmd", true); err != nil {
		t.Fatalf("沙箱档 cmd 应可用: %v", err)
	}
}

// 回归用例（Clipboard_Screenshot 那个现场）：显式 PowerShell 时命令里的 `$c` / `$_`
// 必须原样到达 PowerShell。走默认的 Git Bash 档时 `$c` 会被 bash 先展开成空串，
// PowerShell 只会收到残缺脚本——这就是要 shell 参数的原因。
func TestAIRunShellCommandExplicitShellKeepsDollar(t *testing.T) {
	if shellpath.FindPwsh() == "" && findExe("powershell.exe") == "" {
		t.Skip("本机没有 PowerShell")
	}
	shell := "pwsh"
	if shellpath.FindPwsh() == "" {
		shell = "powershell"
	}
	app := &Bridge{}
	// 多行 + 双引号字符串 + $变量：三者同时覆盖「argv 单参数传递」是否会被二次转义破坏
	script := "$c = 41\nWrite-Output ('DOLLAR_OK_' + ($c + 1))\nWrite-Output \"QUOTE_OK\""
	res, err := app.AIRunShellCommand(script, "", 30000, "", shell)
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if res.Code != 0 || !strings.Contains(res.Stdout, "DOLLAR_OK_42") || !strings.Contains(res.Stdout, "QUOTE_OK") {
		t.Fatalf("脚本未原样送达（被外层 shell 展开或引号被破坏？）code=%d stdout=%q stderr=%q", res.Code, res.Stdout, res.Stderr)
	}
	if strings.Contains(strings.ToLower(res.Exe), "bash") {
		t.Fatalf("显式 %s 却走了 Git Bash: %s", shell, res.Exe)
	}
}

func TestAIRunShellCommandEcho(t *testing.T) {
	app := &Bridge{}
	res, err := app.AIRunShellCommand("echo CADT_AI_CMD_OK_9137", "", 20000, "", "")
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if res.Code != 0 {
		t.Fatalf("退出码 %d, stderr=%q", res.Code, res.Stderr)
	}
	if !strings.Contains(res.Stdout, "CADT_AI_CMD_OK_9137") {
		t.Fatalf("stdout 未包含预期内容: %q", res.Stdout)
	}
	if res.Shell == "" || res.Exe == "" {
		t.Fatalf("缺少 shell 信息: %+v", res)
	}
}

func TestAIRunShellCommandValidation(t *testing.T) {
	app := &Bridge{}
	if _, err := app.AIRunShellCommand("   ", "", 0, "", ""); err == nil {
		t.Fatal("空命令应被拒绝")
	}
	if _, err := app.AIRunShellCommand("echo hi", `C:\__cadt_missing_dir__`, 0, "", ""); err == nil {
		t.Fatal("不存在的 cwd 应被拒绝")
	}
}

// runId 注册与停止：占位 runId 注册后能被 AIStopShellRun 杀掉，返回「已被用户停止」。
func TestAIRunShellCommandStopByRunID(t *testing.T) {
	app := &Bridge{}
	done := make(chan error, 1)
	go func() {
		_, err := app.AIRunShellCommand("ping -n 30 127.0.0.1", "", 60000, "test-run-stop-1", "")
		done <- err
	}()
	time.Sleep(300 * time.Millisecond)
	app.AIStopShellRun("test-run-stop-1")
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "已被用户停止") {
			t.Fatalf("停止后应返回「已被用户停止」错误，实际: %v", err)
		}
	case <-time.After(5000 * time.Millisecond):
		t.Fatal("停止后命令应在 5 秒内返回")
	}
	// 重复停止：静默成功
	app.AIStopShellRun("test-run-stop-1")
}

func TestAICommandStartStatusStop(t *testing.T) {
	app := &Bridge{}
	started, err := app.AICommandStart("echo CADT_BG_OK_6211", "", "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if started.JobId == "" || started.Shell == "" {
		t.Fatalf("缺少 jobId/shell: %+v", started)
	}
	deadline := time.Now().Add(15 * time.Second)
	var final *AICommandJobStatus
	for {
		st, err := app.AICommandStatus(started.JobId, 0)
		if err != nil {
			t.Fatalf("查询失败: %v", err)
		}
		if st.State == "exited" {
			final = st
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("作业未在期限内退出: %+v", st)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if final.Code != 0 {
		t.Fatalf("退出码应为 0: %+v", final)
	}
	if !strings.Contains(final.Output, "CADT_BG_OK_6211") {
		t.Fatalf("输出未包含预期内容: %q", final.Output)
	}
	if final.Cursor == 0 {
		t.Fatal("游标应已前进")
	}
	// 已退出作业继续查询：无新增输出、状态保持 exited
	again, err := app.AICommandStatus(started.JobId, final.Cursor)
	if err != nil || again.State != "exited" || again.Output != "" {
		t.Fatalf("结束后重复查询异常: %+v err=%v", again, err)
	}
}

func TestAICommandStopRunning(t *testing.T) {
	shell, _, _, _ := aiShellInvocation("", "", false)
	if shell != "Git Bash" {
		t.Skipf("停止用例依赖 Git Bash（read -t 无子进程、可被干净终止），当前 shell: %s", shell)
	}
	app := &Bridge{}
	// 纯 bash 内建循环阻塞（无长命子进程，stdin EOF 也不影响），确保停止时仍在运行
	started, err := app.AICommandStart("echo bg-started; for ((i=0;i<300;i++)); do sleep 0.1; done", "", "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	st, err := app.AICommandStop(started.JobId)
	if err != nil {
		t.Fatalf("停止失败: %v", err)
	}
	if st.State != "exited" {
		t.Fatalf("停止后作业应已退出: %+v", st)
	}
	if st.Code != -1 {
		t.Fatalf("被终止的作业退出码应为 -1，实际 %d", st.Code)
	}
}

func TestAICommandStartValidation(t *testing.T) {
	app := &Bridge{}
	if _, err := app.AICommandStart("   ", "", ""); err == nil {
		t.Fatal("空命令应被拒绝")
	}
	if _, err := app.AICommandStart("echo hi", `C:\__cadt_missing_dir__`, ""); err == nil {
		t.Fatal("不存在的 cwd 应被拒绝")
	}
	if _, err := app.AICommandStatus("", 0); err == nil {
		t.Fatal("空 jobId 查询应被拒绝")
	}
	if _, err := app.AICommandStop(""); err == nil {
		t.Fatal("空 jobId 停止应被拒绝")
	}
}

// cmd-out 事件载荷形状护栏（2026-11-17）：map 复合字面量的键是表达式，裸写 id:/stream:/data:
// 会把「变量值」当键名（实际发出 {"bg-1":"bg-1",...}），前端 EventsOn 按 payload.id 分发
// 永远落空——后台终端标签页与插件命令的实时输出自 11-14 起从未工作过。这里锁死载荷形状。
func TestAICommandStartEmitsEventPayload(t *testing.T) {
	app := &Bridge{}
	type bridgeEvent struct {
		name string
		data map[string]string
	}
	var (
		mu     sync.Mutex
		events []bridgeEvent
	)
	prev := Emit
	Emit = func(name string, data any) {
		m, ok := data.(map[string]string)
		if !ok {
			t.Errorf("事件 %s 载荷应为 map[string]string，实际 %T", name, data)
			return
		}
		mu.Lock()
		events = append(events, bridgeEvent{name, m})
		mu.Unlock()
	}
	defer func() { Emit = prev }()

	started, err := app.AICommandStart("echo CADT_BG_EVT_7701", "", "")
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	hasExit := false
	for !hasExit {
		mu.Lock()
		for _, ev := range events {
			if ev.name == "cmd-exit" && ev.data["id"] == started.JobId {
				hasExit = true
			}
		}
		mu.Unlock()
		if hasExit {
			break
		}
		if time.Now().After(deadline) {
			mu.Lock()
			total := len(events)
			mu.Unlock()
			t.Fatalf("15 秒内未收到 cmd-exit（已收 %d 个事件）", total)
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(events) == 0 {
		t.Fatal("未捕获到任何事件")
	}
	outCount := 0
	joined := ""
	for _, ev := range events {
		if ev.data["id"] != started.JobId {
			t.Fatalf("事件 %s 的 id 字段缺失或错误: %#v", ev.name, ev.data)
		}
		if ev.name != "cmd-out" {
			continue
		}
		outCount++
		if ev.data["stream"] == "" || ev.data["data"] == "" {
			t.Fatalf("cmd-out 载荷缺少 stream/data 字段: %#v", ev.data)
		}
		if ev.data["stream"] == "out" {
			joined += ev.data["data"] + "\n"
		}
	}
	if outCount == 0 {
		t.Fatalf("echo 应产生至少一条 cmd-out，实际 0 条（共 %d 个事件）", len(events))
	}
	if !strings.Contains(joined, "CADT_BG_EVT_7701") {
		t.Fatalf("cmd-out 数据未包含预期输出: %q", joined)
	}
}
