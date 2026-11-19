// windowreg/sweep.go：注册表残留清理与窗口存活判定。
package windowreg

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/resourcelease"
)

// alive 判定窗口进程是否还活着：只看租约，不做 pid 探测（pid 会复用）。
// Probe 三态里只有「被占」算活；IO 错拿不准，按不活处理（投递失败会退化开新窗，安全）。
func alive(root, windowID string) bool {
	if windowID == "" || strings.ContainsAny(windowID, "\\/.") {
		return false
	}
	_, occupied, err := resourcelease.Probe(leasePath(root, windowID))
	return err == nil && occupied
}

func leasePath(root, windowID string) string {
	return filepath.Join(root, windowID+".lease")
}

// Sweep 清理残留：删「目录存在 + 租约无人持有」的窗口目录及其配对 lease；
// **不删孤儿 lease**（有锁文件无目录 = 可能正在注册中的窗口，误删会让该窗口
// 存活判定永久失效），仅对超过 orphanLeaseMaxAge 的孤儿做兜底清理。
// 多窗口并发 Sweep 的删除 race 由 os.Remove/RemoveAll 失败即忽略吸收。
func Sweep(root string) (removed int, err error) {
	entries, readErr := os.ReadDir(root)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return 0, nil
		}
		return 0, fmt.Errorf("窗口注册表根目录读取失败: %w", readErr)
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".owner") {
			continue // resourcelease 的 owner 提示文件，跟 lease 一对，随 lease 处理
		}
		if strings.HasSuffix(name, ".lease") {
			windowID := strings.TrimSuffix(name, ".lease")
			if _, statErr := os.Stat(filepath.Join(root, windowID)); statErr == nil {
				continue // 目录还在：活窗口或残留目录，交给目录分支处理
			}
			// 孤儿 lease：新的不动，老的兜底清。
			if info, infoErr := e.Info(); infoErr == nil && time.Since(info.ModTime()) > orphanLeaseMaxAge {
				_ = os.Remove(filepath.Join(root, name))
				_ = os.Remove(filepath.Join(root, name+".owner"))
			}
			continue
		}
		if !e.IsDir() {
			continue // 非窗口目录形态（atomfile 残留 temp 等）不动，避免误删正在写的文件
		}
		if _, occupied, probeErr := resourcelease.Probe(leasePath(root, name)); probeErr == nil && !occupied {
			// 并发 Sweep 的删除 race 由忽略错误吸收；计数只算真删掉的。
			if os.RemoveAll(filepath.Join(root, name)) == nil {
				_ = os.Remove(leasePath(root, name))
				_ = os.Remove(leasePath(root, name) + ".owner")
				removed++
			}
		}
	}
	return removed, nil
}
