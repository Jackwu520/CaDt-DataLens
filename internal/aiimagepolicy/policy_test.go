// aiimagepolicy 单测：锁定三层阈值的单边界与组合边界。
// 纯函数、无外部依赖，表驱动 + 逐条用例两种写法。
package aiimagepolicy

import (
	"strings"
	"testing"
)

func TestGetReturnsFrozenCopy(t *testing.T) {
	a := Get()
	a.MediaTypes[0] = "image/broken"
	a.MaxImagesPerMessage = 999
	b := Get()
	if b.MediaTypes[0] != "image/png" {
		t.Fatalf("MediaTypes 被外部改动污染了真源：%v", b.MediaTypes)
	}
	if b.MaxImagesPerMessage != 10 {
		t.Fatalf("MaxImagesPerMessage 被外部改动污染了真源：%d", b.MaxImagesPerMessage)
	}
}

func TestGetValues(t *testing.T) {
	got := Get()
	if got.MaxImagesPerMessage != 10 {
		t.Errorf("张数 = %d，期望 10", got.MaxImagesPerMessage)
	}
	if got.MaxSourceImageBytes != 50<<20 {
		t.Errorf("单源 = %d，期望 50MiB", got.MaxSourceImageBytes)
	}
	if got.MaxMessageSourceBytes != 200<<20 {
		t.Errorf("源合计 = %d，期望 200MiB", got.MaxMessageSourceBytes)
	}
	if got.MaxNormalizedDimension != 2048 {
		t.Errorf("归一化长边 = %d，期望 2048", got.MaxNormalizedDimension)
	}
	if got.MaxNormalizedBase64 != 4<<20 {
		t.Errorf("单张编码 = %d，期望 4MiB", got.MaxNormalizedBase64)
	}
	if got.MaxRequestImageBytes != 32<<20 {
		t.Errorf("请求预算 = %d，期望 32MiB", got.MaxRequestImageBytes)
	}
	want := []string{"image/png", "image/jpeg", "image/webp", "image/gif"}
	if len(got.MediaTypes) != len(want) {
		t.Fatalf("mediaTypes 数量 = %d，期望 %d", len(got.MediaTypes), len(want))
	}
	for i := range want {
		if got.MediaTypes[i] != want[i] {
			t.Errorf("mediaTypes[%d] = %q，期望 %q", i, got.MediaTypes[i], want[i])
		}
	}
}

func TestValidateBatchOK(t *testing.T) {
	// 10 张小图：全部在阈值内
	if err := ValidateBatch(10, []int{1 << 20, 1 << 20}, []int{500 << 10, 500 << 10}); err != nil {
		t.Fatalf("阈值内的批次被拒：%v", err)
	}
	// 空批次（只有文本）也合法
	if err := ValidateBatch(0, nil, nil); err != nil {
		t.Fatalf("空批次被拒：%v", err)
	}
}

func TestValidateBatchTooMany(t *testing.T) {
	// 10 张通过、11 张拒
	if err := ValidateBatch(10, nil, nil); err != nil {
		t.Fatalf("10 张应通过：%v", err)
	}
	err := ValidateBatch(11, nil, nil)
	if err == nil {
		t.Fatal("11 张应被拒")
	}
	if !IsCode(err, ErrTooManyImages) {
		t.Fatalf("错误码 = %v，期望 TOO_MANY_IMAGES", err)
	}
	if !strings.Contains(err.Error(), "10") {
		t.Errorf("错误文案应点名上限 10：%s", err.Error())
	}
}

func TestValidateBatchSourceSingle(t *testing.T) {
	// 单张刚好等于上限通过，超 1 字节拒绝
	if err := ValidateBatch(1, []int{MaxSourceImageBytes}, nil); err != nil {
		t.Fatalf("单源恰好等于上限应通过：%v", err)
	}
	err := ValidateBatch(1, []int{MaxSourceImageBytes + 1}, nil)
	if !IsCode(err, ErrSourcesTooLarge) {
		t.Fatalf("单源超限应报 SOURCES_TOO_LARGE，实际：%v", err)
	}
}

