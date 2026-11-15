package patch

import "testing"

// 只读审阅解析不得注册计划（白盒）：ParseReviewText 全程不触碰计划注册表，
// 返回的 Preview.PlanID 为空，天然进不了应用流。
func TestParseReviewTextRegistersNothing(t *testing.T) {
	text := "diff --git a/src/a.txt b/src/a.txt\n" +
		"--- a/src/a.txt\n+++ b/src/a.txt\n" +
		"@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n"
	before := len(patchPlans)
	out, err := ParseReviewText(text)
	if err != nil {
		t.Fatalf("ParseReviewText: %v", err)
	}
	if out.PlanID != "" {
		t.Fatalf("审阅解析不应生成 PlanID：%+v", out)
	}
	if len(patchPlans) != before {
		t.Fatalf("审阅解析不应注册计划（之前 %d，之后 %d）", before, len(patchPlans))
	}
}

func TestParseReviewTextEmpty(t *testing.T) {
	if _, err := ParseReviewText("   \n"); err == nil {
		t.Fatalf("空文本应报错")
	}
}
