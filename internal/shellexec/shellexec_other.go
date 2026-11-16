//go:build !windows

package shellexec

import "errors"

// Open 非 Windows 平台没有「默认关联程序」概念，保持接口一致但直接报错。
func Open(path string) error {
	return errors.New("当前平台不支持用默认应用打开")
}
