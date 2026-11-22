package dbclient

// config_test.go：连接配置与凭据的读写、校验与删除（AppDataDir 换成临时目录）。

import (
	"testing"
)

func withTempAppData(t *testing.T) {
	t.Helper()
	// t.TempDir() 每次调用都会新建子目录（001/002…），必须先取一次再闭包返回
	dir := t.TempDir()
	old := AppDataDir
	AppDataDir = func() string { return dir }
	t.Cleanup(func() { AppDataDir = old })
}

func validMySQLConfig(name string) ConnectionConfig {
	// 127.0.0.1:1 连接立即被拒（无服务监听），让 Connect 的负路径用例快速失败不拖全量
	return ConnectionConfig{
		Name: name, Kind: kindMySQL, Host: "127.0.0.1", Port: 1,
		Database: "shop", User: "reader",
	}
}

func TestConnectionConfigCRUD(t *testing.T) {
	withTempAppData(t)

	// 初始为空
	list, err := ListConnections()
	if err != nil || len(list) != 0 {
		t.Fatalf("初始清单 = %v, %v", list, err)
	}

	// 保存：自动分配 ID + 记住密码
	cfg, err := SaveConnection(validMySQLConfig("测试库"), "secret-pw")
	if err != nil || cfg.ID == "" {
		t.Fatalf("保存失败：%v / id=%q", err, cfg.ID)
	}
	got, found, err := credentialFor(cfg)
	if err != nil || got != "secret-pw" || !found {
		t.Fatalf("凭据往返失败：%q, found=%v, %v", got, found, err)
	}

	// 清单可读回
	list, err = ListConnections()
	if err != nil || len(list) != 1 || list[0].Name != "测试库" {
		t.Fatalf("清单异常：%+v, %v", list, err)
	}

	// 更新（同 ID）：不带密码保留旧凭据
	cfg.Name = "测试库2"
	saved, err := SaveConnection(cfg, "")
	if err != nil {
		t.Fatalf("更新失败：%v", err)
	}
	got, found, err = credentialFor(saved)
	if err != nil || got != "secret-pw" || !found {
		t.Fatalf("空密码应保留旧凭据：%q, %v", got, err)
	}

	// 更新（同 ID）：带密码覆盖
	if _, err := SaveConnection(cfg, "new-pw"); err != nil {
		t.Fatalf("覆盖密码失败：%v", err)
	}
	got, _, _ = credentialFor(cfg)
	if got != "new-pw" {
		t.Fatalf("密码未覆盖：%q", got)
	}

	// 复合键含 host/port/user：不同用户的凭据互不覆盖
	other := validMySQLConfig("另一个库")
	other.Host = "192.168.1.11"
	other, err = SaveConnection(other, "other-pw")
	if err != nil {
		t.Fatalf("保存第二个连接失败：%v", err)
	}
	got, _, _ = credentialFor(cfg)
	if got != "new-pw" {
		t.Fatalf("凭据串号：%q", got)
	}

	// 删除：配置与凭据一起清
	if err := DeleteConnection(cfg.ID); err != nil {
		t.Fatalf("删除失败：%v", err)
	}
	list, _ = ListConnections()
	if len(list) != 1 || list[0].ID != other.ID {
		t.Fatalf("删除后清单异常：%+v", list)
	}
	// 删除后凭据应查不到（credentialFor 对缺失凭据返回空串，不报错）
	if got, found, err := credentialFor(cfg); err != nil || got != "" || found {
		t.Fatalf("删除后凭据状态异常：%q, found=%v, %v", got, found, err)
	}
}

func TestConnectionConfigValidation(t *testing.T) {
	withTempAppData(t)

	bad := []struct {
		name string
		cfg  ConnectionConfig
	}{
		{name: "名字为空", cfg: ConnectionConfig{Name: " ", Kind: kindMySQL, Host: "1.2.3.4", Port: 3306}},
		{name: "kind 不支持", cfg: ConnectionConfig{Name: "x", Kind: "oracle", Host: "1.2.3.4", Port: 3306}},
		{name: "IMDS 地址", cfg: ConnectionConfig{Name: "x", Kind: kindMySQL, Host: "169.254.169.254", Port: 3306}},
		{name: "链路本地 IPv6", cfg: ConnectionConfig{Name: "x", Kind: kindMySQL, Host: "fe80::1", Port: 3306}},
		{name: "metadata 主机名", cfg: ConnectionConfig{Name: "x", Kind: kindMySQL, Host: "metadata.google.internal", Port: 3306}},
		{name: "端口越界", cfg: ConnectionConfig{Name: "x", Kind: kindMySQL, Host: "1.2.3.4", Port: 70000}},
	}
	for _, tt := range bad {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := SaveConnection(tt.cfg, ""); err == nil {
				t.Fatalf("非法配置未被拒绝：%+v", tt.cfg)
			}
		})
	}
	// 普通内网地址放行（实施偏离：只拦元数据端点，不拦内网段）
	if _, err := SaveConnection(validMySQLConfig("内网库"), ""); err != nil {
		t.Fatalf("内网地址不应默认拒绝：%v", err)
	}
}

func TestCredentialPutGet(t *testing.T) {
	withTempAppData(t)

	// 写入 → 读回（Windows 上 dpapi 密文往返）
	if err := CredentialPut("dbplug:e1:password", "s3cret"); err != nil {
		t.Fatalf("CredentialPut 失败：%v", err)
	}
	got, err := CredentialGet("dbplug:e1:password")
	if err != nil || got != "s3cret" {
		t.Fatalf("凭据往返失败：%q, %v", got, err)
	}

	// 空串 = 删除；不存在的键 = 空串无错
	if err := CredentialPut("dbplug:e1:password", ""); err != nil {
		t.Fatalf("空串删除失败：%v", err)
	}
	if got, err := CredentialGet("dbplug:e1:password"); err != nil || got != "" {
		t.Fatalf("删除后应读空：%q, %v", got, err)
	}
	if got, err := CredentialGet("dbplug:none:x"); err != nil || got != "" {
		t.Fatalf("缺失键应读空：%q, %v", got, err)
	}

	// 空键拒绝
	if err := CredentialPut("  ", "x"); err == nil {
		t.Fatal("空键未被拒绝")
	}
	if _, err := CredentialGet("  "); err == nil {
		t.Fatal("空键读取未被拒绝")
	}
}

func TestFindConnectionAndConnect(t *testing.T) {
	withTempAppData(t)
	cfg, err := SaveConnection(validMySQLConfig("连接"), "pw")
	if err != nil {
		t.Fatalf("保存失败：%v", err)
	}
	found, err := findConnection(cfg.ID)
	if err != nil || found.Host != "127.0.0.1" {
		t.Fatalf("findConnection 异常：%+v, %v", found, err)
	}
	if _, err := findConnection("dbc-none"); err == nil {
		t.Fatal("不存在的连接应报错")
	}
	// Connect 走真实拨号：对不可达地址应报连接失败（快速失败，不产生会话）
	if _, err := Connect(cfg.ID); err == nil {
		t.Fatal("不可达地址不应连接成功")
	}
}
