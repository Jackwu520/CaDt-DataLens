package dbclient

// mysql.go：MySQL 驱动（github.com/go-sql-driver/mysql，纯 Go，+0.5 MB 体积增量
// 已由作者批准——2026-11-22，见方案 §5.2）。
//
// 只读会话：连接池限 1 连接并在建连后 SET SESSION TRANSACTION READ ONLY，作为 guard 之外的
// 第二道（池内唯一连接死后重建会丢这条设置——guard 是主防线，这道只是加固）。
// 元数据走 information_schema（可控、可分页），不依赖 SHOW 的不可控输出（方案 §5.2）。
// DSN 不开 multiStatements：多语句由 guard 拆分后逐条执行，避免驱动侧绕过分类。

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"
)

type mysqlDriver struct{}

func (mysqlDriver) Kind() string { return kindMySQL }

func (mysqlDriver) Capabilities() Capabilities {
	return Capabilities{Transaction: true, Editable: true}
}

// buildMySQLDSN 用 mysql.Config.FormatDSN 组装（密码特殊字符由驱动转义）。
// 不开 multiStatements；ParseTime=false 保持原始字符串展示，避免时区换算失真。
// addr 由 resolveSafeAddr 给出（已校验的 IP 直连，封住校验与拨号间的 DNS rebinding 窗口）。
func buildMySQLDSN(cfg ConnectionConfig, password, addr string) (string, error) {
	mc := mysql.NewConfig()
	mc.User = cfg.User
	mc.Passwd = password
	mc.Net = "tcp"
	mc.Addr = addr
	mc.DBName = cfg.Database
	mc.Timeout = 10 * time.Second
	mc.ReadTimeout = 30 * time.Second
	mc.WriteTimeout = 30 * time.Second
	// UPDATE 按「匹配行数」计数（而非默认的改动行数）：改回原值的单元格提交不被误判为冲突
	mc.ClientFoundRows = true
	mc.Params = map[string]string{"charset": "utf8mb4"}
	return mc.FormatDSN(), nil
}

