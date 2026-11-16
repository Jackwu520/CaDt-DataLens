package debugconsole

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"datalens/internal/appdata"
)

// 独立调试控制台窗口：
// 主窗口把调试日志批量追加到 appdata 下的 debug-console.jsonl，
// 独立窗口（另一进程，带 --debug-console 启动）轮询读取该文件实现实时同步。
// 两个窗口互不阻塞，独立窗口关闭不影响主窗口。

const (
	debugConsoleLogName = "debug-console.jsonl"
	debugConsoleMaxSize = 4 << 20 // 超过后裁剪，保留尾部 1MB
	debugConsoleKeep    = 1 << 20
	debugConsoleTail    = 256 << 10 // 独立窗口首次读取的历史长度
	debugConsoleMaxRead = 1 << 20   // 单次读取上限
)

var debugConsoleMu sync.Mutex

// Console 调试控制台日志存储。
type Console struct{}

// DebugConsoleEntry 一条控制台日志（字段名短，减小文件体积）。
type DebugConsoleEntry struct {
	Time    string `json:"t"`
	Level   string `json:"lv"`
	Message string `json:"msg"`
}

// DebugConsoleChunk 增量读取结果：Offset 是下次读取位置，Data 只包含完整行。
type DebugConsoleChunk struct {
	Offset int64  `json:"offset"`
	Data   string `json:"data"`
}

func Path() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, debugConsoleLogName)
}

func HasArg(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}

// DebugConsoleAppend 追加一批日志（主窗口调用，失败不影响业务）。
func (c *Console) DebugConsoleAppend(entries []DebugConsoleEntry) error {
	if len(entries) == 0 {
		return nil
	}
	path := Path()
	if path == "" {
		return errors.New("找不到应用数据目录")
	}
	debugConsoleMu.Lock()
	defer debugConsoleMu.Unlock()
	if fi, err := os.Stat(path); err == nil && fi.Size() > debugConsoleMaxSize {
		trimDebugConsoleLog(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for _, e := range entries {
		if e.Time == "" || e.Level == "" {
			continue
		}
		if len(e.Message) > 16000 {
			e.Message = e.Message[:16000] + "…"
		}
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

// DebugConsoleRead 从 offset 处增量读取；offset < 0 表示从尾部历史开始。
func (c *Console) DebugConsoleRead(offset int64) (DebugConsoleChunk, error) {
	path := Path()
	if path == "" {
		return DebugConsoleChunk{Offset: 0}, nil
	}
	debugConsoleMu.Lock()
	defer debugConsoleMu.Unlock()
	f, err := os.Open(path)
	if err != nil {
		return DebugConsoleChunk{Offset: 0}, nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return DebugConsoleChunk{Offset: 0}, nil
	}
	size := fi.Size()
	alignHead := false
	if offset < 0 {
		offset = size - debugConsoleTail
		if offset < 0 {
			offset = 0
		}
		alignHead = offset > 0
	}
	if offset > size { // 文件被裁剪或重建
		offset = 0
		alignHead = false
	}
	if offset == size {
		return DebugConsoleChunk{Offset: offset}, nil
	}
	n := size - offset
	if n > debugConsoleMaxRead {
		n = debugConsoleMaxRead
	}
	buf := make([]byte, n)
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return DebugConsoleChunk{Offset: offset}, nil
	}
	read, _ := io.ReadFull(f, buf)
	data := string(buf[:read])
	consumed := 0
	if alignHead {
		idx := strings.IndexByte(data, '\n')
		if idx < 0 {
			// 罕见：整块没有换行，丢弃这半行继续等新数据
			return DebugConsoleChunk{Offset: offset + int64(len(data))}, nil
		}
		consumed = idx + 1
	}
	rest := data[consumed:]
	// 只返回完整行，半行留给下一次
	if idx := strings.LastIndexByte(rest, '\n'); idx >= 0 {
		rest = rest[:idx+1]
	} else {
		rest = ""
	}
	return DebugConsoleChunk{Offset: offset + int64(consumed) + int64(len(rest)), Data: rest}, nil
}

// trimDebugConsoleLog 裁剪日志：保留尾部约 1MB，并对齐到行首。
func trimDebugConsoleLog(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return
	}
	start := fi.Size() - debugConsoleKeep
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return
	}
	data := string(buf)
	if start > 0 {
		if idx := strings.IndexByte(data, '\n'); idx >= 0 {
			data = data[idx+1:]
		}
	}
	_ = os.WriteFile(path, []byte(data), 0o644)
}
