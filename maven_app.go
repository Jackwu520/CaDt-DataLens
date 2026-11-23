package main

// maven_app.go：Maven 工具窗口的 Wails 绑定——引擎在 internal/mavenproject。

import "datalens/internal/mavenproject"

// MavenProjectInfo 读工作区 Maven 项目结构（pom 元数据 + 模块树 + settings.xml 位置），纯文件读取。
func (a *App) MavenProjectInfo(root string) (*mavenproject.ProjectInfo, error) {
	return mavenproject.ReadProject(root)
}

// MavenData 起一条 mvn 数据命令（kind：effective-pom / effective-settings / dependency-tree），
// 返回原始文本，解析在前端。moduleRelPath 非空时加 -pl（仅对支持该参数的目标生效）。
func (a *App) MavenData(workspaceRoot, mvnPath string, timeoutMs int, kind, moduleRelPath string) (string, error) {
	return mavenproject.RunData(workspaceRoot, mvnPath, timeoutMs, kind, moduleRelPath)
}
