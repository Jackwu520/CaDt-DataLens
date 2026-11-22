// stream.go：命令输出的逐行流式读取——平台无关，故意不放在 *_windows.go 里。
//
// 放在平台无关文件有两个理由：① 纯逻辑（bufio / io），没有 Win32 依赖；
// ② desktopmcp_test.go 要直接测 splitAnyLine，而测试文件没有 build tag——
// 定义留在 _windows.go 里会让 linux/darwin 的 go vet 编译失败（交叉编译守卫实测）。

package desktopmcp

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

// runStreaming 启动命令并逐行回调输出；失败时把尾部几行拼进错误（下载日志很长，
// 用户只需要最后一句）。
func runStreaming(cmd *exec.Cmd, onLine func(string)) error {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	var mu sync.Mutex
	tail := make([]string, 0, 8)
	handle := func(line string) {
		if line == "" {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		tail = append(tail, line)
		if len(tail) > 8 {
			tail = tail[len(tail)-8:]
		}
		// 回调也在锁内：stdout / stderr 两条扫描 goroutine 都会调到这里，消费者
		// （安装进度里的 last / percent 计数）本身没有锁，在锁外调用就是 data race
		// ——实测会让节流时间互相干扰、percent 丢更新（2026-11-23 审查 M1）。
		if onLine != nil {
			onLine(line)
		}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); scanAnyLines(stdout, handle) }()
	go func() { defer wg.Done(); scanAnyLines(stderr, handle) }()
	wg.Wait()
	waitErr := cmd.Wait()
	if waitErr == nil {
		return nil
	}
	mu.Lock()
	summary := strings.Join(tail, " / ")
	mu.Unlock()
	if summary != "" {
		return fmt.Errorf("%v：%s", waitErr, summary)
	}
	return waitErr
}

func scanAnyLines(r io.Reader, handle func(string)) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	scanner.Split(splitAnyLine)
	for scanner.Scan() {
		handle(strings.TrimSpace(scanner.Text()))
	}
}

// splitAnyLine 按 \r / \n / \r\n 切分：uv 的下载进度会用 \r 回写同一行。
func splitAnyLine(data []byte, atEOF bool) (advance int, token []byte, err error) {
	for i := 0; i < len(data); i++ {
		switch data[i] {
		case '\n':
			return i + 1, data[:i], nil
		case '\r':
			if i+1 < len(data) {
				if data[i+1] == '\n' {
					return i + 2, data[:i], nil
				}
				return i + 1, data[:i], nil
			}
			if !atEOF {
				return 0, nil, nil // 等下一个字节确认是不是 \r\n
			}
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}
