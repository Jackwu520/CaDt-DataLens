package dbclient

// config.go：连接配置与凭据——配置（非敏感）与凭据（dpapi 加密密码）分文件存放。
//
// 与 aiconfig 同一安全口径：密文绑定当前用户与本机（换用户/换机器解不开，ErrDecrypt 时
// 提示重新保存而不是覆盖）；凭据键用复合键 connectionID|host|port|user（防 SQLTools 式
// 同名冲突）；文件写入走 sessionlock + atomfile（跨进程单写者 + 原子替换）。
//
// 目标校验：拒绝连接链路本地地址（169.254.0.0/16，含云厂商 IMDS 169.254.169.254）与
// metadata 主机名。方案原文是「内网保留段默认拒绝」，实施时收窄为只拦元数据端点——
// 开发库大多在 192.168.x.x，默认拒内网等于让多数用户第一次用就去改配置（已确认的偏离）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/dpapi"
	"datalens/internal/sessionlock"
)

const (
	configLockWait = 2 * time.Second
	idPrefix       = "dbc-"
)

// credentialRecord 单条凭据：Sealed=true 表示 Value 是 dpapi 密文（base64）。
type credentialRecord struct {
	Value  string `json:"value"`
	Sealed bool   `json:"sealed"`
}

type credentialsData struct {
	Version int                         `json:"v"`
	Records map[string]credentialRecord `json:"records"`
}

// validateConnectionTarget 拒绝云元数据端点与链路本地地址；主机名先解析再判。
func validateConnectionTarget(host string) error {
	h := strings.TrimSpace(host)
	if h == "" {
		return errors.New("主机不能为空")
	}
	lower := strings.ToLower(strings.TrimSuffix(h, "."))
	if lower == "metadata.google.internal" || lower == "metadata" {
		return fmt.Errorf("拒绝连接云元数据服务端点：%s", h)
	}
	var ips []net.IP
	if ip := net.ParseIP(h); ip != nil {
		ips = append(ips, ip)
	} else {
		addrs, err := net.LookupHost(h)
		if err != nil {
			return fmt.Errorf("主机解析失败：%w", err)
		}
		for _, a := range addrs {
			if ip := net.ParseIP(a); ip != nil {
				ips = append(ips, ip)
			}
		}
	}
	for _, ip := range ips {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("拒绝连接链路本地地址（云元数据服务端点）：%s", ip)
		}
	}
	return nil
}

// validateConfig 保存/测试前的合法性校验。
func validateConfig(cfg ConnectionConfig) error {
	if strings.TrimSpace(cfg.Name) == "" {
		return errors.New("连接名不能为空")
	}
	if cfg.Kind != kindMySQL {
		return fmt.Errorf("暂只支持 MySQL 连接（SQLite 是打开本地文件，不落连接表）")
	}
	if err := validateConnectionTarget(cfg.Host); err != nil {
		return err
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return fmt.Errorf("端口无效：%d", cfg.Port)
	}
	return nil
}

// compositeKey 凭据复合键：同一 host:port 不同用户/连接互不串凭据。
func compositeKey(cfg ConnectionConfig) string {
	return strings.Join([]string{cfg.ID, cfg.Host, strconv.Itoa(cfg.Port), cfg.User}, "|")
}

func configPaths() (string, string, error) {
	if AppDataDir == nil {
		return "", "", errors.New("应用数据目录不可用")
	}
	root := AppDataDir()
	if root == "" {
		return "", "", errors.New("应用数据目录不可用")
	}
	return filepath.Join(root, connectionsFileName), filepath.Join(root, credentialsFileName), nil
}

// ---------- 配置文件读写（调用方需已持锁） ----------

