package atomfile

import "os"

// RepairTornTail 把不以换行结尾的尾部残行截掉，返回可安全追加的字节长度。
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
