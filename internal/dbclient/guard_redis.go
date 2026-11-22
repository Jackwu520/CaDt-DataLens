package dbclient

// guard_redis.go：Redis 控制台命令的安全分类（方案 §5.4）。
//
// 与 SQL 侧同一套模型（guard.go）：首词 + 白名单 + fail closed；四类语义对齐——
//   - classRead：只读命令白名单（只认「安全子命令」粒度，如 config 只放行 get）；
//   - classWrite：写命令表，editable 会话才放行（连接级「允许编辑」开关，与 MySQL 同口径）；
//   - danger：写 + 二次确认（FLUSHALL/CONFIG SET/SHUTDOWN 等）；
//   - classCtrl：MULTI/EXEC/WATCH 等——控制台一律拒（与 SQL 的 BEGIN/COMMIT 同口径：
//     编辑走结构化 RedisApply，不提供手写事务）。
//
// 词表从严：拿不准的一律不进白名单（unknown → 拒）。已知取舍：
//   - xread/xreadgroup 不进读白名单（带 BLOCK 参数会阻塞连接）；
//   - memory/client/object/acl/script/debug 整体不进读白名单（子命令混杂读/写），
//     script/debug 整体按 danger；
//   - sort 按 classWrite（无 store 参数其实是读——从严，只读会话跑不了 sort 无伤大雅）。

import (
	"fmt"
	"strings"
)

// tokenizeRedis 命令行 → 参数序列（[][]byte 二进制安全）：空白分隔，引号段成单参数。
// 支持双引号内的 \" \\ 转义与单引号内的原样文本（Redis 官方 CLI 的近似子集）。
func tokenizeRedis(stmt string) ([][]byte, error) {
	var out [][]byte
	i, n := 0, len(stmt)
	for i < n {
		c := stmt[i]
		switch {
		case c == ' ' || c == '\t':
			i++
		case c == '"' || c == '\'':
			quote := c
			i++
			var cur []byte
			closed := false
			for i < n {
				ch := stmt[i]
				if quote == '"' && ch == '\\' && i+1 < n {
					// 双引号转义：\" \\ \n \r \t（其余按字面保留反斜杠）
					switch stmt[i+1] {
					case '"':
						cur = append(cur, '"')
					case '\\':
						cur = append(cur, '\\')
					case 'n':
						cur = append(cur, '\n')
					case 'r':
						cur = append(cur, '\r')
					case 't':
						cur = append(cur, '\t')
					default:
						cur = append(cur, '\\', stmt[i+1])
					}
					i += 2
					continue
				}
				if ch == quote {
					closed = true
					i++
					break
				}
				cur = append(cur, ch)
				i++
			}
			if !closed {
				return nil, fmt.Errorf("引号未闭合：%s", stmt)
			}
			out = append(out, cur)
		default:
			start := i
			for i < n && stmt[i] != ' ' && stmt[i] != '\t' && stmt[i] != '"' && stmt[i] != '\'' {
				i++
			}
			out = append(out, []byte(stmt[start:i]))
		}
	}
	return out, nil
}

// splitRedisStatements 控制台输入按行拆（一行一条命令；空行与 # 注释行跳过）。
// 多行字符串参数（SET 大值）不适用文本通道——走结构化 RedisApply。
func splitRedisStatements(q string) []string {
	var out []string
	for _, line := range strings.Split(q, "\n") {
		t := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		out = append(out, t)
	}
	return out
}

var (
	// redisReadCmds 只读白名单（fail closed：白名单外一律不当读）。
	redisReadCmds = map[string]bool{
		"get": true, "mget": true, "getrange": true, "strlen": true,
		"ttl": true, "pttl": true, "exists": true, "type": true,
		"scan": true, "sscan": true, "hscan": true, "zscan": true,
		"hget": true, "hgetall": true, "hmget": true, "hkeys": true, "hvals": true, "hlen": true,
		"llen": true, "lindex": true, "lrange": true, "lpos": true,
		"smembers": true, "scard": true, "sismember": true, "smismember": true,
		"zrange": true, "zrevrange": true, "zrangebyscore": true, "zrevrangebyscore": true,
		"zcard": true, "zscore": true, "zcount": true, "zrank": true, "zrevrank": true,
		"xrange": true, "xrevrange": true, "xlen": true, "xinfo": true,
		"dbsize": true, "ping": true, "echo": true, "time": true, "randomkey": true,
		"bitcount": true, "bitpos": true, "getbit": true,
		"command": true, "lolwut": true,
	}
	// redisWriteCmds 常规写命令（editable 会话放行）。
	redisWriteCmds = map[string]bool{
		"set": true, "setnx": true, "setex": true, "psetex": true, "mset": true, "msetnx": true,
		"append": true, "getset": true, "setbit": true, "setrange": true, "getdel": true,
		"incr": true, "incrby": true, "incrbyfloat": true, "decr": true, "decrby": true,
		"hset": true, "hsetnx": true, "hincrby": true, "hincrbyfloat": true, "hmset": true, "hdel": true,
		"lpush": true, "lpushx": true, "rpush": true, "rpushx": true,
		"lpop": true, "rpop": true, "lrem": true, "lset": true, "linsert": true, "ltrim": true,
		"sadd": true, "srem": true, "spop": true, "smove": true,
		"sinterstore": true, "sunionstore": true, "sdiffstore": true,
		"zadd": true, "zincrby": true, "zrem": true, "zremrangebyrank": true, "zremrangebyscore": true,
		"zpopmin": true, "zpopmax": true,
		"xadd": true, "xdel": true, "xtrim": true, "xgroup": true, "xsetid": true,
		"expire": true, "pexpire": true, "expireat": true, "pexpireat": true, "persist": true,
		"rename": true, "renamenx": true, "copy": true, "move": true, "sort": true,
	}
	// redisDangerCmds 写 + 二次确认（强危险）。
	redisDangerCmds = map[string]bool{
		"flushdb": true, "flushall": true, "shutdown": true,
		"debug": true, "script": true, "monitor": true,
		"replicaof": true, "slaveof": true, "swapdb": true,
		"restore": true, "migrate": true, "module": true,
		"bgsave": true, "save": true, "bgrewriteaof": true,
		"acl": true, "reset": true,
	}
	// redisCtrlCmds 事务/连接控制——控制台一律拒（编辑走结构化 RedisApply）。
	redisCtrlCmds = map[string]bool{
		"multi": true, "exec": true, "discard": true, "watch": true, "unwatch": true,
	}
)

// classifyRedisStatement 单条 Redis 命令分类：tokenize 后按首词查词表；
// config 精确拆分（get 读、其余 danger）。未知命令按写 + unknown（fail closed）。
func classifyRedisStatement(stmt string) stmtVerdict {
	toks, err := tokenizeRedis(stmt)
	if err != nil || len(toks) == 0 {
		return stmtVerdict{class: classWrite, unknown: true}
	}
	head := strings.ToLower(string(toks[0]))
	if head == "config" && len(toks) > 1 && strings.ToLower(string(toks[1])) == "get" {
		return stmtVerdict{class: classRead}
	}
	if head == "config" {
		return stmtVerdict{class: classWrite, danger: true}
	}
	if redisCtrlCmds[head] {
		return stmtVerdict{class: classCtrl}
	}
	if redisDangerCmds[head] {
		return stmtVerdict{class: classWrite, danger: true}
	}
	if redisReadCmds[head] {
		return stmtVerdict{class: classRead}
	}
	if redisWriteCmds[head] {
		return stmtVerdict{class: classWrite}
	}
	return stmtVerdict{class: classWrite, unknown: true}
}
