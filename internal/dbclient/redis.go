// redis.go：自写精简 RESP2 客户端——Redis 是独立子系统（方案 §5.4，单独立项），
// 语义不进 SQL 型 Driver 接口（driver.go 声明）；会话走 openSession 的 kindRedis 分派。
//
// 范围刻意收敛：浏览面只需约 20 条命令 + 一条通用管线，单连接串行（浏览 + 控制台），
// 不需要 go-redis 的池化/Cluster/RESP3。后续如有真实需求（Cluster/Pub-Sub/RESP3）
// 可替换 go-redis/v9（约 +1 MB，体积已批）——替换面只有本文件的 dialRedis/cmd/pipeline。
package dbclient

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// redisDialTimeout 建连（含 AUTH/SELECT/PING 握手）的总超时。
const redisDialTimeout = 5 * time.Second

// redisClient 单个 RESP2 连接：全命令串行（mu 保护），RESP 编解码二进制安全（全程 []byte）。
type redisClient struct {
	conn net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer
	mu   sync.Mutex
}

// dialRedis 建连并完成 AUTH → SELECT → PING 握手；不支持 Cluster/Sentinel/TLS。
func dialRedis(addr, username, password string, db int) (*redisClient, error) {
	conn, err := net.DialTimeout("tcp", addr, redisDialTimeout)
	if err != nil {
		return nil, fmt.Errorf("Redis 连接失败（%s）：%w", addr, err)
	}
	c := &redisClient{
		conn: conn,
		br:   bufio.NewReaderSize(conn, 64*1024),
		bw:   bufio.NewWriter(conn),
	}
	// 握手各步走 cmd 内置的 queryTimeout deadline；总时长由 redisDialTimeout 约束不到的部分
	// （TCP connect）已在上面的 DialTimeout 兜住
	if password != "" {
		args := [][]byte{[]byte("AUTH"), []byte(password)}
		if username != "" {
			args = [][]byte{[]byte("AUTH"), []byte(username), []byte(password)} // Redis 6+ ACL
		}
		if _, err := c.cmd(context.Background(), args...); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("Redis 认证失败：%w", err)
		}
	}
	if db > 0 {
		if _, err := c.cmd(context.Background(), []byte("SELECT"), []byte(strconv.Itoa(db))); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("Redis 切换数据库 db%d 失败：%w", db, err)
		}
	}
	if _, err := c.cmd(context.Background(), []byte("PING")); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("Redis 握手失败（PING）：%w", err)
	}
	_ = conn.SetDeadline(time.Time{}) // 握手完清掉，交给每次命令的 ctx deadline
	return c, nil
}

// cmd 执行一条命令并返回回复；ctx 超时/取消经连接 deadline 生效（RESP 无服务端取消，
// 到期后这条连接可能处于未同步状态——报错路径统一 Close 连接，会话重建承担重连代价）。
func (c *redisClient) cmd(ctx context.Context, args ...[]byte) (any, error) {
	out, err := c.pipeline(ctx, [][][]byte{args})
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

// pipeline 一次写多条命令、按序读回复（串行连接上的标准 pipeline）。
// 返回值与 cmds 一一对应；任一环节失败整体报错并关闭连接（状态不再可信）。
func (c *redisClient) pipeline(ctx context.Context, cmds [][][]byte) ([]any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// deadline：ctx 有截止时间用之；ctx 取消经 watcher 提前触发
	timeout := queryTimeout
	if d, ok := ctx.Deadline(); ok {
		timeout = time.Until(d)
		if timeout <= 0 {
			return nil, ctx.Err()
		}
	}
	_ = c.conn.SetDeadline(time.Now().Add(timeout))
	stop := watchCtxCancel(ctx, c.conn)
	defer stop()

	for _, args := range cmds {
		if len(args) == 0 {
			return nil, errors.New("Redis 命令为空")
		}
	}
	for _, args := range cmds {
		if err := c.writeCommand(args); err != nil {
			_ = c.conn.Close()
			return nil, fmt.Errorf("Redis 命令发送失败：%w", err)
		}
	}
	if err := c.bw.Flush(); err != nil {
		_ = c.conn.Close()
		return nil, fmt.Errorf("Redis 命令发送失败：%w", err)
	}
	out := make([]any, len(cmds))
	for i := range cmds {
		reply, err := c.readReply()
		if err != nil {
			_ = c.conn.Close()
			return nil, err
		}
		out[i] = reply
	}
	return out, nil
}

// watchCtxCancel ctx 取消时把 deadline 拨到过去强制中断阻塞中的读写（RESP 无服务端取消）。
func watchCtxCancel(ctx context.Context, conn net.Conn) (stop func()) {
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.SetDeadline(time.Unix(1, 0)) // 已过去的时刻：未完成的读写立刻报 i/o timeout
		case <-done:
		}
		close(stopped)
	}()
	return func() {
		close(done)
		<-stopped
	}
}

