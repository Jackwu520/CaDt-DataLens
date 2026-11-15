package webviewloader

import "testing"

// 锁住本地补丁的合并语义：注入为空时必须与上游行为完全一致，
// 与 Wails 已有的 --disable-features 要并成单一开关且不重复 feature。
func TestMergeBrowserArguments(t *testing.T) {
	orig := ExtraBrowserArguments
	defer func() { ExtraBrowserArguments = orig }()

	cases := []struct {
		name  string
		base  string
		extra string
		want  string
	}{
		{
			name:  "no injection keeps upstream args unchanged",
			base:  "--disable-gpu --disable-features=msSmartScreenProtection",
			extra: "",
			want:  "--disable-gpu --disable-features=msSmartScreenProtection",
		},
		{
			name:  "features merge into the existing switch",
			base:  "--disable-features=msSmartScreenProtection --disable-gpu",
			extra: "--disable-features=msWebOOUI,msPdfOOUI",
			want:  "--disable-features=msSmartScreenProtection,msWebOOUI,msPdfOOUI --disable-gpu",
		},
		{
			name:  "duplicate features are not appended twice",
			base:  "--disable-features=msSmartScreenProtection",
			extra: "--disable-features=msSmartScreenProtection,msPdfOOUI",
			want:  "--disable-features=msSmartScreenProtection,msPdfOOUI",
		},
		{
			name:  "empty base becomes the injected args",
			base:  "",
			extra: "--disable-features=msWebOOUI,msPdfOOUI",
			want:  "--disable-features=msWebOOUI,msPdfOOUI",
		},
		{
			name:  "unrelated switch is appended",
			base:  "--disable-gpu",
			extra: "--some-switch",
			want:  "--disable-gpu --some-switch",
		},
		{
			name:  "already present injection is idempotent",
			base:  "--disable-gpu --some-switch",
			extra: "--some-switch",
			want:  "--disable-gpu --some-switch",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ExtraBrowserArguments = tc.extra
			if got := mergeBrowserArguments(tc.base); got != tc.want {
				t.Fatalf("mergeBrowserArguments(%q) = %q, want %q", tc.base, got, tc.want)
			}
		})
	}
}
