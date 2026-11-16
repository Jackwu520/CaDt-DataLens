//go:build windows

package notify

import (
	"os"
	"testing"

	"golang.org/x/sys/windows/registry"
)

const toastAppKeyPathForTest = `SOFTWARE\Classes\AppUserModelId\` + toastAppID

// 守住「应用标识必须真的写进注册表」这件事：未登记的 AppID 上 Windows 返回成功但静默丢弃通知，
// 这正是系统通知长期失效的根因，且没有任何运行时错误可以断言。
func TestEnsureToastAppIDRegisters(t *testing.T) {
	existing, existedErr := registry.OpenKey(registry.CURRENT_USER, toastAppKeyPathForTest, registry.QUERY_VALUE)
	preExisting := existedErr == nil
	if preExisting {
		existing.Close()
	}
	if err := ensureToastAppID(); err != nil {
		t.Fatalf("ensureToastAppID() 失败：%v", err)
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, toastAppKeyPathForTest, registry.QUERY_VALUE)
	if err != nil {
		t.Fatalf("登记后读不到键 %s：%v", toastAppKeyPathForTest, err)
	}
	defer key.Close()
	name, _, err := key.GetStringValue("DisplayName")
	if err != nil {
		t.Fatalf("DisplayName 缺失：%v", err)
	}
	if name != toastDisplayName {
		t.Fatalf("DisplayName = %q，期望 %q", name, toastDisplayName)
	}
	// IconUri 提供通知头部「应用名左边」的小图标，写成 exe 路径不生效，必须是真实图片文件。
	// 测试二进制没有 rsrc 图标资源（渲染必然失败、不写 IconUri），所以只在存在时校验它指向的文件。
	if uri, _, uriErr := key.GetStringValue("IconUri"); uriErr == nil {
		if uri == "" {
			t.Fatal("IconUri 存在但为空")
		}
		if _, statErr := os.Stat(uri); statErr != nil {
			t.Fatalf("IconUri 指向的文件不可用：%s（%v）", uri, statErr)
		}
	}
	// 测试自己建的键收尾删掉，别在开发机上留下痕迹（正式运行时启动会自动登记）。
	if !preExisting {
		key.Close()
		if err := registry.DeleteKey(registry.CURRENT_USER, toastAppKeyPathForTest); err != nil {
			t.Logf("清理测试键失败（不影响结论）：%v", err)
		}
	}
}

func TestToastAppIDIsReadable(t *testing.T) {
	// 通知卡片标题行显示的就是 AppID 原文（注册表里的 DisplayName 只用于系统设置列表），
	// 换成一个像 com.example.app 的标识用户会看不懂。
	if toastAppID == "" {
		t.Fatal("toastAppID 不能为空")
	}
	for _, ch := range toastAppID {
		if ch < 0x20 || ch == '\\' || ch == '/' {
			t.Fatalf("toastAppID 含非法字符：%q", toastAppID)
		}
	}
}
