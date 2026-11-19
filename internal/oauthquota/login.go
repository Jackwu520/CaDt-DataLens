package oauthquota

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// grant 是一次 OIDC 登录/刷新拿到的凭据对。
type grant struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

type tokenReply struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

// client 带共享 cookie jar：authorize → IAM login → callback 的世界跳需要同一份
// CSRF cookie；用 jar 自动带 cookie，手工处理重定向（跨主机 + 部分跳转写在 body 里）。
func newClient(p Provider) (*http.Client, error) {
	jar, err := newCookieJar()
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Jar:     jar,
		Timeout: requestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse // 手工跟，跨主机且要扫 body
		},
	}, nil
}

// cookieJar 是一个极简的 name=value jar（按 host 存，忽略 path/domain/secure 的细粒度
// 规则——dsh 插件也是 name/value 单层 map，Hydra 的 CSRF cookie 足够）。
type cookieJar struct {
	values map[string]map[string]string // host → name → value
}

func newCookieJar() (*cookieJar, error) {
	return &cookieJar{values: make(map[string]map[string]string)}, nil
}

func (j *cookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	m := j.values[u.Host]
	if m == nil {
		m = make(map[string]string)
		j.values[u.Host] = m
	}
	for _, c := range cookies {
		m[c.Name] = c.Value
	}
}

func (j *cookieJar) Cookies(u *url.URL) []*http.Cookie {
	m := j.values[u.Host]
	out := make([]*http.Cookie, 0, len(m))
	for name, value := range m {
		out = append(out, &http.Cookie{Name: name, Value: value})
	}
	return out
}

// doGet 手工 GET（禁自动重定向），返回原始响应供 walk 检查 Location。
func doGet(client *http.Client, target string, p Provider) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", p.UserAgent)
	req.Header.Set("Accept", "*/*")
	return client.Do(req)
}

func paramOf(rawURL, name string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Query().Get(name)
}

// nextFromBody 从 200 响应体里挖下一条跳转（部分控制台切换是客户端做的，没有 Location）。
func nextFromBody(body string) string {
	for _, match := range urlInBodyRe.FindAllString(body, -1) {
		if loginChallengeRe.MatchString(match) || authCodeRe.MatchString(match) {
			return htmlUnescape(match)
		}
	}
	if meta := metaRefreshRe.FindStringSubmatch(body); len(meta) > 1 {
		return htmlUnescape(meta[1])
	}
	for _, re := range jsLocationRes {
		if found := re.FindStringSubmatch(body); len(found) > 1 {
			return htmlUnescape(found[1])
		}
	}
	return ""
}

func htmlUnescape(text string) string {
	text = strings.ReplaceAll(text, "&amp;", "&")
	text = strings.ReplaceAll(text, "&#39;", "'")
	return strings.ReplaceAll(text, "&quot;", "\"")
}

// followUntil 跟随跳转链直到 URL 命中 wanted（用共享 jar 带 cookie），返回命中 URL。
func followUntil(client *http.Client, start string, wanted *regexp.Regexp, p Provider) (string, error) {
	location := start
	for hop := 0; hop < maxRedirectHops && location != ""; hop++ {
		if wanted.MatchString(location) {
			return location, nil
		}
		resp, err := doGet(client, location, p)
		if err != nil {
			return "", err
		}
		next := resp.Header.Get("Location")
		body := ""
		if next == "" {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			body = string(raw)
		}
		resp.Body.Close()
		if next == "" {
			next = nextFromBody(body)
		}
		location = next
	}
	if wanted.MatchString(location) {
		return location, nil
	}
	return "", errors.New("跳转链耗尽，未拿到目标参数")
}

