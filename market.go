package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	pluginMarketOrg       = "cadt-datalens-plugins"
	pluginMarketUserAgent = "CaDt-DataLens-PluginMarket/1.0"
	// 数据源：Gitee 组织（默认）与 GitHub 镜像组织，两边仓库同名。
	marketSourceGitee  = "gitee"
	marketSourceGithub = "github"
)

// normalizeMarketSource 只认 gitee/github 两个值（大小写与空格不敏感），其余一律归一为默认的 gitee。
func normalizeMarketSource(source string) string {
	if strings.EqualFold(strings.TrimSpace(source), marketSourceGithub) {
		return marketSourceGithub
	}
	return marketSourceGitee
}

// currentMarketSource 读应用配置，返回本次抓取应使用的数据源。
func currentMarketSource() string {
	return normalizeMarketSource(readAppConfig().DataSource)
}

func marketSourceLabel(source string) string {
	if normalizeMarketSource(source) == marketSourceGithub {
		return "GitHub"
	}
	return "Gitee"
}

// otherMarketSourceLabel 403 限流提示里给用户的备选源名。
func otherMarketSourceLabel(source string) string {
	if normalizeMarketSource(source) == marketSourceGithub {
		return "Gitee"
	}
	return "GitHub"
}

func marketSiteHost(source string) string {
	if normalizeMarketSource(source) == marketSourceGithub {
		return "github.com"
	}
	return "gitee.com"
}

// marketReposPageURL 组织公开仓库列表接口；Gitee 走 v5 API，GitHub 走 REST。
func marketReposPageURL(source string, page int) string {
	if normalizeMarketSource(source) == marketSourceGithub {
		return fmt.Sprintf("https://api.github.com/orgs/%s/repos?sort=updated&direction=desc&per_page=100&page=%d", pluginMarketOrg, page)
	}
	return fmt.Sprintf("https://gitee.com/api/v5/orgs/%s/repos?type=public&sort=updated&direction=desc&per_page=100&page=%d", pluginMarketOrg, page)
}

// marketManifestURL 仓库根 plugin.json 的 raw 地址。
func marketManifestURL(source, fullName, branch string) string {
	if normalizeMarketSource(source) == marketSourceGithub {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/plugin.json", fullName, branch)
	}
	return fmt.Sprintf("https://gitee.com/%s/raw/%s/plugin.json", fullName, branch)
}

// marketDefaultBranch 接口没给 default_branch 时的兜底分支名。
func marketDefaultBranch(source string) string {
	if normalizeMarketSource(source) == marketSourceGithub {
		return "main"
	}
	return "master"
}

var (
	marketRepoPattern   = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	marketBranchPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	marketHTTPClient    = &http.Client{Timeout: 12 * time.Second}
)

type MarketPlugin struct {
	Id               string `json:"id,omitempty"`
	Name             string `json:"name"`
	Version          string `json:"version,omitempty"`
	Author           string `json:"author,omitempty"`
	Description      string `json:"description,omitempty"`
	Repo             string `json:"repo"`
	Url              string `json:"url"`
	UpdatedAt        string `json:"updatedAt,omitempty"`
	Stars            int    `json:"stars"`
	MinAppVersion    string `json:"minAppVersion,omitempty"`
	ManifestOk       bool   `json:"manifestOk"`
	Installed        bool   `json:"installed"`
	InstalledVersion string `json:"installedVersion,omitempty"`
}

