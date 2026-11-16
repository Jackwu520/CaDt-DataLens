package main

// sessionstore_app.go：AI 会话磁盘存储的 Wails 绑定——引擎在 internal/sessionstore，
// 这里只做参数整理、图片编解码接线与索引标脏副作用。

import (
	"fmt"
	"os"
	"path/filepath"

	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
)

// 宿主注入：应用数据根目录来自 appdata.go。
func init() {
	sessionstore.AppDataDir = appDataRoot
}

func defaultSessionStore() (*sessionstore.Store, error) {
	return sessionstore.Default()
}

func (a *App) AISessionStoreRoot() (string, error) {
	store, err := defaultSessionStore()
	if err != nil {
		return "", err
	}
	if err := store.EnsureRoot(); err != nil {
		return "", err
	}
	return store.Root, nil
}

// AISessionList 返回各会话 meta.json 的原始 JSON 字符串（列表页只需这些摘要）。
func (a *App) AISessionList() ([]string, error) {
	store, err := defaultSessionStore()
	if err != nil {
		return nil, err
	}
	return store.List()
}

func (a *App) AISessionRead(id string) (string, error) {
	store, err := defaultSessionStore()
	if err != nil {
		return "", err
	}
	return store.Read(id)
}

func (a *App) AISessionAppend(id string, lines string) error {
	store, err := defaultSessionStore()
	if err != nil {
		return err
	}
	if err := store.Append(id, lines); err != nil {
		return err
	}
	sessionindex.MarkDirty(id)
	return nil
}

func (a *App) AISessionRewrite(id string, content string) error {
	store, err := defaultSessionStore()
	if err != nil {
		return err
	}
	if err := store.Rewrite(id, content); err != nil {
		return err
	}
	sessionindex.MarkDirty(id)
	return nil
}

func (a *App) AISessionWriteMeta(id string, data string) error {
	store, err := defaultSessionStore()
	if err != nil {
		return err
	}
	if err := store.WriteMeta(id, data); err != nil {
		return err
	}
	sessionindex.UpdateMeta(id, data)
	return nil
}

// AISessionSaveImage 把会话图片写进 <id>/images/，返回相对路径 images/<name>。
func (a *App) AISessionSaveImage(id, name, dataURL string) (string, error) {
	store, err := defaultSessionStore()
	if err != nil {
		return "", err
	}
	path, err := store.ImagePath(id, name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if len(dataURL) > 16<<20 {
		return "", fmt.Errorf("图片数据过大（>16 MB）")
	}
	if err := a.SaveDataURL(path, dataURL); err != nil {
		return "", err
	}
	return sessionstore.ImagesDir + "/" + name, nil
}

// AISessionReadImage 读取会话图片为 data URL；name 只允许单个文件名，拒绝路径穿越。
func (a *App) AISessionReadImage(id, name string) (string, error) {
	store, err := defaultSessionStore()
	if err != nil {
		return "", err
	}
	path, err := store.ImagePath(id, name)
	if err != nil {
		return "", err
	}
	return a.ReadImageAsDataURL(path)
}

func (a *App) AISessionDelete(id string) error {
	store, err := defaultSessionStore()
	if err != nil {
		return err
	}
	if err := store.Remove(id); err != nil {
		return err
	}
	sessionindex.Delete(id)
	return nil
}

func (a *App) AISessionDeleteAll() error {
	store, err := defaultSessionStore()
	if err != nil {
		return err
	}
	if err := store.RemoveAll(); err != nil {
		return err
	}
	sessionindex.Clear()
	return nil
}
