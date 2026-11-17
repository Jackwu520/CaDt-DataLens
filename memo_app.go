package main

// memo_app.go：快捷便签面板的 Wails 绑定——引擎在 internal/memo，
// 这里只注入应用数据目录并把三个绑定挂到 App 上（读 / CAS 写 / 贴图落盘）。

import "datalens/internal/memo"

func init() {
	memo.SetDeps(memo.Deps{AppDataDir: appDataRoot})
}

// MemoLoad 读一个作用域的 memo.json，返回信封 {"data":原文,"mtimeMs":N}。
func (a *App) MemoLoad(scope, workspace string) (string, error) {
	return memo.Load(scope, workspace)
}

// MemoSave 整份原子写；baseMtimeMs 为 0 表示载入时还没有文件，>0 做 CAS。
func (a *App) MemoSave(scope, workspace, doc string, baseMtimeMs int64) memo.SaveResult {
	return memo.Save(scope, workspace, doc, baseMtimeMs)
}

// MemoSaveImage 贴图 data URL 落盘，返回相对引用路径 img/xxx.png。
func (a *App) MemoSaveImage(scope, workspace, dataURL string) (string, error) {
	return memo.SaveImage(scope, workspace, dataURL)
}
