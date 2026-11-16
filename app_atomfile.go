package main

// writeFileAtomic / writeFileAtomicMode 已下沉 internal/atomfile；这两行薄包装供
// 仍在 main 的调用点过渡（sessionstore 引擎 B3 下沉、ai_catalog.go 有未落线的
// 进行中改动），其落地后改为直接调 atomfile 并删除本文件。

import (
	"os"

	"datalens/internal/atomfile"
)

func writeFileAtomic(path string, data []byte) error {
	return atomfile.WriteFileAtomic(path, data)
}

func writeFileAtomicMode(path string, data []byte, mode os.FileMode) error {
	return atomfile.WriteFileAtomicMode(path, data, mode)
}