// Login 用账号密码登录 SenseNova 控制台，返回 access/refresh token 对。
// 密码经 JWKS 公钥封成 JWE 后发出，明文不写日志、不落盘；本函数只发这一处 POST。
func Login(p Provider, username, password string) (grant, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return grant{}, errors.New("账号与密码不能为空")
	}
	verifier, challenge, err := pkcePair()
	if err != nil {
		return grant{}, err
	}
	nonce, err := randomNonce()
	if err != nil {
		return grant{}, err
	}
	client, err := newClient(p)
	if err != nil {
		return grant{}, err
	}

	authURL := p.ConsoleOrigin + "/oauth2/auth?" + url.Values{
		"client_id":             {p.ClientID},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"redirect_uri":          {p.RedirectURI},
		"response_type":         {"code"},
		"scope":                 {p.Scope},
		"state":                 {nonce},
	}.Encode()
	challengeURL, err := followUntil(client, authURL, loginChallengeRe, p)
	if err != nil {
		return grant{}, fmt.Errorf("拿登录挑战失败：%w", err)
	}
	loginChallenge := paramOf(challengeURL, "login_challenge")
	if loginChallenge == "" {
		return grant{}, errors.New("没有 login_challenge")
	}

	sealed, err := sealPassword(password, p)
	if err != nil {
		return grant{}, fmt.Errorf("密码加密失败：%w", err)
	}
	iamBody, _ := json.Marshal(map[string]any{
		"username":   username,
		"password":   sealed,
		"challenge":  loginChallenge,
		"is_encrypt": true,
	})
	req, err := http.NewRequest(http.MethodPost, p.IAMOrigin+p.IAMLoginPath, strings.NewReader(string(iamBody)))
	if err != nil {
		return grant{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", p.UserAgent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", p.ConsoleOrigin)
	req.Header.Set("Referer", p.ConsoleOrigin+"/")
	resp, err := client.Do(req)
	if err != nil {
		return grant{}, err
	}
	iamRaw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return grant{}, fmt.Errorf("IAM 登录 HTTP %d：%s", resp.StatusCode, snippet(string(iamRaw)))
	}
	var iamReply struct {
		Redirect string `json:"redirect"`
	}
	if err := json.Unmarshal(iamRaw, &iamReply); err != nil || iamReply.Redirect == "" {
		return grant{}, fmt.Errorf("IAM 未返回回调地址：%s", snippet(string(iamRaw)))
	}

	codeURL, err := followUntil(client, iamReply.Redirect, authCodeRe, p)
	if err != nil {
		return grant{}, fmt.Errorf("拿授权码失败：%w", err)
	}
	if got := paramOf(codeURL, "state"); got != nonce {
		return grant{}, errors.New("回调 state 不匹配（拒绝跨流程授权码）")
	}
	code := paramOf(codeURL, "code")
	if code == "" {
		return grant{}, errors.New("没有授权码")
	}

	return exchangeToken(p, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"client_id":     {p.ClientID},
		"redirect_uri":  {p.RedirectURI},
		"scope":         {p.Scope},
	})
}

// Refresh 用 refresh token 换新 token 对（Hydra 会轮转 refresh token，必须回写新值）。
func Refresh(p Provider, refreshToken string) (grant, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return grant{}, errors.New("没有 refresh token")
	}
	return exchangeToken(p, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {p.ClientID},
		"scope":         {p.Scope},
	})
}

func exchangeToken(p Provider, form url.Values) (grant, error) {
	client := &http.Client{Timeout: requestTimeout}
	req, err := http.NewRequest(http.MethodPost, p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return grant{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", p.UserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return grant{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var reply tokenReply
	_ = json.Unmarshal(raw, &reply)
	if reply.AccessToken == "" {
		detail := reply.Description
		if detail == "" {
			detail = reply.Error
		}
		if detail == "" {
			detail = snippet(string(raw))
		}
		return grant{}, fmt.Errorf("token 端点拒绝（HTTP %d）：%s", resp.StatusCode, detail)
	}
	lifetime := reply.ExpiresIn
	if lifetime <= 0 {
		lifetime = 10800 // 平台 JWT 3 小时
	}
	return grant{
		AccessToken:  reply.AccessToken,
		RefreshToken: reply.RefreshToken,
		ExpiresAt:    time.Now().Add(time.Duration(lifetime) * time.Second),
	}, nil
}

func snippet(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > 200 {
		return text[:200] + "…"
	}
	return text
}
