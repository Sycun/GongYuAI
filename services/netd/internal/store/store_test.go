package store_test

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Sycun/GongYuAI/services/netd/internal/store"
	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

func TestPutAndReadBlobSlice(t *testing.T) {
	taskDir := t.TempDir()

	if ref, err := store.PutBlob(taskDir, nil, "text/plain"); err != nil || ref != nil {
		t.Fatalf("expected nil ref for empty data, got %+v, err=%v", ref, err)
	}
	if _, err := store.BlobPath(taskDir, "not-a-sha256"); err == nil {
		t.Fatal("expected invalid sha256 error")
	}

	payload := []byte("hello content-addressed storage! 0123456789")
	var wg sync.WaitGroup
	refs := make([]*store.TrafficBlobRef, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			r, err := store.PutBlob(taskDir, payload, "text/plain")
			if err != nil {
				t.Errorf("PutBlob[%d]: %v", idx, err)
				return
			}
			refs[idx] = r
		}(i)
	}
	wg.Wait()

	hash := refs[0].SHA256
	for i, r := range refs {
		if r == nil || r.SHA256 != hash || r.Size != int64(len(payload)) {
			t.Fatalf("mismatch at %d: %+v", i, r)
		}
	}

	chunk1, sz, next1, err := store.ReadBlobSlice(taskDir, hash, 0, 10)
	if err != nil || sz != int64(len(payload)) || string(chunk1) != "hello cont" || next1 == nil || *next1 != 10 {
		t.Fatalf("unexpected slice 1: chunk=%q sz=%d next=%v err=%v", chunk1, sz, next1, err)
	}
	chunk2, _, next2, err := store.ReadBlobSlice(taskDir, hash, *next1, 1024)
	if err != nil || string(chunk2) != string(payload[10:]) || next2 != nil {
		t.Fatalf("unexpected slice 2: chunk=%q next=%v err=%v", chunk2, next2, err)
	}
	emptyPastEnd, _, next3, err := store.ReadBlobSlice(taskDir, hash, len(payload)+5, 10)
	if err != nil || len(emptyPastEnd) != 0 || next3 != nil {
		t.Fatalf("expected empty slice past EOF, got %q next=%v err=%v", emptyPastEnd, next3, err)
	}
	if _, _, _, err := store.ReadBlobSlice(taskDir, hash, -1, 10); err == nil {
		t.Fatal("expected negative offset error")
	}
	if _, _, _, err := store.ReadBlobSlice(taskDir, hash, 0, store.MaxBlobRead+1); err == nil {
		t.Fatal("expected maxBytes limit error")
	}

	// CommitHashedFile & ReadBlobBytes cap
	tmpFile := filepath.Join(t.TempDir(), "spool.tmp")
	data2 := []byte("spooled-payload")
	sum2 := sha256.Sum256(data2)
	hash2 := hex.EncodeToString(sum2[:])
	if err := os.WriteFile(tmpFile, data2, 0o600); err != nil {
		t.Fatal(err)
	}
	ref2, err := store.CommitHashedFile(taskDir, tmpFile, hash2, int64(len(data2)), "application/octet-stream")
	if err != nil || ref2 == nil || ref2.SHA256 != hash2 {
		t.Fatalf("CommitHashedFile failed: %+v, err=%v", ref2, err)
	}
	if got, err := store.ReadBlobBytes(taskDir, hash2, 4); err != nil || got != nil {
		t.Fatalf("expected nil when blob exceeds maxBytes, got %q err=%v", got, err)
	}
	if got, err := store.ReadBlobBytes(taskDir, hash2, 64); err != nil || !bytes.Equal(got, data2) {
		t.Fatalf("ReadBlobBytes mismatch: %q err=%v", got, err)
	}
}

func TestContentEncodingAndPreview(t *testing.T) {
	plain := []byte(`{"status":"ok","msg":"压缩响应解码验证"}`)

	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	_, _ = gw.Write(plain)
	_ = gw.Close()

	var zlBuf bytes.Buffer
	zw := zlib.NewWriter(&zlBuf)
	_, _ = zw.Write(plain)
	_ = zw.Close()

	var flBuf bytes.Buffer
	fw, _ := flate.NewWriter(&flBuf, flate.DefaultCompression)
	_, _ = fw.Write(plain)
	_ = fw.Close()

	var brBuf bytes.Buffer
	bw := brotli.NewWriter(&brBuf)
	_, _ = bw.Write(plain)
	_ = bw.Close()

	var zsBuf bytes.Buffer
	zsw, _ := zstd.NewWriter(&zsBuf)
	_, _ = zsw.Write(plain)
	_ = zsw.Close()

	cases := []struct {
		enc  string
		data []byte
	}{
		{"gzip", gzBuf.Bytes()},
		{"deflate", zlBuf.Bytes()},
		{"deflate", flBuf.Bytes()},
		{"br", brBuf.Bytes()},
		{"zstd", zsBuf.Bytes()},
	}
	for _, tc := range cases {
		headers := map[string]any{"Content-Encoding": tc.enc}
		if !store.HasSupportedContentEncoding(headers) {
			t.Fatalf("expected %s to be supported", tc.enc)
		}
		dec := store.DecodeTrafficBody(tc.data, headers, 4096)
		if dec == nil || !bytes.Equal(dec.Bytes, plain) {
			t.Fatalf("decode %s failed: %+v", tc.enc, dec)
		}
		prev := store.DecodeTrafficPreview(tc.data, headers, 14)
		if prev != string(plain[:14]) {
			t.Fatalf("preview %s mismatch: %q", tc.enc, prev)
		}
	}

	if encs := store.ParseContentEncodings(map[string]any{"content-encoding": "identity"}); len(encs) != 0 {
		t.Fatalf("identity should yield empty slice, got %v", encs)
	}
	if encs := store.ParseContentEncodings(map[string]any{"content-encoding": "lz4"}); encs != nil {
		t.Fatalf("unsupported encoding should yield nil, got %v", encs)
	}
	// Decompression limit guard
	if dec := store.DecodeTrafficBody(gzBuf.Bytes(), map[string]any{"content-encoding": "gzip"}, 8); dec != nil {
		t.Fatalf("expected nil when output exceeds maxOut, got %+v", dec)
	}
}

