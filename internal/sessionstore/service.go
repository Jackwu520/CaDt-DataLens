package sessionstore

// Service：AI 会话存储的 Wails 绑定层，main.App 以服务嵌入（方法名与原壳一致）。

import (
	"fmt"
	"os"
	"path/filepath"

	"datalens/internal/fileio"
	"datalens/internal/fsops"
)

// 派生搜索索引的标脏钩子：宿主（main）注入，引擎不依赖 sessionindex。
var (
	OnBodyChange func(id string)
	OnMetaChange func(id, metaJSON string)
	OnRemove     func(id string)
	OnClear      func()
)

// Service 是 AI 会话存储的绑定入口；每个方法都在成功后通知派生索引标脏钩子
// （OnBodyChange / OnMetaChange / OnRemove / OnClear），引擎本身不依赖 sessionindex。
type Service struct{}

func (s *Service) store() (*Store, error) {
	return Default()
}

func (s *Service) AISessionStoreRoot() (string, error) {
	store, err := s.store()
	if err != nil {
		return "", err
	}
	if err := store.EnsureRoot(); err != nil {
		return "", err
	}
	return store.Root, nil
}

// AISessionList 返回各会话 meta.json 的原始 JSON 字符串（列表页只需这些摘要）。
func (s *Service) AISessionList() ([]string, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	return store.List()
}

func (s *Service) AISessionRead(id string) (string, error) {
	store, err := s.store()
	if err != nil {
		return "", err
	}
	return store.Read(id)
}

func (s *Service) AISessionAppend(id string, lines string, allowCreate bool) error {
	store, err := s.store()
	if err != nil {
		return err
	}
	if err := store.AppendWithCreate(id, lines, allowCreate); err != nil {
		return err
	}
	if OnBodyChange != nil {
		OnBodyChange(id)
	}
	return nil
}

func (s *Service) AISessionRewrite(id string, content string) error {
	store, err := s.store()
	if err != nil {
		return err
	}
	if err := store.Rewrite(id, content); err != nil {
		return err
	}
	if OnBodyChange != nil {
		OnBodyChange(id)
	}
	return nil
}

func (s *Service) AISessionWriteMeta(id string, data string) error {
	store, err := s.store()
	if err != nil {
		return err
	}
	if err := store.WriteMeta(id, data); err != nil {
		return err
	}
	if OnMetaChange != nil {
		OnMetaChange(id, data)
	}
	return nil
}

// AISessionSaveImage 把会话图片写进 <id>/images/，返回相对路径 images/<name>。
// 写盘走 withSessionLock：别的窗口正在跑这个会话时返回 ErrSessionBusy。
func (s *Service) AISessionSaveImage(id, name, dataURL string) (string, error) {
	store, err := s.store()
	if err != nil {
		return "", err
	}
	path, err := store.ImagePath(id, name)
	if err != nil {
		return "", err
	}
	if len(dataURL) > 16<<20 {
		return "", fmt.Errorf("图片数据过大（>16 MB）")
	}
	err = store.withSessionLock(id, true, func(dir string) error {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return (&fsops.FS{}).SaveDataURL(path, dataURL)
	})
	if err != nil {
		return "", err
	}
	return ImagesDir + "/" + name, nil
}

// AISessionReadImage 读取会话图片为 data URL；name 只允许单个文件名，拒绝路径穿越。
func (s *Service) AISessionReadImage(id, name string) (string, error) {
	store, err := s.store()
	if err != nil {
		return "", err
	}
	path, err := store.ImagePath(id, name)
	if err != nil {
		return "", err
	}
	return (&fileio.Files{}).ReadImageAsDataURL(path)
}

// AISessionSaveVideo 会话视频落盘（与图片同构，落 <id>/videos/）。视频单文件大，
// dataURL 上限放宽到 24 MB，与传输层 aiMaxVideoBase64 对齐；name 由前端 safeVideoName 生成（<id>.mp4）。
func (s *Service) AISessionSaveVideo(id, name, dataURL string) (string, error) {
	store, err := s.store()
	if err != nil {
		return "", err
	}
	path, err := store.VideoPath(id, name)
	if err != nil {
		return "", err
	}
	if len(dataURL) > 24<<20 {
		return "", fmt.Errorf("视频数据过大（>24 MB）")
	}
	err = store.withSessionLock(id, true, func(dir string) error {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return (&fsops.FS{}).SaveDataURL(path, dataURL)
	})
	if err != nil {
		return "", err
	}
	return VideosDir + "/" + name, nil
}

// AISessionReadVideo 读取会话视频为 data URL；name 只允许单个文件名，拒绝路径穿越。
func (s *Service) AISessionReadVideo(id, name string) (string, error) {
	store, err := s.store()
	if err != nil {
		return "", err
	}
	path, err := store.VideoPath(id, name)
	if err != nil {
		return "", err
	}
	return (&fileio.Files{}).ReadVideoAsDataURL(path)
}

func (s *Service) AISessionDelete(id string) error {
	store, err := s.store()
	if err != nil {
		return err
	}
	if err := store.Remove(id); err != nil {
		return err
	}
	if OnRemove != nil {
		OnRemove(id)
	}
	return nil
}

func (s *Service) AISessionDeleteAll() error {
	store, err := s.store()
	if err != nil {
		return err
	}
	if err := store.RemoveAll(); err != nil {
		return err
	}
	if OnClear != nil {
		OnClear()
	}
	return nil
}
