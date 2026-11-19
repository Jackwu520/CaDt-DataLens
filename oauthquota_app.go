package main

// oauthquota_app.go：通用 OAuth 额度查询的 Wails 绑定——引擎在 internal/oauthquota，
// 密码只在登录瞬间传入不落盘，refresh token 按 providerID 存 DPAPI 加密文件。
// providerID 由前端模板指定（当前内置 sensenova），新增服务商不用改绑定。

import "datalens/internal/oauthquota"

// AIOAuthQuotaProviders 返回可登录的 OAuth provider 列表（id/name）。
func (a *App) AIOAuthQuotaProviders() []struct {
	ID   string `json:"id"`
	Name string `json:"name"`
} {
	return oauthquota.Providers()
}

// AIOAuthQuotaLogin 账号密码登录 + 保存凭据（只回用户名/过期时间，不回 token）。
func (a *App) AIOAuthQuotaLogin(providerID, username, password string) oauthquota.LoginResult {
	result, err := oauthquota.LoginAndSave(providerID, username, password)
	if err != nil {
		return oauthquota.LoginResult{Error: err.Error()}
	}
	return result
}

// AIOAuthQuotaStatus 读登录状态（不回 token）。
func (a *App) AIOAuthQuotaStatus(providerID string) oauthquota.StatusResult {
	result, err := oauthquota.Status(providerID)
	if err != nil {
		return oauthquota.StatusResult{Error: err.Error()}
	}
	return result
}

// AIOAuthQuotaLogout 清除指定 provider 的凭据。
func (a *App) AIOAuthQuotaLogout(providerID string) string {
	if err := oauthquota.Logout(providerID); err != nil {
		return err.Error()
	}
	return ""
}

// AIOAuthQuotaFetch 带 OAuth token 发一次 GET（token 自动续期），响应原样回前端
// extractor 解析。URL 必须落在 provider 的 ConsoleOrigin 下。
func (a *App) AIOAuthQuotaFetch(providerID, rawURL string) oauthquota.FetchResult {
	result, err := oauthquota.Fetch(providerID, rawURL)
	if err != nil {
		return oauthquota.FetchResult{Error: err.Error()}
	}
	return result
}
