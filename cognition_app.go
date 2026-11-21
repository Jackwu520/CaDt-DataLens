// cognition_app.go：认知索引的 Wails 绑定壳——JSON 收发与根目录校验，透传 internal/cognition。
// v3 无生成绑定：前端经 Call.ByName 动态解析；dev 模式需在 mock-backend.js 补同名 mock。
package main

import (
	"datalens/internal/applog"
	"datalens/internal/cognition"
	"encoding/json"
	"fmt"
	"os"
)

// cognitionService 无状态引擎（Deps 只含钩子），包级单例；日志走应用运行日志。
var cognitionService = cognition.New(cognition.Deps{
	Logf: func(format string, args ...any) { applog.Write("info", "cognition: "+format, args...) },
})

// cognitionValidateRoot 校验工作区根存在且是目录（路径由前端传根目录，不拼相对片段）。
func cognitionValidateRoot(ws string) error {
	info, err := os.Stat(ws)
	if err != nil {
		return fmt.Errorf("工作区根不可用：%w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("工作区根不是目录：%s", ws)
	}
	return nil
}

func (a *App) CognitionRead(workspace, reqJSON string) (string, error) {
	if err := cognitionValidateRoot(workspace); err != nil {
		return "", err
	}
	var req cognition.ReadReq
	if reqJSON != "" {
		if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
			return "", fmt.Errorf("req 解析失败：%w", err)
		}
	}
	res, err := cognitionService.Read(workspace, req)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (a *App) CognitionEdit(workspace, reqJSON string) (string, error) {
	if err := cognitionValidateRoot(workspace); err != nil {
		return "", err
	}
	var req cognition.EditReq
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return "", fmt.Errorf("req 解析失败：%w", err)
	}
	res, err := cognitionService.Edit(workspace, req)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (a *App) CognitionStatus(workspace string, verbose bool) (string, error) {
	if err := cognitionValidateRoot(workspace); err != nil {
		return "", err
	}
	res, err := cognitionService.Status(workspace, verbose)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "", err
	}
	return string(out), nil
}