func TestValidateBatchSourceTotal(t *testing.T) {
	// 各张都不超单源上限，但合计超 200MiB
	src := []int{50 << 20, 50 << 20, 50 << 20, 50 << 20, 1}
	err := ValidateBatch(5, src, nil)
	if !IsCode(err, ErrSourcesTooLarge) {
		t.Fatalf("源合计超限应报 SOURCES_TOO_LARGE，实际：%v", err)
	}
	if !strings.Contains(err.Error(), "合计") {
		t.Errorf("应点名合计上限：%s", err.Error())
	}
}

func TestValidateBatchRequestSingle(t *testing.T) {
	// 编码后单张 4MiB 边界
	if err := ValidateBatch(1, nil, []int{MaxNormalizedBase64}); err != nil {
		t.Fatalf("单张编码恰好等于上限应通过：%v", err)
	}
	err := ValidateBatch(1, nil, []int{MaxNormalizedBase64 + 1})
	if !IsCode(err, ErrRequestImagesTooLarge) {
		t.Fatalf("单张编码超限应报 REQUEST_IMAGES_TOO_LARGE，实际：%v", err)
	}
}

func TestValidateBatchRequestTotal(t *testing.T) {
	// 9 张各 4MiB = 36MiB > 32MiB
	req := make([]int, 9)
	for i := range req {
		req[i] = 4 << 20
	}
	err := ValidateBatch(9, nil, req)
	if !IsCode(err, ErrRequestImagesTooLarge) {
		t.Fatalf("编码合计超限应报 REQUEST_IMAGES_TOO_LARGE，实际：%v", err)
	}
	if !strings.Contains(err.Error(), "合计") {
		t.Errorf("应点名合计上限：%s", err.Error())
	}
	// 恰好等于 32MiB 应通过（防有人把 > 写成 >=）
	exact := make([]int, 8)
	for i := range exact {
		exact[i] = 4 << 20
	}
	if err := ValidateBatch(8, nil, exact); err != nil {
		t.Fatalf("8×4MiB 恰好等于 32MiB 上限应通过：%v", err)
	}
}

func TestValidateBatchSourceTotalExact(t *testing.T) {
	// 4×50MiB = 200MiB 恰好等于上限，应通过（防 >= 回归）
	exact := []int{50 << 20, 50 << 20, 50 << 20, 50 << 20}
	if err := ValidateBatch(4, exact, nil); err != nil {
		t.Fatalf("源合计恰好等于 200MiB 应通过：%v", err)
	}
}

func TestValidateBatchNegativeBytesIgnored(t *testing.T) {
	// 负值不得把合计冲小：5×45MiB=225MiB 已超 200MiB，
	// 若负值真被计入（-100MiB 冲成 125MiB）就会漏判。
	src := []int{45 << 20, 45 << 20, 45 << 20, 45 << 20, 45 << 20, -100 << 20}
	err := ValidateBatch(6, src, nil)
	if !IsCode(err, ErrSourcesTooLarge) {
		t.Fatalf("负值不应冲小合计（225MiB 应超限），实际：%v", err)
	}
}

func TestValidateBatchNegativeCount(t *testing.T) {
	// 负数按 0 处理，不 panic
	if err := ValidateBatch(-5, nil, nil); err != nil {
		t.Fatalf("负数张数应按 0 处理：%v", err)
	}
}

func TestIsCode(t *testing.T) {
	if IsCode(nil, ErrTooManyImages) {
		t.Error("nil 不应命中任何码")
	}
	if IsCode(ValidateBatch(0, nil, nil), ErrTooManyImages) {
		t.Error("成功结果不应命中")
	}
	err := ValidateBatch(99, nil, nil)
	if !IsCode(err, ErrTooManyImages) {
		t.Error("应命中 TOO_MANY_IMAGES")
	}
	if IsCode(err, ErrSourcesTooLarge) {
		t.Error("不应命中别的码")
	}
}
