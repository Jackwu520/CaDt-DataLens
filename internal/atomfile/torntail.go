package atomfile

import "os"

// RepairTornTail 把不以换行结尾的尾部残行截掉，返回可安全追加的字节长度。
// 追加式日志（会话 / 操作留痕 / 工作日志）在崩溃或断电后可能留下半行，
// 下次追加前先切齐到最后一个换行符，避免把两条记录粘成一条坏行。
// 从尾部倒着按 32 KiB 块扫描，通常第一块就命中，代价与文件大小无关。
func RepairTornTail(f *os.File) (int64, error) {
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	size := info.Size()
	if size == 0 {
		return 0, nil
	}
	buf := make([]byte, 32*1024)
	offset := size
	for offset > 0 {
		n := int64(len(buf))
		if offset < n {
			n = offset
		}
		offset -= n
		if _, err := f.ReadAt(buf[:n], offset); err != nil {
			return 0, err
		}
		for i := n - 1; i >= 0; i-- {
			if buf[i] == '\n' {
				keep := offset + i + 1
				if keep == size {
					return size, nil
				}
				return keep, f.Truncate(keep)
			}
		}
	}
	return 0, f.Truncate(0)
}