func TestRetentionAndSQLitePruning(t *testing.T) {
	if !store.IsStaticAssetExchange(store.TrafficWrite{
		Method:     "GET",
		Path:       "/assets/app.bundle.js?v=1",
		Status:     200,
		ResHeaders: map[string]any{"content-type": "application/javascript"},
	}) {
		t.Fatal("expected JS bundle to be classified as static asset")
	}
	if store.IsStaticAssetExchange(store.TrafficWrite{
		Method:     "GET",
		Path:       "/assets/app.js",
		Status:     200,
		ResHeaders: map[string]any{"content-type": "application/javascript", "set-cookie": "sid=1"},
	}) {
		t.Fatal("exchange setting cookies must not be compacted as static")
	}
	if store.IsStaticAssetExchange(store.TrafficWrite{
		Method:     "GET",
		Path:       "/api/v1/users.js",
		Status:     200,
		ResHeaders: map[string]any{"content-type": "application/json"},
	}) {
		t.Fatal("/api/ JSON exchange must not be static")
	}

	capped := store.CapHeaders(map[string]any{
		"x-noise-a":     strings.Repeat("a", 300),
		"x-noise-b":     strings.Repeat("b", 300),
		"authorization": "Bearer secret-token",
		"content-type":  "application/json",
	}, 160)
	if _, ok := capped["content-type"]; !ok {
		t.Fatalf("priority header content-type must survive CapHeaders: %+v", capped)
	}

	taskDir := t.TempDir()
	sm := store.NewStoreManager()
	defer sm.CloseAll()

	ret := store.DefaultRetention()
	ret.MaxExchanges = 4
	ret.PruneSlack = 1
	ret.PruneCheckEvery = 1

	// Insert 1 finding-linked exchange first (oldest) + 6 unlinked exchanges -> pruning must keep the finding-linked row
	protected, err := sm.InsertTraffic(taskDir, store.TrafficWrite{
		ID:         "tx-protected",
		TaskID:     "task-1",
		Method:     "POST",
		URL:        "http://target.test/login",
		Host:       "target.test",
		Path:       "/login",
		Status:     200,
		StartedAt:  "2026-11-28T00:00:01.000Z",
		ReqHeaders: map[string]any{"content-type": "application/json"},
		ResHeaders: map[string]any{"content-type": "application/json"},
		ResPreview: `{"token":"secret-jwt"}`,
		FindingIDs: []string{"finding-1"},
	}, &ret)
	if err != nil || protected == nil {
		t.Fatalf("insert protected: %v", err)
	}

	// Idempotent re-insert with additional finding links onto the same row
	relinked, err := sm.InsertTraffic(taskDir, store.TrafficWrite{
		ID:         "tx-protected",
		TaskID:     "task-1",
		FindingIDs: []string{"finding-2"},
	}, &ret)
	if err != nil || len(relinked.FindingIDs) != 2 {
		t.Fatalf("expected idempotent relink to have 2 findings, got %+v err=%v", relinked, err)
	}

	for i := 0; i < 6; i++ {
		_, err := sm.InsertTraffic(taskDir, store.TrafficWrite{
			ID:        fmt.Sprintf("tx-noise-%d", i),
			TaskID:    "task-1",
			Method:    "GET",
			URL:       fmt.Sprintf("http://target.test/p/%d", i),
			Host:      "target.test",
			Path:      fmt.Sprintf("/p/%d", i),
			Status:    200,
			StartedAt: fmt.Sprintf("2026-11-28T00:01:%02d.000Z", i),
		}, &ret)
		if err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}

	gotProtected, err := sm.GetTraffic(taskDir, "tx-protected")
	if err != nil || gotProtected == nil {
		t.Fatalf("protected finding exchange was pruned! got=%+v err=%v", gotProtected, err)
	}

	page, err := sm.QueryTraffic(taskDir, store.TrafficQuery{
		TaskID:  "task-1",
		Keyword: "secret-jwt",
	})
	if err != nil || page.Total != 1 || page.Traffic[0].ID != "tx-protected" {
		t.Fatalf("keyword search failed: %+v err=%v", page, err)
	}

	allPage, err := sm.QueryTraffic(taskDir, store.TrafficQuery{TaskID: "task-1", Limit: 50})
	if err != nil || allPage.Total > ret.MaxExchanges+ret.PruneSlack {
		t.Fatalf("expected pruning to bound total <= %d, got %d (err=%v)", ret.MaxExchanges+ret.PruneSlack, allPage.Total, err)
	}
}
