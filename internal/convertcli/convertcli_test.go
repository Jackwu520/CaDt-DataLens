package convertcli

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFixture(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseArgsSingle(t *testing.T) {
	dir := t.TempDir()
	input := writeFixture(t, dir, "a.json", `{"a":1}`)
	opts, isConvert, err := ParseArgs([]string{"--convert", input, "--to", "yml"})
	if err != nil || !isConvert {
		t.Fatalf("parse failed: convert=%v err=%v", isConvert, err)
	}
	if opts.To != "yaml" || len(opts.Jobs) != 1 {
		t.Fatalf("unexpected options: %+v", opts)
	}
	want := filepath.Join(dir, "a.yaml")
	if opts.Jobs[0].Output != want {
		t.Fatalf("output = %q, want %q", opts.Jobs[0].Output, want)
	}
}

func TestParseArgsBatchOutDir(t *testing.T) {
	dir := t.TempDir()
	a := writeFixture(t, dir, "a.json", `{}`)
	b := writeFixture(t, dir, "b.json", `{}`)
	outDir := filepath.Join(dir, "out")
	if err := os.Mkdir(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	opts, _, err := ParseArgs([]string{"--convert", a, b, "--to", "jsonl", "--out", outDir})
	if err != nil {
		t.Fatal(err)
	}
	if len(opts.Jobs) != 2 {
		t.Fatalf("expected 2 jobs, got %d", len(opts.Jobs))
	}
	for _, job := range opts.Jobs {
		if filepath.Dir(job.Output) != outDir || filepath.Ext(job.Output) != ".jsonl" {
			t.Fatalf("unexpected job: %+v", job)
		}
	}
}

func TestParseArgsErrors(t *testing.T) {
	dir := t.TempDir()
	a := writeFixture(t, dir, "a.json", `{}`)
	b := writeFixture(t, dir, "b.json", `{}`)
	cases := [][]string{
		{"--convert", a},
		{"--convert", a, "--to", "exe"},
		{"--convert", a, b, "--to", "yaml", "--stdout"},
		{"--convert", a, "--to", "yaml", "--bogus"},
	}
	for _, args := range cases {
		if _, isConvert, err := ParseArgs(args); !isConvert || err == nil {
			t.Fatalf("expected error for %v, isConvert=%v err=%v", args, isConvert, err)
		}
	}
}

func TestParseArgsIgnoresGuiFlags(t *testing.T) {
	cases := [][]string{
		{"--new-window", "--ai-float", `D:\workspace`},
		{"--new-window", "--debug-console"},
		{"--open-settings=models"},
		{"--new-window", "--ai-session=abc", `D:\workspace`},
	}
	for _, args := range cases {
		opts, isConvert, err := ParseArgs(args)
		if err != nil || isConvert || opts != nil {
			t.Fatalf("GUI 参数 %v 不应进入转换模式：opts=%+v convert=%v err=%v", args, opts, isConvert, err)
		}
	}
}

func TestParseArgsRefusesOverwrite(t *testing.T) {
	dir := t.TempDir()
	a := writeFixture(t, dir, "a.json", `{}`)
	writeFixture(t, dir, "a.yaml", "existing")
	if _, _, err := ParseArgs([]string{"--convert", a, "--to", "yaml"}); err == nil {
		t.Fatal("expected overwrite refusal")
	}
	if _, _, err := ParseArgs([]string{"--convert", a, "--to", "yaml", "--force"}); err != nil {
		t.Fatalf("force should allow overwrite: %v", err)
	}
}