func (mysqlDriver) Open(ctx context.Context, spec openSpec) (*dbSession, error) {
	// 解析并校验目标：候选地址逐个尝试（IPv4 优先）——localhost 常同时解析出 127.0.0.1
	// 与 ::1，而本机服务可能只监听其中一个栈；只拨第一个会让「看起来配对了却连不上」
	addrs, err := resolveSafeAddrs(spec.Config.Host, spec.Config.Port)
	if err != nil {
		return nil, err
	}
	if len(addrs) > 3 {
		addrs = addrs[:3] // 拨号预算：外层 ctx 20s 内最多试 3 个候选
	}
	var lastErr error
	for _, addr := range addrs {
		s, attemptErr := openMySQLAddr(ctx, spec, addr)
		if attemptErr == nil {
			return s, nil
		}
		lastErr = attemptErr
		// 认证/授权失败换地址也不会好——直接返回，不再试下一个候选
		if errors.Is(attemptErr, errMySQLAuth) {
			return nil, fmt.Errorf("MySQL 连接失败（检查用户名密码）：%w", attemptErr)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("无可用地址")
	}
	return nil, fmt.Errorf("MySQL 连接失败（已尝试 %d 个地址；检查主机/端口/用户名密码，以及网络可达性）：%w", len(addrs), lastErr)
}

// errMySQLAuth 标记认证/授权类失败（ER_ACCESS_DENIED 等）——多候选循环不再重试。
var errMySQLAuth = errors.New("认证失败")

// openMySQLAddr 对单个候选地址完成拨号 + 握手 + 只读设置 + 会话装配。
func openMySQLAddr(ctx context.Context, spec openSpec, addr string) (*dbSession, error) {
	dsn, err := buildMySQLDSN(spec.Config, spec.Password, addr)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	if spec.AllowEdit {
		db.SetMaxOpenConns(2)
		db.SetMaxIdleConns(2)
	} else {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	}
	db.SetConnMaxLifetime(10 * time.Minute)
	pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	pingErr := db.PingContext(pingCtx)
	cancel()
	if pingErr != nil {
		_ = db.Close()
		// 认证失败单列：换候选地址无意义，外层循环直接终止
		var mysqlErr *mysql.MySQLError
		if errors.As(pingErr, &mysqlErr) && mysqlErr.Number == 1045 {
			return nil, fmt.Errorf("%w（%s）", errMySQLAuth, mysqlErr.Message)
		}
		return nil, pingErr
	}
	if !spec.AllowEdit {
		roCtx, roCancel := context.WithTimeout(ctx, 5*time.Second)
		if _, roErr := db.ExecContext(roCtx, "SET SESSION TRANSACTION READ ONLY"); roErr != nil {
			logWarn("MySQL 只读会话设置失败（guard 分类仍是主防线）：%v", roErr)
		}
		roCancel()
	}
	return &dbSession{
		kind:     kindMySQL,
		name:     spec.Config.Name,
		server:   fmt.Sprintf("%s:%d", spec.Config.Host, spec.Config.Port),
		database: spec.Config.Database,
		editable: spec.AllowEdit,
		caps:     mysqlDriver{}.Capabilities(),
		db:       db,
	}, nil
}

// ---------- 元数据（L1 / L2） ----------

// mysqlSchema 解析当前操作库：显式指定优先，否则用连接配置里的默认库。
func mysqlSchema(s *dbSession, database string) string {
	if database != "" {
		return database
	}
	return s.database
}

func mysqlListObjects(ctx context.Context, s *dbSession, database string) ([]DBObject, error) {
	schema := mysqlSchema(s, database)
	if schema == "" {
		return nil, errors.New("未指定数据库：请先在对象树选择一个库，或连接时设置默认库")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT table_name, table_type, COALESCE(table_rows, 0), COALESCE(table_comment, '')
		FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, schema)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DBObject{}
	for rows.Next() {
		var o DBObject
		var kind string
		if err := rows.Scan(&o.Name, &kind, &o.RowEstimate, &o.Comment); err != nil {
			return nil, err
		}
		if kind == "VIEW" {
			o.Kind = "view"
		} else {
			o.Kind = "table"
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func mysqlDescribe(ctx context.Context, s *dbSession, database, table string) (*DBTableMeta, error) {
	schema := mysqlSchema(s, database)
	if schema == "" {
		return nil, errors.New("未指定数据库")
	}
	meta := &DBTableMeta{Table: table, Database: schema}
	colRows, err := s.db.QueryContext(ctx, `SELECT column_name, column_type, is_nullable, column_default, column_key
		FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
		schema, table)
	if err != nil {
		return nil, err
	}
	for colRows.Next() {
		var name, colType, nullable, key string
		var dflt sql.NullString
		if err := colRows.Scan(&name, &colType, &nullable, &dflt, &key); err != nil {
			colRows.Close()
			return nil, err
		}
		var defaultPtr *string
		if dflt.Valid {
			v := dflt.String
			defaultPtr = &v
		}
		meta.Columns = append(meta.Columns, ColumnMeta{
			Name:    name,
			Type:    colType,
			NotNull: nullable == "NO",
			Default: defaultPtr,
			PK:      key == "PRI",
		})
		if key == "PRI" {
			meta.PK = append(meta.PK, name)
		}
	}
	if err := colRows.Err(); err != nil {
		colRows.Close()
		return nil, err
	}
	colRows.Close()
	if len(meta.Columns) == 0 {
		return nil, fmt.Errorf("表不存在或无权访问：%s.%s", schema, table)
	}
	idxRows, err := s.db.QueryContext(ctx, `SELECT index_name, non_unique, column_name
		FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?
		ORDER BY index_name, seq_in_index`, schema, table)
	if err != nil {
		return nil, err
	}
	defer idxRows.Close()
	// information_schema 按 (index_name, seq_in_index) 有序返回，按序聚合即列顺序
	byName := map[string]*IndexMeta{}
	var order []string
	for idxRows.Next() {
		var name, col string
		var nonUnique int
		if err := idxRows.Scan(&name, &nonUnique, &col); err != nil {
			return nil, err
		}
		idx, ok := byName[name]
		if !ok {
			idx = &IndexMeta{Name: name, Unique: nonUnique == 0}
			byName[name] = idx
			order = append(order, name)
		}
		idx.Columns = append(idx.Columns, col)
	}
	if err := idxRows.Err(); err != nil {
		return nil, err
	}
	for _, name := range order {
		meta.Indexes = append(meta.Indexes, *byName[name])
	}
	// 行数估算与表注释（information_schema.tables 的估计值，UI 以「约」展示，不跑 COUNT(*)）
	var est int64
	var comment string
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(table_rows, 0), COALESCE(table_comment, '') FROM information_schema.tables
		WHERE table_schema = ? AND table_name = ?`, schema, table).Scan(&est, &comment); err == nil {
		meta.RowEstimate = est
		meta.TableComment = comment
	}
	return meta, nil
}

func mysqlListDatabases(ctx context.Context, s *dbSession) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT schema_name FROM information_schema.schemata
		WHERE schema_name NOT IN ('information_schema', 'performance_schema') ORDER BY schema_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func mysqlServerVersion(ctx context.Context, s *dbSession) (string, error) {
	var v string
	if err := s.db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&v); err != nil {
		return "", err
	}
	return "MySQL " + v, nil
}

// mysqlListServerObjects 服务器对象分组（对齐 JetBrains 侧栏的「服务器对象」层）：
// 排序规则 / 用户 / 系统虚拟视图。每组独立查询独立容错——权限不足的组带 Error 返回，
// 前端隐藏整组而不是让整个面板失败。全部是 information_schema/mysql 只读元数据查询。
func mysqlListServerObjects(s *dbSession) *ServerObjects {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	out := &ServerObjects{}
	group := func(id, label, query string) {
		rows, err := s.db.QueryContext(ctx, query)
		if err != nil {
			out.Groups = append(out.Groups, ServerObjectGroup{ID: id, Label: label, Error: err.Error()})
			return
		}
		items, err := scanStringColumn(rows)
		if err != nil {
			out.Groups = append(out.Groups, ServerObjectGroup{ID: id, Label: label, Error: err.Error()})
			return
		}
		out.Groups = append(out.Groups, ServerObjectGroup{ID: id, Label: label, Items: items})
	}
	group("collations", "排序规则", `SELECT collation_name FROM information_schema.collations ORDER BY collation_name`)
	group("users", "用户", `SELECT CONCAT(user, '@', host) FROM mysql.user ORDER BY host, user`)
	group("sysviews", "虚拟视图", `SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'information_schema' AND table_type = 'SYSTEM VIEW' ORDER BY table_name`)
	return out
}

// scanStringColumn 单列字符串扫描（服务器对象清单公用；rows 在此收口）。
func scanStringColumn(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
