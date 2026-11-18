//go:build windows

// acl_windows.go：备份根的 deny-delete ACL（方案 §4.4）。
//
// 威胁模型是「同用户任意子进程」：硬拒只约束读类工具，run_command 起的进程可以
// rm -rf 任何目录——事故已证明规则层看不见子进程。所以备份根必须让 unlink 直接失败。
//
// 实现走系统自带的 icacls（单 exe 零依赖的「系统提供引擎」惯例，免手写 Win32 ACL）：
//   - 套保护：拒绝 Everyone 的 DELETE（继承到子对象）与 DELETE_CHILD（目录本身）；
//     Owner 保留 WRITE_DAC，所以清理 / 回收流程可以先用 /remove:d 摘掉再套回。
//   - 摘保护：/remove:d 只移除 deny ACE，不碰 allow ACE。
package wipeguard

import (
	"fmt"
	"os/exec"

	"datalens/internal/executil"
)

// everyoneSID Everyone 组的 SID（S-1-1-0）。用 SID 而不是名字，免受本地化组名影响。
const everyoneSID = "*S-1-1-0"

func icacls(args ...string) error {
	cmd := exec.Command("icacls", args...)
	executil.HideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %v: %v: %s", args, err, string(out))
	}
	return nil
}

// protectRoot 给目录套 deny-delete。icacls 不可用 / 失败时返回错误（调用方告警但不挡备份）。
//
// 两条 deny ACE 都必须带继承标志，缺一不可：
//   - (OI)(CI)(DE)：DELETE 拒绝，套在目录自身并继承到所有子对象/子目录；
//   - (CI)(DC)：FILE_DELETE_CHILD 拒绝，套在目录自身并继承到每层子目录。
//     DC 必须逐层生效——Go 的 openat 删除（os.RemoveAll 的 Deleteat 回退路径）在子对象
//     DELETE 被 DACL 拒时，会改试「父目录的 FILE_DELETE_CHILD」；DC 不传到中间目录的话，
//     备份根下的第二层文件就能被 Go 程序删掉（cmd 的 del 反而拦得住）。
func protectRoot(dir string) error {
	if _, err := exec.LookPath("icacls"); err != nil {
		return fmt.Errorf("icacls 不可用：%v", err)
	}
	if err := icacls(dir, "/deny", everyoneSID+":(OI)(CI)(DE)", everyoneSID+":(CI)(DC)"); err != nil {
		return err
	}
	return nil
}

// unprotectRoot 摘掉 deny-delete（清理 / 孤儿回收 / 索引压缩 / 整目录删除前调用）。
func unprotectRoot(dir string) error {
	if _, err := exec.LookPath("icacls"); err != nil {
		return fmt.Errorf("icacls 不可用：%v", err)
	}
	return icacls(dir, "/remove:d", everyoneSID)
}