func readConnections(path string) ([]ConnectionConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out struct {
		Version     int                `json:"v"`
		Connections []ConnectionConfig `json:"connections"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("连接配置文件损坏：%w", err)
	}
	return out.Connections, nil
}

func writeConnections(path string, list []ConnectionConfig) error {
	raw, err := json.MarshalIndent(struct {
		Version     int                `json:"v"`
		Connections []ConnectionConfig `json:"connections"`
	}{Version: 1, Connections: list}, "", "  ")
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomic(path, append(raw, '\n'))
}

func readCredentials(path string) (map[string]credentialRecord, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]credentialRecord{}, nil
		}
		return nil, err
	}
	var out credentialsData
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("凭据文件损坏：%w", err)
	}
	if out.Records == nil {
		out.Records = map[string]credentialRecord{}
	}
	return out.Records, nil
}

func writeCredentials(path string, records map[string]credentialRecord) error {
	raw, err := json.MarshalIndent(credentialsData{Version: 1, Records: records}, "", "  ")
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomic(path, append(raw, '\n'))
}

// ---------- 对外入口 ----------

// ListConnections 连接清单（不含密码）。
func ListConnections() ([]ConnectionConfig, error) {
	cfgPath, _, err := configPaths()
	if err != nil {
		return nil, err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return nil, err
	}
	defer lock.Release()
	list, err := readConnections(cfgPath)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []ConnectionConfig{}
	}
	return list, nil
}

// SaveConnection 新建/更新连接；password 为空串表示保留旧凭据。
// 密码只在内存参与加密，不进日志、不进返回值。
func SaveConnection(cfg ConnectionConfig, password string) (ConnectionConfig, error) {
	if err := validateConfig(cfg); err != nil {
		return ConnectionConfig{}, err
	}
	cfgPath, credPath, err := configPaths()
	if err != nil {
		return ConnectionConfig{}, err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return ConnectionConfig{}, err
	}
	defer lock.Release()

	list, err := readConnections(cfgPath)
	if err != nil {
		return ConnectionConfig{}, err
	}
	if cfg.ID == "" {
		cfg.ID = fmt.Sprintf("%s%d", idPrefix, time.Now().UnixNano())
	}
	cfg.Name = strings.TrimSpace(cfg.Name)
	cfg.Host = strings.TrimSpace(cfg.Host)
	cfg.User = strings.TrimSpace(cfg.User)
	cfg.UpdatedAt = time.Now().UnixMilli()
	replaced := false
	for i := range list {
		if list[i].ID == cfg.ID {
			list[i] = cfg
			replaced = true
			break
		}
	}
	if !replaced {
		list = append(list, cfg)
	}
	if err := writeConnections(cfgPath, list); err != nil {
		return ConnectionConfig{}, err
	}
	if password != "" {
		records, err := readCredentials(credPath)
		if err != nil {
			return ConnectionConfig{}, err
		}
		stored := password
		sealed := dpapi.Supported()
		if sealed {
			sealedStr, perr := dpapi.Protect(password, "datalens-db-credential:"+cfg.ID)
			if perr != nil {
				return ConnectionConfig{}, fmt.Errorf("凭据加密失败：%w", perr)
			}
			stored = sealedStr
		}
		records[compositeKey(cfg)] = credentialRecord{Value: stored, Sealed: sealed}
		if err := writeCredentials(credPath, records); err != nil {
			return ConnectionConfig{}, err
		}
	}
	return cfg, nil
}

// DeleteConnection 删除连接及其凭据。
func DeleteConnection(id string) error {
	cfgPath, credPath, err := configPaths()
	if err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(cfgPath), configLockFile), configLockWait)
	if err != nil {
		return err
	}
	defer lock.Release()

	list, err := readConnections(cfgPath)
	if err != nil {
		return err
	}
	found := false
	kept := make([]ConnectionConfig, 0, len(list))
	for _, c := range list {
		if c.ID == id {
			found = true
			continue
		}
		kept = append(kept, c)
	}
	if !found {
		return fmt.Errorf("连接不存在：%s", id)
	}
	if err := writeConnections(cfgPath, kept); err != nil {
		return err
	}
	records, err := readCredentials(credPath)
	if err != nil {
		return err
	}
	for key := range records {
		// 只删属于这个连接的复合键（键首段是 connectionID）
		if strings.HasPrefix(key, id+"|") {
			delete(records, key)
		}
	}
	return writeCredentials(credPath, records)
}

// credentialFor 解密连接的密码（无凭据返回空串，连接失败时由驱动报错）。
func credentialFor(cfg ConnectionConfig) (string, error) {
	_, credPath, err := configPaths()
	if err != nil {
		return "", err
	}
	records, err := readCredentials(credPath)
	if err != nil {
		return "", err
	}
	rec, ok := records[compositeKey(cfg)]
	if !ok {
		return "", nil
	}
	if !rec.Sealed {
		return rec.Value, nil // 非 Windows（dpapi.Supported()==false）的明文退路
	}
	plain, err := dpapi.Unprotect(rec.Value)
	if err != nil {
		return "", fmt.Errorf("凭据解密失败（换用户/换机器后密文不可解），请重新保存密码：%w", err)
	}
	return plain, nil
}

// findConnection 按取清单。
func findConnection(id string) (ConnectionConfig, error) {
	list, err := ListConnections()
	if err != nil {
		return ConnectionConfig{}, err
	}
	for _, c := range list {
		if c.ID == id {
			return c, nil
		}
	}
	return ConnectionConfig{}, fmt.Errorf("连接不存在：%s", id)
}

// Connect 用已保存连接建立会话。
func Connect(id string) (SessionInfo, error) {
	cfg, err := findConnection(id)
	if err != nil {
		return SessionInfo{}, err
	}
	password, err := credentialFor(cfg)
	if err != nil {
		return SessionInfo{}, err
	}
	return openSession(openSpec{Kind: cfg.Kind, Config: cfg, Password: password, AllowEdit: cfg.AllowEdit})
}

// TestConnection 测试连接：先连再查版本（两级验证）；password 为空时用已存凭据。
// 临时会话不进注册表。
func TestConnection(cfg ConnectionConfig, password string) (string, error) {
	if err := validateConfig(cfg); err != nil {
		return "", err
	}
	if password == "" {
		p, err := credentialFor(cfg)
		if err != nil {
			return "", err
		}
		password = p
	}
	drv, err := driverFor(cfg.Kind)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s, err := drv.Open(ctx, openSpec{Kind: cfg.Kind, Config: cfg, Password: password, AllowEdit: false})
	if err != nil {
		return "", err
	}
	defer func() { _ = s.db.Close() }()
	return serverVersion(ctx, s)
}

// ---------- 插件驱动的通用凭据存取 ----------

// credentialLockFile 复用连接配置的锁与凭据文件；插件键约定形如 dbplug:<条目id>:<字段键>，
// 与 ConnectionConfig 的复合键共存于同一张表（前缀隔离，互不干扰）。

// CredentialPut 保存一条通用凭据（dpapi 加密，同连接凭据一张表）。
// plain 为空串时删除该键（宿主语义：密码框留空 = 保持不变，不会调这里）。
func CredentialPut(key, plain string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("凭据键不能为空")
	}
	_, credPath, err := configPaths()
	if err != nil {
		return err
	}
	lock, err := sessionlock.LockFile(filepath.Join(filepath.Dir(credPath), configLockFile), configLockWait)
	if err != nil {
		return err
	}
	defer lock.Release()

	records, err := readCredentials(credPath)
	if err != nil {
		return err
	}
	if plain == "" {
		delete(records, key)
	} else {
		stored := plain
		sealed := dpapi.Supported()
		if sealed {
			sealedStr, perr := dpapi.Protect(plain, "datalens-db-plugin-credential")
			if perr != nil {
				return fmt.Errorf("凭据加密失败：%w", perr)
			}
			stored = sealedStr
		}
		records[key] = credentialRecord{Value: stored, Sealed: sealed}
	}
	return writeCredentials(credPath, records)
}

// CredentialGet 读取一条通用凭据；无记录返回空串。
func CredentialGet(key string) (string, error) {
	if strings.TrimSpace(key) == "" {
		return "", errors.New("凭据键不能为空")
	}
	_, credPath, err := configPaths()
	if err != nil {
		return "", err
	}
	records, err := readCredentials(credPath)
	if err != nil {
		return "", err
	}
	rec, ok := records[key]
	if !ok {
		return "", nil
	}
	if !rec.Sealed {
		return rec.Value, nil
	}
	plain, err := dpapi.Unprotect(rec.Value)
	if err != nil {
		return "", fmt.Errorf("凭据解密失败（换用户/换机器后密文不可解），请重新保存：%w", err)
	}
	return plain, nil
}

func serverVersion(ctx context.Context, s *dbSession) (string, error) {
	switch s.kind {
	case kindSQLite:
		return sqliteServerVersion(ctx, s)
	case kindMySQL:
		return mysqlServerVersion(ctx, s)
	default:
		return "", fmt.Errorf("未知方言：%s", s.kind)
	}
}
