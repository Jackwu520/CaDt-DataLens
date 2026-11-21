package dbclient

// edit.go：受控写入（P2）——dirty model → SQL 预览 → 单事务提交 → 冲突检测。
//
// 硬要求（方案 §5.3）：
//   - 行定位只认主键（无主键表一律只读；不学 DBeaver「所有列当键」——NULL 语义与性能都不可靠）；
//   - UPDATE 的 WHERE 带旧值，RowsAffected==0 判冲突并整体回滚（乐观并发）；
//   - 旧值为 NULL 用 IS NULL 比较（`col = NULL` 永不匹配）；
//   - 一批修改包在单个事务里，显式失败即 RollBack；不承诺事务外回滚能力；
//   - 预览返回内联展示值的 SQL（仅供人看），实际执行走占位符参数，值不拼进 SQL。
//
// 操作留痕经前端 activity 攒批记录（连接/库表/类型/行数/耗时，不含参数值与密码）。

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// maxChangesPerApply 单次提交的变更数上限，防失控批量。
const maxChangesPerApply = 1000

// validateChanges 校验一批修改的结构合法性：表可编辑、键列恰好是主键集、目标列存在。
func validateChanges(s *dbSession, ch TableChanges, meta *DBTableMeta) error {
	if !s.editable {
		return ErrReadOnlySession
	}
	if len(meta.PK) == 0 {
		return fmt.Errorf("表 %s 没有主键，不可编辑（无主键表一律只读）", meta.Table)
	}
	if meta.Kind == "view" {
		return fmt.Errorf("视图 %s 不可编辑", meta.Table)
	}
	pkSet := map[string]bool{}
	for _, p := range meta.PK {
		pkSet[p] = true
	}
	colSet := map[string]bool{}
	for _, c := range meta.Columns {
		colSet[c.Name] = true
	}
	total := len(ch.Updates) + len(ch.Deletes) + len(ch.Inserts)
	if total == 0 {
		return errors.New("没有可提交的修改")
	}
	if total > maxChangesPerApply {
		return fmt.Errorf("单次提交最多 %d 条修改（当前 %d 条），请分批提交", maxChangesPerApply, total)
	}
	checkKeys := func(keys map[string]string) error {
		if len(keys) != len(pkSet) {
			return errors.New("主键定位不完整：必须提供全部主键列的值")
		}
		for col := range keys {
			if !pkSet[col] {
				return fmt.Errorf("主键定位列 %q 不属于主键（%s）", col, strings.Join(meta.PK, ", "))
			}
		}
		return nil
	}
	for i := range ch.Updates {
		if err := checkKeys(ch.Updates[i].Keys); err != nil {
			return fmt.Errorf("第 %d 条修改：%w", i+1, err)
		}
		if !colSet[ch.Updates[i].Column] {
			return fmt.Errorf("第 %d 条修改：列不存在：%q", i+1, ch.Updates[i].Column)
		}
	}
	for i := range ch.Deletes {
		if err := checkKeys(ch.Deletes[i].Keys); err != nil {
			return fmt.Errorf("第 %d 条删除：%w", i+1, err)
		}
	}
	for i := range ch.Inserts {
		for col := range ch.Inserts[i].Values {
			if !colSet[col] {
				return fmt.Errorf("第 %d 条插入：列不存在：%q", i+1, col)
			}
		}
	}
	return nil
}

