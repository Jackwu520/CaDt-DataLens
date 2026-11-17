//go:build windows

// sandbox-poc：验证「受限令牌（WRITE_RESTRICTED + Low 完整性）子进程」能否从
// 无控制台的 GUI 宿主里启动。不参与产品构建，只回答一个二选一的事实问题：
//
//	dsh 的 windows-acl 沙箱记录了「CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 的
//	子进程在受限令牌下死于 STATUS_DLL_INIT_FAILED (0xC0000142)，只能共享宿主
//	控制台」。dsh 自己是 CLI（有控制台），本项目是 Wails GUI（无控制台，且
//	executil.HideCommandWindow 正是 0x08000000 = CREATE_NO_WINDOW）。
//
// 若没有任何创建标志组合能在 GUI 宿主上跑通，方案 C 在 Windows 上不成立。
//
// 用法：go build -ldflags "-H windowsgui" -o sandbox-poc.exe ./tools/sandbox-poc
//
//	sandbox-poc.exe [日志路径]
//
// 注意：以「不设创建标志」和 CREATE_NEW_CONSOLE 运行的变体会在屏幕上闪出
// 控制台窗口——那正是被测现象本身。
package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"datalens/internal/shellpath"
)

var (
	procCreateRestrictedToken = windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
	procSetEntriesInAclW      = windows.NewLazySystemDLL("advapi32.dll").NewProc("SetEntriesInAclW")
)

const (
	// CreateRestrictedToken 标志
	disableMaxPrivilege = 0x00000001
	writeRestricted     = 0x00000008

	// OpenProcessToken 访问权
	tokenAssignPrimary = 0x0001
	tokenDuplicate     = 0x0002
	tokenQuery         = 0x0008
	tokenAdjustDefault = 0x0080

	// CreateProcess 创建标志
	createNoWindow   = 0x08000000
	createNewConsole = 0x00000010
	detachedProcess  = 0x00000008
)

// tokenMandatoryLabel 是 TOKEN_MANDATORY_LABEL（SID 为指针，x64 下 16 字节）。
type tokenMandatoryLabel struct {
	Label windows.SIDAndAttributes
}

type variant struct {
	name     string
	shell    string // "cmd" | "bash"
	tokenSel string // "" 无令牌 | "low" 受限+Low IL | "nolow" 受限不带 Low IL
	flags    uint32
	hideWin  bool
}

type result struct {
	variant   string
	started   bool // 输出里出现 POC-OK：进程真的跑起来了
	writeOK   bool // 输出里出现 probe：TEMP 写入成功
	git       string
	exitCode  int
	elapsedMs int64
	stdout    string
	stderr    string
	errText   string
}

func main() {
	logPath := filepath.Join(os.TempDir(), "cadt-sandbox-poc.log")
	if len(os.Args) > 1 {
		logPath = os.Args[1]
	}
	var lines []string
	lines = append(lines, "sandbox-poc  "+time.Now().Format("2006-01-02 15:04:05"))
	lines = append(lines, fmt.Sprintf("host: gui-subsystem pid=%d", os.Getpid()))

	low, lowErr := newRestrictedToken(true)
	nolow, nolowErr := newRestrictedToken(false)
	tokens := map[string]windows.Token{"low": low, "nolow": nolow}
	if lowErr != nil {
		lines = append(lines, "受限+Low 令牌创建失败："+lowErr.Error())
	}
	if nolowErr != nil {
		lines = append(lines, "受限无Low 令牌创建失败："+nolowErr.Error())
	}
	if lowErr == nil {
		defer windows.Token(low).Close()
	}
	if nolowErr == nil {
		defer windows.Token(nolow).Close()
	}
	lines = append(lines, "受限令牌就绪（WRITE_RESTRICTED + DISABLE_MAX_PRIVILEGE，restricting=[logon, Everyone]）")

	runPhase := func(title string, list []variant) {
		lines = append(lines, "--- "+title+" ---")
		for _, v := range list {
			tok := tokens[v.tokenSel]
			if v.tokenSel != "" && tok == 0 {
				continue
			}
			lines = append(lines, render(run(v, tok)))
		}
	}

	// 第一阶段：不需要宿主控制台的组合（DETACHED_PROCESS 让子进程完全不建控制台）。
	runPhase("阶段一：DETACHED_PROCESS（预期不闪窗）", []variant{
		{name: "cmd/无令牌(基线)", shell: "cmd"},
		{name: "cmd/受限+DETACHED", shell: "cmd", tokenSel: "low", flags: detachedProcess},
		{name: "bash/受限+DETACHED", shell: "bash", tokenSel: "low", flags: detachedProcess},
	})

	// 第二阶段：宿主先分配隐藏控制台，子进程继承（dsh 说的「共享宿主控制台」）。
	if err := allocHiddenConsole(); err != nil {
		lines = append(lines, "AllocConsole 失败："+err.Error())
		return
	}
	runPhase("阶段二：分配并隐藏宿主控制台后继承", []variant{
		{name: "cmd/受限/继承", shell: "cmd", tokenSel: "low"},
		{name: "bash/受限/继承", shell: "bash", tokenSel: "low"},
		{name: "bash/受限无Low/继承", shell: "bash", tokenSel: "nolow"},
		{name: "cmd/受限无Low/继承", shell: "cmd", tokenSel: "nolow"},
		{name: "bash/无令牌/继承", shell: "bash"},
	})
	if err := os.WriteFile(logPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		os.Exit(2)
	}
}

