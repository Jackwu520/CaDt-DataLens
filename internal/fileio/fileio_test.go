package fileio

import (
	"strings"
	"testing"
)

func TestImageHexDumpHasNoPreamble(t *testing.T) {
	got := imageHexDump([]byte{0x89, 'P', 'N', 'G', 0x00, 0xFF})
	if strings.HasPrefix(got, "//") || strings.Contains(got, "\n\n") || strings.HasSuffix(got, "\n") {
		t.Fatalf("hex dump should contain only data rows, got %q", got)
	}
	lines := strings.Split(got, "\n")
	if len(lines) != 1 {
		t.Fatalf("expected one data line, got %d: %q", len(lines), got)
	}
	if !strings.HasPrefix(lines[0], "00000000  ") {
		t.Fatalf("unexpected first line: %q", lines[0])
	}
	if !strings.Contains(lines[0], "89 50 4e 47 00 ff") {
		t.Fatalf("bytes missing from dump: %q", lines[0])
	}
}
