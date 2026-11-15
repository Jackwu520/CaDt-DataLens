package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestMarketRepoIdentity(t *testing.T) {
	t.Setenv("AppData", t.TempDir()) // 隔离真实配置，默认数据源 gitee
	if got := marketRepoURL("cadt-datalens-plugins/bak-json"); got != "https://gitee.com/cadt-datalens-plugins/bak-json" {
		t.Fatalf("marketRepoURL = %q", got)
	}
	if got := marketRepoURL("cadt-datalens-plugins/bak-json.git"); got != "https://gitee.com/cadt-datalens-plugins/bak-json" {
		t.Fatalf("marketRepoURL(.git) = %q", got)
	}
	if got := marketRepoName("cadt-datalens-plugins/git-flow"); got != "git-flow" {
		t.Fatalf("marketRepoName = %q", got)
	}
	if got := marketRepoName("git-flow"); got != "git-flow" {
		t.Fatalf("marketRepoName(no slash) = %q", got)
	}
}

func TestMarketSourceNormalization(t *testing.T) {
	for _, in := range []string{"", "Gitee", "GITEE", "gitee", "ftp", "github.com"} {
		if got := normalizeMarketSource(in); got != marketSourceGitee {
			t.Fatalf("normalizeMarketSource(%q) = %q, want gitee", in, got)
		}
	}
	for _, in := range []string{"github", "GitHub"} {
		if got := normalizeMarketSource(in); got != marketSourceGithub {
			t.Fatalf("normalizeMarketSource(%q) = %q, want github", in, got)
		}
	}
}

func TestMarketSourceURLs(t *testing.T) {
	gitee := "cadt-datalens-plugins/bak-json"
	if got := marketReposPageURL(marketSourceGitee, 2); got != "https://gitee.com/api/v5/orgs/cadt-datalens-plugins/repos?type=public&sort=updated&direction=desc&per_page=100&page=2" {
		t.Fatalf("gitee repos URL = %q", got)
	}
	if got := marketReposPageURL(marketSourceGithub, 2); got != "https://api.github.com/orgs/cadt-datalens-plugins/repos?sort=updated&direction=desc&per_page=100&page=2" {
		t.Fatalf("github repos URL = %q", got)
	}
	if got := marketManifestURL(marketSourceGitee, gitee, "main"); got != "https://gitee.com/cadt-datalens-plugins/bak-json/raw/main/plugin.json" {
		t.Fatalf("gitee manifest URL = %q", got)
	}
	if got := marketManifestURL(marketSourceGithub, gitee, "main"); got != "https://raw.githubusercontent.com/cadt-datalens-plugins/bak-json/main/plugin.json" {
		t.Fatalf("github manifest URL = %q", got)
	}
	if got := marketRepoURLFor(marketSourceGithub, gitee+".git"); got != "https://github.com/cadt-datalens-plugins/bak-json" {
		t.Fatalf("github repo URL = %q", got)
	}
	if got := marketRepoURLFor(marketSourceGitee, gitee); got != "https://gitee.com/cadt-datalens-plugins/bak-json" {
		t.Fatalf("gitee repo URL = %q", got)
	}
	if got := marketDefaultBranch(marketSourceGithub); got != "main" {
		t.Fatalf("github default branch = %q", got)
	}
	if got := marketDefaultBranch(marketSourceGitee); got != "master" {
		t.Fatalf("gitee default branch = %q", got)
	}
}

func TestDataSourceRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := NewApp()
	if got := app.GetDataSource(); got != marketSourceGitee {
		t.Fatalf("默认数据源 = %q, want gitee", got)
	}
	if err := app.SetDataSource("github"); err != nil {
		t.Fatalf("SetDataSource(github): %v", err)
	}
	if got := app.GetDataSource(); got != marketSourceGithub {
		t.Fatalf("切换后数据源 = %q, want github", got)
	}
	if err := app.SetDataSource("gitee"); err != nil {
		t.Fatalf("SetDataSource(gitee): %v", err)
	}
	if got := app.GetDataSource(); got != marketSourceGitee {
		t.Fatalf("切回后数据源 = %q, want gitee", got)
	}
	if err := app.SetDataSource("nope"); err != nil {
		t.Fatalf("SetDataSource(nope): %v", err)
	}
	if got := app.GetDataSource(); got != marketSourceGitee {
		t.Fatalf("非法值应归一为 gitee，got %q", got)
	}
}

