package watch

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func writeNotifyEntry(buf []byte, offset int, next uint32, name string, action uint32) int {
	units := utf16Encode(name)
	nameLen := len(units) * 2
	binary.LittleEndian.PutUint32(buf[offset:], next)
	binary.LittleEndian.PutUint32(buf[offset+4:], action)
	binary.LittleEndian.PutUint32(buf[offset+8:], uint32(nameLen))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[offset+12+i*2:], u)
	}
	return offset + 12 + nameLen
}

func utf16Encode(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

func TestParseNotifyBuffer(t *testing.T) {
	buf := make([]byte, 512)
	firstLen := 12 + len(utf16Encode("a.txt"))*2
	next := writeNotifyEntry(buf, 0, uint32(firstLen), "a.txt", syscall.FILE_ACTION_ADDED)
	next = writeNotifyEntry(buf, next, 0, "子目录\\b.json", syscall.FILE_ACTION_MODIFIED)
	events, overflow := parseNotifyBuffer(buf, uint32(next))
	if overflow {
		t.Fatal("unexpected overflow")
	}
	if len(events) != 2 || events[0].Path != "a.txt" || events[1].Path != "子目录\\b.json" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].Removed || events[1].Removed {
		t.Fatalf("added/modified 不应标记 Removed: %#v", events)
	}
	if _, overflow := parseNotifyBuffer(nil, 0); !overflow {
		t.Fatal("zero-size batch should mark overflow")
	}
}

// TestParseNotifyBufferRemoved 「消失」类动作（removed / renamed_old_name）标 Removed=true——
// wipe-guard 的删除计数只认这组（方案 §5.1）。
func TestParseNotifyBufferRemoved(t *testing.T) {
	buf := make([]byte, 512)
	firstLen := 12 + len(utf16Encode("gone.txt"))*2
	secondLen := 12 + len(utf16Encode("moved-away.txt"))*2
	next := writeNotifyEntry(buf, 0, uint32(firstLen), "gone.txt", syscall.FILE_ACTION_REMOVED)
	next = writeNotifyEntry(buf, next, uint32(secondLen), "moved-away.txt", syscall.FILE_ACTION_RENAMED_OLD_NAME)
	next = writeNotifyEntry(buf, next, 0, "renamed-in.txt", syscall.FILE_ACTION_RENAMED_NEW_NAME)
	events, _ := parseNotifyBuffer(buf, uint32(next))
	if len(events) != 3 {
		t.Fatalf("unexpected events: %#v", events)
	}
	if !events[0].Removed || !events[1].Removed {
		t.Fatalf("removed/renamed_old 应标记 Removed: %#v", events)
	}
	if events[2].Removed {
		t.Fatalf("renamed_new 是「出现」不是消失: %#v", events)
	}
}

func TestWatchDirectoryReceivesCreate(t *testing.T) {
	dir := t.TempDir()
	stop := make(chan struct{})
	done := make(chan struct{})
	events := make(chan string, 8)
	go func() {
		defer close(done)
		_ = watchDirectory(dir, stop, func(list []watchEvent, overflow bool) {
			for _, e := range list {
				select {
				case events <- e.Path:
				default:
				}
			}
		})
	}()
	defer func() {
		close(stop)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("watcher did not stop")
		}
	}()
	time.Sleep(150 * time.Millisecond)
	target := filepath.Join(dir, "new-file.txt")
	if err := os.WriteFile(target, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(4 * time.Second)
	for {
		select {
		case name := <-events:
			if strings.Contains(name, "new-file.txt") {
				return
			}
		case <-deadline:
			t.Fatal("did not receive file creation notification")
		}
	}
}
