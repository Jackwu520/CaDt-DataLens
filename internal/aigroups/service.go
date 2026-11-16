// service.go：AI 群聊磁盘存储的 Wails 绑定层——App 以服务嵌入（App 结构体匿名嵌入
// *GroupStore），方法提升即绑定；根壳 groupstore_app.go 只做 AppDataDir 注入。
package aigroups

// GroupStore 群聊存储绑定（类型名避开 sessionstore.Service：App 的嵌入字段名必须唯一）。
type GroupStore struct{}

func (g *GroupStore) store() (*Store, error) { return Default() }

// AIGroupList 各群 meta.json 原文数组（与 AISessionList 同形）。
func (g *GroupStore) AIGroupList() ([]string, error) {
	st, err := g.store()
	if err != nil {
		return nil, err
	}
	return st.List()
}

// AIGroupRead 整份共享群聊对话 JSONL。
func (g *GroupStore) AIGroupRead(id string) (string, error) {
	st, err := g.store()
	if err != nil {
		return "", err
	}
	return st.Read(id)
}

// AIGroupAppend 追加群消息事件（lines 为可含多行 JSONL 的文本）。
func (g *GroupStore) AIGroupAppend(id, lines string) error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.Append(id, lines)
}

// AIGroupRewrite 原子替换共享对话。
func (g *GroupStore) AIGroupRewrite(id, content string) error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.Rewrite(id, content)
}

// AIGroupWriteMeta 原子替换群 meta.json。
func (g *GroupStore) AIGroupWriteMeta(id, data string) error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.WriteMeta(id, data)
}

// AIGroupDelete 删除群（回收站可撤销；私有日志随群目录一起删）。
func (g *GroupStore) AIGroupDelete(id string) error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.Remove(id)
}

// AIGroupDeleteAll 清空全部群聊（存储清理用；整根进回收站）。
func (g *GroupStore) AIGroupDeleteAll() error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.RemoveAll()
}

// AIGroupPrivateRead 读成员私有过程日志（不存在返回空串）。
func (g *GroupStore) AIGroupPrivateRead(groupID, agentID string) (string, error) {
	st, err := g.store()
	if err != nil {
		return "", err
	}
	return st.PrivateRead(groupID, agentID)
}

// AIGroupPrivateAppend 追加成员私有过程步骤（JSONL 文本）。
func (g *GroupStore) AIGroupPrivateAppend(groupID, agentID, lines string) error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.PrivateAppend(groupID, agentID, lines)
}

// AIGroupPrivateRewrite 原子替换成员私有过程日志。
func (g *GroupStore) AIGroupPrivateRewrite(groupID, agentID, content string) error {
	st, err := g.store()
	if err != nil {
		return err
	}
	return st.PrivateRewrite(groupID, agentID, content)
}
