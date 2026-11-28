package proxy_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Sycun/GongYuAI/services/netd/internal/proxy"
	"github.com/Sycun/GongYuAI/services/netd/internal/ring"
	"github.com/Sycun/GongYuAI/services/netd/internal/store"
	"github.com/Sycun/GongYuAI/services/netd/internal/tlsmitm"
)

func newProxyClient(t *testing.T, port int) *http.Client {
	t.Helper()
	u, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(u),
		},
	}
}

func TestModeAllAndFindingWindowStaticCompaction(t *testing.T) {
	tlsMgr := tlsmitm.NewManager(64)
	sm := store.NewStoreManager()
	defer sm.CloseAll()
	rm := ring.NewManager(sm)
	pm := proxy.NewManager(tlsMgr, sm, rm)
	defer pm.StopAll()

	if _, err := pm.Start(proxy.StartOptions{}); err == nil {
		t.Fatal("expected missing taskId/taskDir error")
	}
	if _, err := pm.Start(proxy.StartOptions{TaskID: "t1", TaskDir: t.TempDir(), Upstream: "socks5://127.0.0.1:1080"}); err == nil {
		t.Fatal("expected non-http upstream error")
	}

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".png") {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("PNGDATA"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, `{"echo":%q,"path":%q}`, string(body), r.URL.Path)
	}))
	defer origin.Close()

	// 1) mode="all" persists directly into SQLite with updated worker/intent context
	taskAll := t.TempDir()
	instAll, err := pm.Start(proxy.StartOptions{
		TaskID:   "task-all",
		TaskDir:  taskAll,
		WorkerID: "w-init",
		Mode:     "all",
	})
	if err != nil {
		t.Fatal(err)
	}
	wNew := "w-updated"
	iNew := "intent-42"
	instAll.SetContext(&wNew, &iNew)

	cliAll := newProxyClient(t, instAll.Port)
	resp, err := cliAll.Post(origin.URL+"/api/submit", "text/plain", strings.NewReader("payload-123"))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("mode=all POST failed: resp=%+v err=%v", resp, err)
	}
	_ = resp.Body.Close()

	dbPage, err := sm.QueryTraffic(taskAll, store.TrafficQuery{TaskID: "task-all"})
	if err != nil || dbPage.Total != 1 || dbPage.Traffic[0].WorkerID != "w-updated" || dbPage.Traffic[0].IntentID != "intent-42" {
		t.Fatalf("expected persisted exchange with updated context, got %+v err=%v", dbPage, err)
	}

	// 2) mode="finding-window" skips static .png in ring, then auto-persists matching window exchange
	taskWin := t.TempDir()
	instWin, err := pm.Start(proxy.StartOptions{
		TaskID:   "task-win",
		TaskDir:  taskWin,
		WorkerID: "w-1",
		IntentID: "intent-win",
		Mode:     "finding-window",
	})
	if err != nil {
		t.Fatal(err)
	}
	cliWin := newProxyClient(t, instWin.Port)

	// Static asset should stream to client but be skipped from ring
	resPng, err := cliWin.Get(origin.URL + "/logo.png")
	if err != nil || resPng.StatusCode != 200 {
		t.Fatalf("static GET failed: %v", err)
	}
	_ = resPng.Body.Close()
	if sz := rm.Size(taskWin); sz != 0 {
		t.Fatalf("expected static PNG to be skipped from ring, got size=%d", sz)
	}

	// Open active window for intent-win -> next API exchange goes straight to SQLite with findingId
	rm.OpenWindow(ring.OpenWindowOptions{
		TaskDir:   taskWin,
		FindingID: "finding-sqli",
		IntentID:  "intent-win",
	})
	resAPI, err := cliWin.Get(origin.URL + "/api/check?id=1")
	if err != nil || resAPI.StatusCode != 200 {
		t.Fatalf("windowed GET failed: %v", err)
	}
	_ = resAPI.Body.Close()

	winPage, err := sm.QueryTraffic(taskWin, store.TrafficQuery{TaskID: "task-win", FindingID: "finding-sqli"})
	if err != nil || winPage.Total != 1 {
		t.Fatalf("expected open window exchange to persist with finding-sqli, got %+v err=%v", winPage, err)
	}
}