// writeCommand 编码并写入一条 RESP 数组命令（未 Flush，pipeline 批量写出）。
func (c *redisClient) writeCommand(args [][]byte) error {
	if err := c.writeLine("*" + strconv.Itoa(len(args))); err != nil {
		return err
	}
	for _, a := range args {
		if err := c.writeLine("$" + strconv.Itoa(len(a))); err != nil {
			return err
		}
		if _, err := c.bw.Write(a); err != nil {
			return err
		}
		if err := c.writeLine(""); err != nil { // bulk string 结尾 CRLF
			return err
		}
	}
	return nil
}

func (c *redisClient) writeLine(s string) error {
	if _, err := c.bw.WriteString(s); err != nil {
		return err
	}
	_, err := c.bw.WriteString("\r\n")
	return err
}

// readReply 解析一个 RESP2 回复：+simple / -error / :integer / $bulk / *array（$-1 / *-1 → nil）。
func (c *redisClient) readReply() (any, error) {
	line, err := c.readLine()
	if err != nil {
		return nil, err
	}
	if line == "" {
		return nil, errors.New("Redis 回复为空")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		// 服务器命令错误（-ERR …）：作为回复值返回（不中断 pipeline、连接仍可用）；
		// 调用方用 errors.As(*respError) 区分「命令失败」与「IO/协议失败」。
		return &respError{msg: classifyRedisErrorText(line[1:])}, nil
	case ':':
		n, err := strconv.ParseInt(line[1:], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("Redis 整数回复无法解析：%s", line)
		}
		return n, nil
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, fmt.Errorf("Redis bulk 回复无法解析：%s", line)
		}
		if n < 0 {
			return nil, nil
		}
		buf := make([]byte, n+2) // 数据 + CRLF
		if _, err := ioReadFull(c.br, buf); err != nil {
			return nil, fmt.Errorf("Redis bulk 回复不完整：%w", err)
		}
		return buf[:n], nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, fmt.Errorf("Redis 数组回复无法解析：%s", line)
		}
		if n < 0 {
			return nil, nil
		}
		out := make([]any, n)
		for i := range out {
			v, err := c.readReply()
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	default:
		return nil, fmt.Errorf("Redis 回复协议异常：%q", line)
	}
}

func (c *redisClient) readLine() (string, error) {
	s, err := c.br.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("Redis 回复读取失败：%w", err)
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// respError 服务器命令错误回复（-ERR …）：作为该命令的回复值（pipeline 不中断、连接仍可用）。
type respError struct{ msg string }

func (e *respError) Error() string { return e.msg }

// classifyRedisErrorText 服务器错误文本：Cluster 类错误给出明确指引，其余原样透出。
func classifyRedisErrorText(msg string) string {
	head := ""
	if fields := strings.Fields(msg); len(fields) > 0 {
		head = strings.ToUpper(fields[0])
	}
	switch head {
	case "MOVED", "ASK", "CLUSTERDOWN", "CROSSSLOT":
		return head + "（本工具不支持 Redis Cluster；请直连单节点）：" + msg
	case "NOAUTH", "WRONGPASS", "EPERM":
		return "认证/权限被拒：" + msg
	}
	return msg
}

// Close 断开连接（net.Conn.Close 幂等；串行互斥靠调用方纪律与 mu）。
func (c *redisClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Close()
}

// ioReadFull 循环读满 buf（bufio.Reader 没有等价物，不为此引 io 包依赖面）。
func ioReadFull(r *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