// sortedKeys map 键排序（预览 SQL 的列序确定，避免 map 遍历随机）。
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedPtrKeys(m map[string]*string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// sqlLiteral 内联展示值（预览专用，仅供人看；实际执行走参数）。' 用成对转义（两种方言通用）。
func sqlLiteral(v *string) string {
	if v == nil {
		return "NULL"
	}
	return "'" + strings.ReplaceAll(*v, "'", "''") + "'"
}

// pkWhere 主键定位条件（展示版与参数版共用拼装，值渲染由调用方给）。
func pkWhere(kind string, meta *DBTableMeta, keys map[string]string, render func(string) string) string {
	var parts []string
	for _, p := range meta.PK {
		parts = append(parts, quoteIdent(kind, p)+" = "+render(keys[p]))
	}
	return strings.Join(parts, " AND ")
}

// PreviewChanges 生成提交预览：每条修改一条语句，SQL 已内联展示值（人看）。
func PreviewChanges(id string, ch TableChanges) ([]ChangeStatement, error) {
	s, err := getSession(id)
	if err != nil {
		return nil, err
	}
	meta, err := describeMeta(s, ch.Database, ch.Table, false)
	if err != nil {
		return nil, err
	}
	if err := validateChanges(s, ch, meta); err != nil {
		return nil, err
	}
	kind := s.kind
	ref := quoteTableRef(kind, meta.Database, meta.Table)
	var out []ChangeStatement
	for _, u := range ch.Updates {
		var b strings.Builder
		b.WriteString("UPDATE ")
		b.WriteString(ref)
		b.WriteString(" SET ")
		b.WriteString(quoteIdent(kind, u.Column))
		b.WriteString(" = ")
		b.WriteString(sqlLiteral(u.NewValue))
		b.WriteString(" WHERE ")
		b.WriteString(pkWhere(kind, meta, u.Keys, sqlKeyLiteral))
		b.WriteString(" AND ")
		b.WriteString(quoteIdent(kind, u.Column))
		if u.OldValue == nil {
			b.WriteString(" IS NULL")
		} else {
			b.WriteString(" = ")
			b.WriteString(sqlLiteral(u.OldValue))
		}
		out = append(out, ChangeStatement{Kind: "update", SQL: b.String()})
	}
	for _, d := range ch.Deletes {
		stmt := "DELETE FROM " + ref + " WHERE " + pkWhere(kind, meta, d.Keys, sqlKeyLiteral)
		out = append(out, ChangeStatement{Kind: "delete", SQL: stmt})
	}
	for _, ins := range ch.Inserts {
		cols := sortedPtrKeys(ins.Values)
		refs := make([]string, 0, len(cols))
		lits := make([]string, 0, len(cols))
		for _, c := range cols {
			refs = append(refs, quoteIdent(kind, c))
			lits = append(lits, sqlLiteral(ins.Values[c]))
		}
		stmt := "INSERT INTO " + ref + " (" + strings.Join(refs, ", ") + ") VALUES (" + strings.Join(lits, ", ") + ")"
		out = append(out, ChangeStatement{Kind: "insert", SQL: stmt})
	}
	return out, nil
}

func sqlKeyLiteral(v string) string {
	s := v
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// ApplyChanges 提交一批修改：单事务，任一语句行数不符预期即整体回滚。
func ApplyChanges(id string, ch TableChanges) (ApplyResult, error) {
	started := time.Now()
	s, err := getSession(id)
	if err != nil {
		return ApplyResult{}, err
	}
	meta, err := describeMeta(s, ch.Database, ch.Table, false)
	if err != nil {
		return ApplyResult{}, err
	}
	if err := validateChanges(s, ch, meta); err != nil {
		return ApplyResult{}, err
	}
	kind := s.kind
	ref := quoteTableRef(kind, meta.Database, meta.Table)
	ctx, cancel := context.WithTimeout(context.Background(), applyTimeout)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ApplyResult{}, err
	}
	rollback := func(reason error) (ApplyResult, error) {
		_ = tx.Rollback()
		return ApplyResult{}, reason
	}
	result := ApplyResult{}
	// UPDATE：主键定位 + 旧值乐观校验
	for i, u := range ch.Updates {
		var b strings.Builder
		var args []any
		b.WriteString("UPDATE ")
		b.WriteString(ref)
		b.WriteString(" SET ")
		b.WriteString(quoteIdent(kind, u.Column))
		b.WriteString(" = ? WHERE ")
		var keyParts []string
		for _, p := range meta.PK {
			keyParts = append(keyParts, quoteIdent(kind, p)+" = ?")
			args = append(args, u.Keys[p])
		}
		b.WriteString(strings.Join(keyParts, " AND "))
		b.WriteString(" AND ")
		b.WriteString(quoteIdent(kind, u.Column))
		if u.OldValue == nil {
			b.WriteString(" IS NULL")
		} else {
			b.WriteString(" = ?")
			args = append(args, *u.OldValue)
		}
		args = append([]any{nullableParam(u.NewValue)}, args...)
		res, err := tx.ExecContext(ctx, b.String(), args...)
		if err != nil {
			return rollback(fmt.Errorf("第 %d 条修改执行失败：%w", i+1, err))
		}
		affected, _ := res.RowsAffected()
		if affected != 1 {
			return rollback(fmt.Errorf("第 %d 条修改与当前数据冲突（该行可能已被其他会话修改），已整体回滚，请刷新后重试", i+1))
		}
		result.Updates++
	}
	// DELETE：主键定位
	for i, d := range ch.Deletes {
		var b strings.Builder
		var args []any
		b.WriteString("DELETE FROM ")
		b.WriteString(ref)
		b.WriteString(" WHERE ")
		var keyParts []string
		for _, p := range meta.PK {
			keyParts = append(keyParts, quoteIdent(kind, p)+" = ?")
			args = append(args, d.Keys[p])
		}
		b.WriteString(strings.Join(keyParts, " AND "))
		res, err := tx.ExecContext(ctx, b.String(), args...)
		if err != nil {
			return rollback(fmt.Errorf("第 %d 条删除执行失败：%w", i+1, err))
		}
		affected, _ := res.RowsAffected()
		if affected != 1 {
			return rollback(fmt.Errorf("第 %d 条删除与当前数据冲突（该行可能已被其他会话删除），已整体回滚，请刷新后重试", i+1))
		}
		result.Deletes++
	}
	// INSERT
	for i, ins := range ch.Inserts {
		cols := sortedPtrKeys(ins.Values)
		refs := make([]string, 0, len(cols))
		holders := make([]string, 0, len(cols))
		var args []any
		for _, c := range cols {
			refs = append(refs, quoteIdent(kind, c))
			holders = append(holders, "?")
			args = append(args, nullableParam(ins.Values[c]))
		}
		if len(cols) == 0 {
			return rollback(fmt.Errorf("第 %d 条插入没有提供任何值", i+1))
		}
		stmt := "INSERT INTO " + ref + " (" + strings.Join(refs, ", ") + ") VALUES (" + strings.Join(holders, ", ") + ")"
		res, err := tx.ExecContext(ctx, stmt, args...)
		if err != nil {
			return rollback(fmt.Errorf("第 %d 条插入执行失败：%w", i+1, err))
		}
		affected, _ := res.RowsAffected()
		if affected != 1 {
			return rollback(fmt.Errorf("第 %d 条插入未生效，已整体回滚", i+1))
		}
		result.Inserts++
	}
	if err := tx.Commit(); err != nil {
		return ApplyResult{}, fmt.Errorf("提交失败：%w", err)
	}
	result.ElapsedMs = time.Since(started).Milliseconds()
	return result, nil
}

// nullableParam *string → 占位符参数（nil = SQL NULL）。
func nullableParam(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}
