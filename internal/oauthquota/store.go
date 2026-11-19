package oauthquota

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/dpapi"
)

// storedGrant 是落盘形态：refresh token 是长期凭据，access token 只是顺带缓存。
// 用户名也存（续期失败需要提示重新登录时显示是谁）。密码永不落盘。
type storedGrant struct {
	Username     string `json:"username"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    int64  `json:"expiresAt"` // unix seconds
}

const sealedPrefix = "enc:v1:"

// ErrNoCredential 表示没登录过。
var ErrNoCredential = errors.New("没有 OAuth 登录凭据")

func credentialsPath(providerID string) string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	// provider id 已是内置常量（防路径穿越），仍加一层清洗兜底
	id := strings.NewReplacer("/", "_", "\\", "_", "..", "_").Replace(providerID)
	if id == "" {
		id = "default"
	}
	return filepath.Join(root, "oauth-"+id+"-credentials.json")
}

// LoadCredential 读取本地凭据。DPAPI 密文解不开时返回 ErrDecrypt（绝不当空配置覆盖）。
func LoadCredential(providerID string) (storedGrant, error) {
	path := credentialsPath(providerID)
	if path == "" {
		return storedGrant{}, ErrNoCredential
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return storedGrant{}, ErrNoCredential
		}
		return storedGrant{}, err
	}
	text := strings.TrimSpace(string(raw))
	if strings.HasPrefix(text, sealedPrefix) {
		if !dpapi.Supported() {
			return storedGrant{}, dpapi.ErrDecrypt
		}
		plain, err := dpapi.Unprotect(strings.TrimPrefix(text, sealedPrefix))
		if err != nil {
			return storedGrant{}, err
		}
		text = plain
	}
	var stored storedGrant
	if err := json.Unmarshal([]byte(text), &stored); err != nil {
		return storedGrant{}, err
	}
	return stored, nil
}

// SaveCredential 写凭据：Windows 用 DPAPI 加密，其他平台明文（与 envvars / aiconfig 一致）。
func SaveCredential(providerID string, stored storedGrant) error {
	path := credentialsPath(providerID)
	if path == "" {
		return errors.New("应用数据目录不可用")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	text := string(raw)
	if dpapi.Supported() {
		sealed, err := dpapi.Protect(text, "SenseNova 控制台凭据")
		if err != nil {
			return err
		}
		text = sealedPrefix + sealed
	}
	return atomfile.WriteFileAtomicMode(path, []byte(text), 0o600)
}

// ClearCredential 删除本地凭据（登出）。
func ClearCredential(providerID string) error {
	path := credentialsPath(providerID)
	if path == "" {
		return nil
	}
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// freshAccessToken 返回可用 access token：缓存新鲜则直接用，否则 refresh 轮转并回写。
// 401 由调用方收到后调 invalidateAndRefresh 强制续期。
func freshAccessToken(p Provider) (string, error) {
	stored, err := LoadCredential(p.ID)
	if err != nil {
		return "", err
	}
	if stored.AccessToken != "" && stored.ExpiresAt > time.Now().Add(tokenSkewSeconds*time.Second).Unix() {
		return stored.AccessToken, nil
	}
	if stored.RefreshToken == "" {
		return "", errors.New("凭据已过期且没有 refresh token，请重新登录")
	}
	refreshed, err := Refresh(p, stored.RefreshToken)
	if err != nil {
		return "", err
	}
	stored.AccessToken = refreshed.AccessToken
	stored.RefreshToken = refreshed.RefreshToken
	stored.ExpiresAt = refreshed.ExpiresAt.Unix()
	if err := SaveCredential(p.ID, stored); err != nil {
		return "", err
	}
	return refreshed.AccessToken, nil
}

// invalidateAndRefresh 在 401/403 时强制丢弃当前 access token 再续期一次。
func invalidateAndRefresh(p Provider) (string, error) {
	stored, err := LoadCredential(p.ID)
	if err != nil {
		return "", err
	}
	stored.AccessToken = ""
	if err := SaveCredential(p.ID, stored); err != nil {
		return "", err
	}
	return freshAccessToken(p)
}
