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
func buildMySQLDSN(cfg ConnectionConfig, password string) (string, error) {
	if cfg.Host == "" {
		return "", errors.New("主机不能为空")
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return "", fmt.Errorf("端口无效：%d", cfg.Port)
	}
	mc := mysql.NewConfig()
	mc.User = cfg.User
	mc.Passwd = password
	mc.Net = "tcp"
	mc.Addr = fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	mc.DBName = cfg.Database
	mc.Timeout = 10 * time.Second
	mc.ReadTimeout = 30 * time.Second
	mc.WriteTimeout = 30 * time.Second
	mc.Params = map[string]string{"charset": "utf8mb4"}
	return mc.FormatDSN(), nil
}

func (mysqlDriver) Open(ctx context.Context, spec openSpec) (*dbSession, error) {
	if err := validateConnectionTarget(spec.Config.Host); err != nil {
		return nil, err
	}
	dsn, err := buildMySQLDSN(spec.Config, spec.Password)
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
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = db.PingContext(pingCtx)
	cancel()
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("MySQL 连接失败（检查主机/端口/用户名密码，以及网络可达性）：%w", err)
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
	rows, err := s.db.QueryContext(ctx, `SELECT table_name, table_type, COALESCE(table_rows, 0)
		FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, schema)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DBObject{}
	for rows.Next() {
		var o DBObject
		var kind string
		if err := rows.Scan(&o.Name, &kind, &o.RowEstimate); err != nil {
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
	// 行数估算（information_schema.tables 的估计值，UI 以「约」展示，不跑 COUNT(*)）
	var est int64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(table_rows, 0) FROM information_schema.tables
		WHERE table_schema = ? AND table_name = ?`, schema, table).Scan(&est); err == nil {
		meta.RowEstimate = est
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
