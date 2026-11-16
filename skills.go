package main

// skills.go：内置技能资源的根壳——embed 路径相对包目录，资源本体由
// internal/skills 消费；版本与日志在同处注入。

import (
	"embed"

	"datalens/internal/skills"
)

//go:embed all:docs/skills
var skillAssets embed.FS

func init() {
	skills.Embedded = skillAssets
	skills.Version = appVersion
	skills.Logf = writeAppLog
}
