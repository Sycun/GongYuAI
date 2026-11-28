package ring_test

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"testing"

	"github.com/Sycun/GongYuAI/services/netd/internal/ring"
	"github.com/Sycun/GongYuAI/services/netd/internal/store"
)

func capturedOf(raw []byte, ct string) *ring.CapturedBody {
	sum := sha256.Sum256(raw)
	return &ring.CapturedBody{
		Head:        raw,
		Size:        int64(len(raw)),
		SHA256:      hex.EncodeToString(sum[:]),
		ContentType: ct,
	}
}

func TestPushEvictionLiveQueryAndGzipBodyRead(t *testing.T) {
	taskDir := t.TempDir()
	sm := store.NewStoreManager()
	defer sm.CloseAll()
	rm := ring.NewManager(sm)

	for i := 0; i < 5; i++ {
		body := []byte(fmt.Sprintf("resp-body-%d", i))
		rm.Push(taskDir, &ring.RingEntry{
			ID:   fmt.Sprintf("r-%d", i),
			AtMs: int64(1000 + i*100),
			Write: store.TrafficWrite{
				TaskID:    "task-1",
				IntentID:  "intent-a",
				WorkerID:  "w-0",
				Method:    "GET",
				URL:       fmt.Sprintf("http://app.test/item/%d", i),
				Host:      "app.test",
				Path:      fmt.Sprintf("/item/%d", i),
				Status:    200,
				StartedAt: fmt.Sprintf("2026-11-28T00:00:0%d.000Z", i),
			},
			ResBody: capturedOf(body, "text/plain"),
		}, 3)
	}

	if sz := rm.Size(taskDir); sz != 3 {
		t.Fatalf("expected ring size 3 after eviction, got %d", sz)
	}
	if rec, hot, err := rm.GetLive(taskDir, "r-0"); err != nil || rec != nil || hot {
		t.Fatalf("expected evicted r-0 to be absent, got rec=%+v hot=%v err=%v", rec, hot, err)
	}

	// Push a gzip-encoded entry and verify ReadBodyLive decodes it from the hot ring
	var gz bytes.Buffer
	gw := gzip.NewWriter(&gz)
	_, _ = gw.Write([]byte("decoded-hot-ring-secret"))
	_ = gw.Close()
	rm.Push(taskDir, &ring.RingEntry{
		ID:   "r-gz",
		AtMs: 2000,
		Write: store.TrafficWrite{
			TaskID:     "task-1",
			Method:     "GET",
			URL:        "http://app.test/gz",
			Host:       "app.test",
			Path:       "/gz",
			Status:     200,
			StartedAt:  "2026-11-28T00:00:09.000Z",
			ResHeaders: map[string]any{"content-encoding": "gzip"},
		},
		ResBody: capturedOf(gz.Bytes(), "text/plain"),
	}, 4)

	slice, code, err := rm.ReadBodyLive(taskDir, "r-gz", "res", 0, 1024)
	if err != nil || code != 200 || slice.Body != "decoded-hot-ring-secret" || slice.Source != "ring" {
		t.Fatalf("ReadBodyLive gzip failed: code=%d slice=%+v err=%v", code, slice, err)
	}

	// Keyword query should also match inside gzipped ring preview
	live, err := rm.QueryLive(taskDir, store.TrafficQuery{
		TaskID:  "task-1",
		Keyword: "hot-ring-secret",
	})
	if err != nil || live.Total != 1 || live.Traffic[0].ID != "r-gz" {
		t.Fatalf("QueryLive keyword over gzip ring failed: %+v err=%v", live, err)
	}
}

func TestPromoteWindowConvergeAndConcurrentSafety(t *testing.T) {
	taskDir := t.TempDir()
	sm := store.NewStoreManager()
	defer sm.CloseAll()
	rm := ring.NewManager(sm)

	now := int64(100_000)
	// Truncated body (Size > len(Head)) should record truncation marker header upon promotion
	rm.Push(taskDir, &ring.RingEntry{
		ID:   "tx-pre",
		AtMs: now - 1000,
		Write: store.TrafficWrite{
			TaskID:    "task-race",
			IntentID:  "intent-1",
			Method:    "POST",
			URL:       "http://vuln.test/api/exec",
			Host:      "vuln.test",
			Path:      "/api/exec",
			Status:    500,
			StartedAt: "2026-11-28T01:00:00.000Z",
		},
		ResBody: &ring.CapturedBody{
			Head:        []byte("uid=0(root)"),
			Size:        4096,
			SHA256:      strings.Repeat("a", 64),
			ContentType: "text/plain",
		},
	}, 50)

	prom, err := rm.PromoteForFinding(ring.PromoteOptions{
		TaskDir:   taskDir,
		FindingID: "finding-rce",
		IntentID:  "intent-1",
		Host:      "https://vuln.test:8443/api",
		NowMs:     &now,
	})
	if err != nil || prom.Promoted != 1 || prom.Window == nil || prom.Window.Host != "vuln.test" {
		t.Fatalf("PromoteForFinding failed: %+v err=%v", prom, err)
	}

	// Converge window shrinks Remaining to DefaultConfirmItems
	conv := rm.OpenWindow(ring.OpenWindowOptions{
		TaskDir:   taskDir,
		FindingID: "finding-rce",
		IntentID:  "intent-1",
		Host:      "vuln.test",
		Converge:  true,
		NowMs:     &now,
	})
	if conv == nil || conv.Remaining > ring.DefaultConfirmItems {
		t.Fatalf("expected converged window <= %d, got %+v", ring.DefaultConfirmItems, conv)
	}

	matched := rm.MatchWindows(taskDir, "other-intent", "vuln.test", now+100)
	if len(matched) != 1 || matched[0] != "finding-rce" {
		t.Fatalf("expected host match on active window, got %v", matched)
	}
	for i := 0; i < ring.DefaultConfirmItems; i++ {
		rm.ConsumeWindows(taskDir, matched)
	}
	if active := rm.ActiveWindows(taskDir, now+200); len(active) != 0 {
		t.Fatalf("expected window to auto-close when Remaining reaches 0, got %+v", active)
	}

	// Concurrent stress test across Push, QueryLive, and PromoteForFinding (validated under -race)
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(3)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				id := fmt.Sprintf("conc-%d-%d", worker, i)
				rm.Push(taskDir, &ring.RingEntry{
					ID:   id,
					AtMs: now + int64(i),
					Write: store.TrafficWrite{
						TaskID:    "task-race",
						IntentID:  "intent-conc",
						Host:      "vuln.test",
						Method:    "GET",
						URL:       "http://vuln.test/ping",
						Path:      "/ping",
						Status:    200,
						StartedAt: "2026-11-28T01:01:00.000Z",
					},
					ResBody: capturedOf([]byte("pong"), "text/plain"),
				}, 60)
			}
		}(g)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				_, _ = rm.QueryLive(taskDir, store.TrafficQuery{TaskID: "task-race", Limit: 20})
			}
		}()
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 8; i++ {
				ts := now + int64(i*10)
				_, _ = rm.PromoteForFinding(ring.PromoteOptions{
					TaskDir:   taskDir,
					FindingID: fmt.Sprintf("f-%d", worker),
					IntentID:  "intent-conc",
					NowMs:     &ts,
				})
			}
		}(g)
	}
	wg.Wait()
}

var strings = struct {
	Repeat func(string, int) string
}{
	Repeat: func(s string, count int) string {
		var b bytes.Buffer
		for i := 0; i < count; i++ {
			b.WriteString(s)
		}
		return b.String()
	},
}
