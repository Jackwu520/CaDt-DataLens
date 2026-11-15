package patch

// 补丁库引擎层测试：正文归一、滞留状态自愈、索引裁剪保序。
// 走 App 方法的生命周期测试在仓库根 patch_app_test.go（App 层进不了本包）。

import (
	"os"
	"testing"
)

func TestNormalizePatchBody(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"去 BOM 与 CRLF", "\ufeffa\r\nb\r\n", "a\nb\n"},
		{"补齐尾换行", "a\nb", "a\nb\n"},
		{"去首尾空白", "\n\n  a  \n\n", "a\n"},
		{"纯空白归零", "  \n\t\n", ""},
		{"CR 单独出现也归一", "a\rb\r", "a\nb\n"},
	}
	for _, c := range cases {
		if got := NormalizePatchBody(c.in); got != c.want {
			t.Fatalf("%s：NormalizePatchBody(%q) = %q，预期 %q", c.name, c.in, got, c.want)
		}
	}
	// 归一后内容相同 → sha 相同（去重判据）
	if PatchTextSHA(NormalizePatchBody("a\r\nb")) != PatchTextSHA(NormalizePatchBody("a\nb\n")) {
		t.Fatal("归一后 sha 应一致")
	}
	if PatchTextSHA("") != "" {
		t.Fatal("空正文的 sha 应为空串")
	}
}

func TestReconcilePatchStoreHealsApplying(t *testing.T) {
	root := t.TempDir()
	store := PatchStoreRoot(root)
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	stuck := "20261113-200255-4321"
	done := "20261113-200523-4253"
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: stuck, Summary: "卡住的", Status: "proposed"})
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: stuck, Summary: "卡住的", Status: "applying"})
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: done, Summary: "完成的", Status: "applying"})
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: done, Summary: "完成的", Status: "applied", AppliedAt: 1})

	if healed := ReconcilePatchStore(root); healed != 1 {
		t.Fatalf("应自愈 1 个补丁，实际 %d", healed)
	}
	latest := PatchIndexLatest(ReadPatchIndex(store))
	if latest[stuck].Status != patchStatusFailed {
		t.Fatalf("滞留 applying 应收敛为 %s，实际 %s", patchStatusFailed, latest[stuck].Status)
	}
	if latest[done].Status != "applied" {
		t.Fatalf("正常收尾的补丁状态不应被改，实际 %s", latest[done].Status)
	}
	// 幂等：再跑一次不再追加
	before := len(ReadPatchIndex(store))
	if healed := ReconcilePatchStore(root); healed != 0 {
		t.Fatalf("二次自愈应为 0，实际 %d", healed)
	}
	if after := len(ReadPatchIndex(store)); after != before {
		t.Fatalf("二次自愈不应追加行：%d → %d", before, after)
	}
}

func TestPrunePatchIndexKeepsOtherLines(t *testing.T) {
	root := t.TempDir()
	store := PatchStoreRoot(root)
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: "aaa", Summary: "A", Status: "proposed", Mode: "atomic"})
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: "bbb", Summary: "B", Status: "applied", AppliedAt: 7})
	_ = AppendPatchIndex(store, PatchIndexEntry{V: 1, ID: "aaa", Summary: "A", Status: "applied", AppliedAt: 9})
	before := ReadPatchIndex(store)

	removed, err := PrunePatchIndex(store, "aaa")
	if err != nil {
		t.Fatalf("裁剪: %v", err)
	}
	if removed != 2 {
		t.Fatalf("应删除 2 行，实际 %d", removed)
	}
	after := ReadPatchIndex(store)
	if len(after) != 1 || after[0].ID != "bbb" {
		t.Fatalf("只应留下 bbb，实际 %+v", after)
	}
	// 保留行逐字不变（包括 mode / appliedAt 等字段）
	if after[0].Mode != before[1].Mode || after[0].AppliedAt != before[1].AppliedAt {
		t.Fatalf("保留行字段被改动：%+v vs %+v", after[0], before[1])
	}
	// 幂等：再删一次没有任何改动
	if removed, err := PrunePatchIndex(store, "aaa"); err != nil || removed != 0 {
		t.Fatalf("二次裁剪应无改动：removed=%d err=%v", removed, err)
	}
}