func render(r result) string {
	status := "OK  "
	switch {
	case r.errText != "" || r.exitCode != 0 && !r.started:
		status = "FAIL"
	case !r.writeOK:
		status = "OK* " // 起来了，但 TEMP 写入被拒（未授权根时的预期结果）
	}
	s := fmt.Sprintf("%s | %-28s | exit=%-12d %5dms | 启动=%-5v 写TEMP=%-5v", status, r.variant, r.exitCode, r.elapsedMs, r.started, r.writeOK)
	if r.git != "" {
		s += " | " + r.git
	}
	out := strings.TrimSpace(r.stdout)
	if len(out) > 100 {
		out = out[:100] + "…"
	}
	if out != "" {
		s += fmt.Sprintf(" | stdout=%q", out)
	}
	if e := strings.TrimSpace(r.stderr); e != "" {
		if len(e) > 120 {
			e = e[:120] + "…"
		}
		s += fmt.Sprintf(" | stderr=%q", e)
	}
	if r.errText != "" {
		s += fmt.Sprintf(" | err=%q", r.errText)
	}
	return s
}

func run(v variant, token windows.Token) result {
	// 每次探测用独立文件名：上一轮成功写入的文件会让 'type' 命中残留内容，把
	// 「写入被拒」误读成「写入成功」。
	probe := fmt.Sprintf("cadt-poc-%d.txt", time.Now().UnixNano())
	var cmd *exec.Cmd
	switch v.shell {
	case "bash":
		bash := shellpath.FindGitBash()
		if bash == "" {
			return result{variant: v.name, errText: "未找到 Git Bash", exitCode: -1}
		}
		// 同时验证：进程能起来 / TEMP 能不能写 / 孙进程（git）能不能跑。
		script := fmt.Sprintf(`echo POC-OK; echo probe > "$TEMP/%s" && cat "$TEMP/%s"; git --version`, probe, probe)
		cmd = exec.Command(bash, "--login", "-c", script)
	default:
		script := fmt.Sprintf(`echo POC-OK&echo probe>%%TEMP%%\%s&type %%TEMP%%\%s&git --version`, probe, probe)
		cmd = exec.Command("cmd.exe", "/d", "/s", "/c", script)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	sys := &syscall.SysProcAttr{HideWindow: v.hideWin, CreationFlags: v.flags}
	if v.tokenSel != "" {
		sys.Token = syscall.Token(token)
	}
	cmd.SysProcAttr = sys
	started := time.Now()
	err := cmd.Run()
	res := result{
		variant:   v.name,
		elapsedMs: time.Since(started).Milliseconds(),
		stdout:    stdout.String(),
		stderr:    stderr.String(),
		exitCode:  -1,
	}
	if cmd.ProcessState != nil {
		res.exitCode = cmd.ProcessState.ExitCode()
	}
	if err != nil {
		res.errText = err.Error()
	}
	res.started = strings.Contains(res.stdout, "POC-OK")
	res.writeOK = strings.Contains(res.stdout, "probe")
	for _, line := range strings.Split(res.stdout, "\n") {
		if strings.Contains(line, "git version") {
			res.git = strings.TrimSpace(line)
		}
	}
	return res
}

// newRestrictedToken 复制当前进程令牌为 WRITE_RESTRICTED（可选再降到 Low 完整性）。
func newRestrictedToken(lowIL bool) (windows.Token, error) {
	var current windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		tokenQuery|tokenDuplicate|tokenAdjustDefault|tokenAssignPrimary, &current); err != nil {
		return 0, fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer current.Close()

	logonSID, buf, err := logonSIDOf(current)
	if err != nil {
		return 0, err
	}
	_ = buf // 令牌 SID 指向 buf，需保活到 CreateRestrictedToken 之后

	everyone, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		return 0, fmt.Errorf("CreateWellKnownSid(Everyone): %w", err)
	}
	sids := []windows.SIDAndAttributes{
		// 保活组：缺了它们，早期 DLL 初始化会以 0xC0000142 失败（dsh 实测）。
		{Sid: logonSID, Attributes: 0},
		{Sid: everyone, Attributes: 0},
	}
	var restricted windows.Token
	r, _, callErr := procCreateRestrictedToken.Call(
		uintptr(current),
		uintptr(disableMaxPrivilege|writeRestricted),
		0, 0,
		0, 0,
		uintptr(len(sids)), uintptr(unsafe.Pointer(&sids[0])),
		uintptr(unsafe.Pointer(&restricted)),
	)
	if r == 0 {
		return 0, fmt.Errorf("CreateRestrictedToken: %v", callErr)
	}

	low, err := windows.CreateWellKnownSid(windows.WinLowLabelSid)
	if err != nil {
		windows.Token(restricted).Close()
		return 0, fmt.Errorf("CreateWellKnownSid(Low): %w", err)
	}
	if lowIL {
		label := tokenMandatoryLabel{Label: windows.SIDAndAttributes{Sid: low, Attributes: windows.SE_GROUP_INTEGRITY}}
		if err := windows.SetTokenInformation(restricted, windows.TokenIntegrityLevel,
			(*byte)(unsafe.Pointer(&label)), uint32(unsafe.Sizeof(label))); err != nil {
			windows.Token(restricted).Close()
			return 0, fmt.Errorf("SetTokenInformation(TokenIntegrityLevel): %w", err)
		}
	}
	// 关键一步（对齐 dsh 的 setTokenDefaultDaclGrant）：受限令牌的默认 DACL 只
	// 列了用户的环境 SID，没有任何 restricting SID，于是新对象的 write 二次检查
	// 一律失败——Cygwin 的 cygheap 初始化就要改自己令牌的默认 DACL，所以 Git Bash
	// 会以 0xC0000022 直接死在启动阶段。给 restricting 列表里的 SID 加一条全权
	// ACE 才能让「新建对象」过关（对象创建本身仍受父容器 DACL 约束）。
	if err := grantTokenDefaultDacl(restricted, everyone); err != nil {
		windows.Token(restricted).Close()
		return 0, fmt.Errorf("默认 DACL 授权: %w", err)
	}
	return restricted, nil
}

