// driver.go：数据库驱动的统一契约与编译期注册表。
//
// 抄 SQLTools 的 Driver 接口思想但不做运行时插件——Go plugin 在 Windows 不可用且要求
// toolchain 完全一致，与单 exe 冲突（方案 §3.3）。驱动在本包 init 里静态注册。
// 只覆盖本项目需要的薄接口；Redis 是独立子系统（单独立项），语义不进这张 SQL 型接口。
package dbclient

import (
	"context"
	"fmt"
)

// Driver 单个数据库方言的驱动契约。
type Driver interface {
	// Kind 方言标识："sqlite" | "mysql"。
	Kind() string
	// Capabilities 驱动能力位。
	Capabilities() Capabilities
	// Open 建立连接并产出会话；由 openSession 统一登记生命周期。
	Open(ctx context.Context, spec openSpec) (*dbSession, error)
}

// openSpec 打开参数：SQLite 走 Path，MySQL 走 Config+Password。
type openSpec struct {
	Kind      string
	Path      string           // sqlite：库文件路径
	Config    ConnectionConfig // mysql：连接配置
	Password  string           // mysql：已解密的明文密码（只在本函数内使用，不落日志）
	AllowEdit bool             // false = 只读会话（guard 之外再加驱动级兜底）
}

// driverRegistry 编译期静态注册表。
var driverRegistry = map[string]Driver{}

func registerDriver(d Driver) {
	driverRegistry[d.Kind()] = d
}

func driverFor(kind string) (Driver, error) {
	d, ok := driverRegistry[kind]
	if !ok {
		return nil, fmt.Errorf("不支持的数据库类型：%q（支持 sqlite / mysql）", kind)
	}
	return d, nil
}

func init() {
	registerDriver(sqliteDriver{})
	registerDriver(mysqlDriver{})
}