func TestMarketRateLimitFallback(t *testing.T) {
	okRepos := []marketRepo{{FullName: "cadt-datalens-plugins/bak-json"}}

	cases := []struct {
		name       string
		fetch      func(context.Context, string) ([]marketRepo, error)
		wantSource string
		wantErr    bool
	}{
		{
			name: "主源正常不回退",
			fetch: func(_ context.Context, source string) ([]marketRepo, error) {
				return okRepos, nil
			},
			wantSource: marketSourceGitee,
		},
		{
			name: "主源限流回退镜像",
			fetch: func(_ context.Context, source string) ([]marketRepo, error) {
				if source == marketSourceGitee {
					return nil, &marketHTTPError{source: source, status: 403}
				}
				return okRepos, nil
			},
			wantSource: marketSourceGithub,
		},
		{
			name: "非限流错误不回退",
			fetch: func(_ context.Context, source string) ([]marketRepo, error) {
				return nil, &marketHTTPError{source: source, status: 500}
			},
			wantSource: marketSourceGitee,
			wantErr:    true,
		},
		{
			name: "两侧都限流报主源错误",
			fetch: func(_ context.Context, source string) ([]marketRepo, error) {
				return nil, &marketHTTPError{source: source, status: 429}
			},
			wantSource: marketSourceGitee,
			wantErr:    true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			repos, usedSource, err := fetchMarketReposWithFallback(context.Background(), marketSourceGitee, c.fetch)
			if c.wantErr {
				if err == nil {
					t.Fatalf("want error, got nil")
				}
				if !isMarketRateLimitError(err) && usedSource == marketSourceGitee && c.name == "两侧都限流报主源错误" {
					t.Fatalf("fallback error should stay rate-limit typed: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if usedSource != c.wantSource || len(repos) != 1 {
				t.Fatalf("usedSource = %q, repos = %d, want %q/1", usedSource, len(repos), c.wantSource)
			}
		})
	}
}

func TestMarketHTTPErrorMessages(t *testing.T) {
	gitee403 := (&marketHTTPError{source: marketSourceGitee, status: 403}).Error()
	if !strings.Contains(gitee403, "限流") || !strings.Contains(gitee403, "GitHub") {
		t.Fatalf("gitee 403 message = %q", gitee403)
	}
	gh429 := (&marketHTTPError{source: marketSourceGithub, status: 429}).Error()
	if !strings.Contains(gh429, "限流") || !strings.Contains(gh429, "Gitee") {
		t.Fatalf("github 429 message = %q", gh429)
	}
	plain := (&marketHTTPError{source: marketSourceGitee, status: 500}).Error()
	if plain != "Gitee 返回 HTTP 500" {
		t.Fatalf("plain message = %q", plain)
	}
}

func TestApplyMarketManifest(t *testing.T) {
	item := &MarketPlugin{Repo: "cadt-datalens-plugins/bak-json", Name: "bak-json", Description: "仓库描述"}
	ok := applyMarketManifest(item, marketManifest{
		Id:            "bak-json",
		Name:          "JSON 备份查看",
		Version:       "1.2.0",
		Author:        "CandySweet",
		Description:   "插件清单描述",
		MinAppVersion: "1.0.0",
	})
	if !ok {
		t.Fatal("applyMarketManifest should accept a valid manifest")
	}
	if !item.ManifestOk || item.Id != "bak-json" || item.Name != "JSON 备份查看" ||
		item.Version != "1.2.0" || item.Author != "CandySweet" ||
		item.Description != "插件清单描述" || item.MinAppVersion != "1.0.0" {
		t.Fatalf("unexpected merged item: %+v", item)
	}
}

func TestApplyMarketManifestRejectsInvalid(t *testing.T) {
	item := &MarketPlugin{Name: "repo-name", Description: "repo-desc"}
	for _, m := range []marketManifest{
		{Id: "Bad/Id", Name: "x"},
		{Id: "", Name: "x"},
		{Id: "ok-id", Name: "  "},
	} {
		if applyMarketManifest(item, m) {
			t.Fatalf("manifest should be rejected: %+v", m)
		}
	}
	if item.ManifestOk || item.Name != "repo-name" || item.Description != "repo-desc" {
		t.Fatalf("rejected manifest modified item: %+v", item)
	}
}

func TestMarketInstalledDetection(t *testing.T) {
	byRepo := &MarketPlugin{Repo: "cadt-datalens-plugins/git-flow"}
	markMarketInstalled(byRepo, map[string]string{"git-flow": "1.2.0"})
	if !byRepo.Installed || byRepo.InstalledVersion != "1.2.0" {
		t.Fatalf("repo name match should mark installed with version: %+v", byRepo)
	}
	byId := &MarketPlugin{Repo: "cadt-datalens-plugins/other", Id: "real-id"}
	markMarketInstalled(byId, map[string]string{"real-id": "2.0.0"})
	if !byId.Installed || byId.InstalledVersion != "2.0.0" {
		t.Fatalf("manifest id match should mark installed with version: %+v", byId)
	}
	none := &MarketPlugin{Repo: "cadt-datalens-plugins/new", Id: "new-id"}
	markMarketInstalled(none, map[string]string{"git-flow": "1.2.0"})
	if none.Installed || none.InstalledVersion != "" {
		t.Fatalf("unrelated plugin should not be marked installed: %+v", none)
	}
}

func TestComparePluginVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.1", -1},
		{"1.0.1", "1.0.0", 1},
		{"1.0", "1.0.0", 0},
		{"v2", "1.9.9", 1},
		{"1.10.0", "1.9.0", 1},
		{"", "0.0.1", -1},
	}
	for _, c := range cases {
		if got := comparePluginVersion(c.a, c.b); got != c.want {
			t.Fatalf("comparePluginVersion(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestDecodeMarketRepoList(t *testing.T) {
	raw := `[{"full_name":"cadt-datalens-plugins/bak-json","name":"bak-json","description":"把 .bak 文件按 JSON 解析","default_branch":"main","stargazers_count":3,"updated_at":"2026-11-08T20:34:34+08:00"}]`
	var repos []marketRepo
	if err := json.Unmarshal([]byte(raw), &repos); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(repos) != 1 || repos[0].FullName != "cadt-datalens-plugins/bak-json" ||
		repos[0].DefaultBranch != "main" || repos[0].StargazersCount != 3 {
		t.Fatalf("unexpected repos: %+v", repos)
	}
}

func TestMarketPathValidation(t *testing.T) {
	valid := []string{"cadt-datalens-plugins/bak-json", "owner/repo.js", "a/b"}
	for _, name := range valid {
		if !validMarketRepo(name) {
			t.Fatalf("should accept repo %q", name)
		}
	}
	invalid := []string{"cadt-datalens-plugins", "a/b/c", "../x", "a/..", "a b/c", "a/", "/a"}
	for _, name := range invalid {
		if validMarketRepo(name) {
			t.Fatalf("should reject repo %q", name)
		}
	}
	for _, branch := range []string{"main", "feature/x-1"} {
		if !validMarketBranch(branch) {
			t.Fatalf("should accept branch %q", branch)
		}
	}
	for _, branch := range []string{"", "../main", "a//b", "/main"} {
		if validMarketBranch(branch) {
			t.Fatalf("should reject branch %q", branch)
		}
	}
}