// grantTokenDefaultDacl 往令牌默认 DACL 合并一条 Everyone 全权 ACE。
func grantTokenDefaultDacl(token windows.Token, sid *windows.SID) error {
	var needed uint32
	_ = windows.GetTokenInformation(token, windows.TokenDefaultDacl, nil, 0, &needed)
	if needed == 0 {
		return fmt.Errorf("TokenDefaultDacl 尺寸查询失败")
	}
	buf := make([]byte, needed)
	if err := windows.GetTokenInformation(token, windows.TokenDefaultDacl, &buf[0], needed, &needed); err != nil {
		return err
	}
	current := *(**windows.ACL)(unsafe.Pointer(&buf[0]))
	entry := windows.EXPLICIT_ACCESS{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{
			MultipleTrusteeOperation: windows.NO_MULTIPLE_TRUSTEE,
			TrusteeForm:              windows.TRUSTEE_IS_SID,
			TrusteeType:              windows.TRUSTEE_IS_UNKNOWN,
			TrusteeValue:             windows.TrusteeValueFromSID(sid),
		},
	}
	var merged *windows.ACL
	r, _, callErr := procSetEntriesInAclW.Call(
		1, uintptr(unsafe.Pointer(&entry)), uintptr(unsafe.Pointer(current)), uintptr(unsafe.Pointer(&merged)),
	)
	if r != 0 {
		return fmt.Errorf("SetEntriesInAclW: %v", callErr)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(merged)))
	info := struct {
		DefaultDacl *windows.ACL
	}{DefaultDacl: merged}
	return windows.SetTokenInformation(token, windows.TokenDefaultDacl,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
}

// logonSIDOf 取令牌的登录会话 SID（S-1-5-5-x-y，属性带 SE_GROUP_LOGON_ID）。
func logonSIDOf(token windows.Token) (*windows.SID, []byte, error) {
	var needed uint32
	_ = windows.GetTokenInformation(token, windows.TokenGroups, nil, 0, &needed)
	if needed == 0 {
		return nil, nil, fmt.Errorf("GetTokenInformation(TokenGroups): 尺寸查询失败")
	}
	buf := make([]byte, needed)
	if err := windows.GetTokenInformation(token, windows.TokenGroups, &buf[0], needed, &needed); err != nil {
		return nil, nil, fmt.Errorf("GetTokenInformation(TokenGroups): %w", err)
	}
	groups := (*windows.Tokengroups)(unsafe.Pointer(&buf[0]))
	list := unsafe.Slice(&groups.Groups[0], int(groups.GroupCount))
	for i := range list {
		if list[i].Sid == nil {
			continue
		}
		if uint32(list[i].Attributes)&uint32(windows.SE_GROUP_LOGON_ID) == uint32(windows.SE_GROUP_LOGON_ID) {
			return list[i].Sid, buf, nil
		}
	}
	return nil, nil, fmt.Errorf("令牌里没有登录会话 SID（TokenGroups 共 %d 项）", groups.GroupCount)
}

// allocHiddenConsole 给 GUI 进程分配一个控制台并立刻隐藏，供子进程继承。
// x/sys/windows 没有导出 AllocConsole，直接取 kernel32 过程。
func allocHiddenConsole() error {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	alloc, _, allocErr := kernel32.NewProc("AllocConsole").Call()
	if alloc == 0 {
		return fmt.Errorf("AllocConsole: %v", allocErr)
	}
	if hwnd, _, _ := kernel32.NewProc("GetConsoleWindow").Call(); hwnd != 0 {
		windows.NewLazySystemDLL("user32.dll").NewProc("ShowWindow").Call(hwnd, 0 /* SW_HIDE */)
	}
	return nil
}