type marketRepo struct {
	FullName        string `json:"full_name"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	DefaultBranch   string `json:"default_branch"`
	StargazersCount int    `json:"stargazers_count"`
	UpdatedAt       string `json:"updated_at"`
}

type marketManifest struct {
	Id            string `json:"id"`
	Name          string `json:"name"`
	Version       string `json:"version"`
	Author        string `json:"author"`
	Description   string `json:"description"`
	MinAppVersion string `json:"minAppVersion"`
}

// GetPluginMarket 按当前数据源（Gitee/GitHub）列出组织里的公开插件仓库，并合并各仓库 plugin.json 的元数据。
func (a *App) GetPluginMarket() ([]*MarketPlugin, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	source := currentMarketSource()
	repos, err := fetchMarketRepos(ctx, source)
	if err != nil {
		return nil, err
	}
	installed := map[string]string{}
	if plugins, err := a.GetPlugins(); err == nil {
		for _, p := range plugins {
			installed[p.Id] = p.Version
		}
	}
	items := make([]*MarketPlugin, len(repos))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for i, repo := range repos {
		item := &MarketPlugin{
			Repo:        repo.FullName,
			Name:        repo.Name,
			Description: strings.TrimSpace(repo.Description),
			Url:         marketRepoURLFor(source, repo.FullName),
			UpdatedAt:   repo.UpdatedAt,
			Stars:       repo.StargazersCount,
		}
		items[i] = item
		wg.Add(1)
		go func(item *MarketPlugin, repo marketRepo) {
			defer wg.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			if manifest, ok := fetchMarketManifest(ctx, source, repo); ok {
				applyMarketManifest(item, manifest)
			}
		}(item, repo)
	}
	wg.Wait()
	for _, item := range items {
		markMarketInstalled(item, installed)
	}
	return items, nil
}

func fetchMarketRepos(ctx context.Context, source string) ([]marketRepo, error) {
	label := marketSourceLabel(source)
	var repos []marketRepo
	for page := 1; page <= 5; page++ {
		url := marketReposPageURL(source, page)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", pluginMarketUserAgent)
		req.Header.Set("Accept", "application/json")
		res, err := marketHTTPClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("连接 %s 失败：%w", label, err)
		}
		body, readErr := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		res.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("读取 %s 响应失败：%w", label, readErr)
		}
		if res.StatusCode == http.StatusForbidden {
			return nil, fmt.Errorf("%s 匿名接口限流（HTTP 403）：稍后点「刷新」重试，或在 设置 → 插件 把数据源切到 %s", label, otherMarketSourceLabel(source))
		}
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("%s 返回 HTTP %d", label, res.StatusCode)
		}
		var batch []marketRepo
		if err := json.Unmarshal(body, &batch); err != nil {
			return nil, fmt.Errorf("%s 响应格式异常：%w", label, err)
		}
		repos = append(repos, batch...)
		if len(batch) < 100 {
			break
		}
	}
	return repos, nil
}

func fetchMarketManifest(ctx context.Context, source string, repo marketRepo) (marketManifest, bool) {
	if !validMarketRepo(repo.FullName) {
		return marketManifest{}, false
	}
	branch := strings.TrimSpace(repo.DefaultBranch)
	if branch == "" {
		branch = marketDefaultBranch(source)
	}
	if !validMarketBranch(branch) {
		return marketManifest{}, false
	}
	url := marketManifestURL(source, repo.FullName, branch)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return marketManifest{}, false
	}
	req.Header.Set("User-Agent", pluginMarketUserAgent)
	res, err := marketHTTPClient.Do(req)
	if err != nil {
		return marketManifest{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return marketManifest{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 512<<10))
	if err != nil {
		return marketManifest{}, false
	}
	var m marketManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return marketManifest{}, false
	}
	return m, true
}

// applyMarketManifest 用插件清单覆盖仓库元数据；清单缺少有效 id/name 时返回 false。
func applyMarketManifest(item *MarketPlugin, m marketManifest) bool {
	id := strings.TrimSpace(m.Id)
	name := strings.TrimSpace(m.Name)
	if !pluginIdPattern.MatchString(id) || name == "" {
		return false
	}
	item.Id = id
	item.Name = name
	item.ManifestOk = true
	if v := strings.TrimSpace(m.Version); v != "" {
		item.Version = v
	}
	if v := strings.TrimSpace(m.Author); v != "" {
		item.Author = v
	}
	if v := strings.TrimSpace(m.Description); v != "" {
		item.Description = v
	}
	item.MinAppVersion = strings.TrimSpace(m.MinAppVersion)
	return true
}

func markMarketInstalled(item *MarketPlugin, installed map[string]string) {
	if version, ok := installed[marketRepoName(item.Repo)]; ok {
		item.Installed = true
		item.InstalledVersion = version
		return
	}
	if item.Id != "" {
		if version, ok := installed[item.Id]; ok {
			item.Installed = true
			item.InstalledVersion = version
		}
	}
}

// marketRepoURL 当前数据源下的仓库主页地址。
func marketRepoURL(fullName string) string {
	return marketRepoURLFor(currentMarketSource(), fullName)
}

func marketRepoURLFor(source, fullName string) string {
	return "https://" + marketSiteHost(source) + "/" + strings.TrimSuffix(fullName, ".git")
}

func marketRepoName(fullName string) string {
	if i := strings.LastIndex(fullName, "/"); i >= 0 {
		return fullName[i+1:]
	}
	return fullName
}

func validMarketRepo(fullName string) bool {
	if !marketRepoPattern.MatchString(fullName) {
		return false
	}
	for _, seg := range strings.Split(fullName, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func validMarketBranch(branch string) bool {
	if !marketBranchPattern.MatchString(branch) {
		return false
	}
	for _, seg := range strings.Split(branch, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}
