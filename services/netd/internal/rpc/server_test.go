package rpc_test

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/Sycun/GongYuAI/services/netd/internal/httpeng"
	"github.com/Sycun/GongYuAI/services/netd/internal/oast"
	"github.com/Sycun/GongYuAI/services/netd/internal/proxy"
	"github.com/Sycun/GongYuAI/services/netd/internal/ring"
	"github.com/Sycun/GongYuAI/services/netd/internal/rpc"
	"github.com/Sycun/GongYuAI/services/netd/internal/store"
	"github.com/Sycun/GongYuAI/services/netd/internal/tlsmitm"
	"github.com/Sycun/GongYuAI/services/netd/internal/tunnel"
)

func newTestRPC(t *testing.T) (*httptest.Server, func()) {
	t.Helper()
	tlsMgr := tlsmitm.NewManager(256)
	storeMgr := store.NewStoreManager()
	ringMgr := ring.NewManager(storeMgr)
	proxyMgr := proxy.NewManager(tlsMgr, storeMgr, ringMgr)
	httpEng := httpeng.NewEngine()
	oastMgr := oast.NewManager()
	tunnelMgr := tunnel.NewManager()
	srv := rpc.NewServer(tlsMgr, storeMgr, ringMgr, proxyMgr, httpEng, oastMgr, tunnelMgr, nil)
	ts := httptest.NewServer(srv.Handler())
	cleanup := func() {
		ts.Close()
		proxyMgr.StopAll()
		oastMgr.StopAll()
		tunnelMgr.StopAll()
		httpEng.Close()
		storeMgr.CloseAll()
	}
	return ts, cleanup
}

func postJSON(t *testing.T, baseURL, path string, body any, out any) int {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(baseURL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("post %s: %v", path, err)
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
	return resp.StatusCode
}

func TestProxyHTTPSAndFindingWindow(t *testing.T) {
	rpcSrv, cleanup := newTestRPC(t)
	defer cleanup()

	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"path":%q,"secret":"tok-999"}`, r.URL.Path)
	}))
	defer origin.Close()

	taskDir := t.TempDir()
	taskID := "6460e5ec-1a8c-4b95-b4e3-d77a02c79680"

	var startResp struct {
		OK       bool   `json:"ok"`
		ProxyID  string `json:"proxyId"`
		Port     int    `json:"port"`
		CAPath   string `json:"caPath"`
		ProxyURL string `json:"proxyUrl"`
	}
	code := postJSON(t, rpcSrv.URL, "/v1/proxy/start", map[string]any{
		"taskId":           taskID,
		"taskDir":          taskDir,
		"workerId":         "w0",
		"mode":             "finding-window",
		"insecureUpstream": true,
	}, &startResp)
	if code != 200 || !startResp.OK || startResp.Port == 0 {
		t.Fatalf("unexpected start response: %d %+v", code, startResp)
	}
	defer postJSON(t, rpcSrv.URL, "/v1/proxy/"+startResp.ProxyID+"/stop", map[string]any{}, nil)

	caPEM, err := os.ReadFile(startResp.CAPath)
	if err != nil {
		t.Fatalf("read ca: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		t.Fatal("failed to parse generated CA")
	}
	pURL, _ := url.Parse(startResp.ProxyURL)
	client := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(pURL),
			TLSClientConfig: &tls.Config{
				RootCAs: pool,
			},
		},
	}
	resp, err := client.Get(origin.URL + "/api/check")
	if err != nil {
		t.Fatalf("https via mitm proxy: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("tok-999")) {
		t.Fatalf("unexpected body: %d %s", resp.StatusCode, string(body))
	}

	var live ring.LiveTrafficPage
	postJSON(t, rpcSrv.URL, "/v1/traffic/query-live", map[string]any{
		"taskDir": taskDir,
		"query":   map[string]any{"taskId": taskID, "keyword": "tok-999"},
	}, &live)
	if len(live.Traffic) != 1 || len(live.HotIDs) != 1 {
		t.Fatalf("expected 1 hot traffic hit, got %+v", live)
	}

	var promoted ring.PromoteResult
	postJSON(t, rpcSrv.URL, "/v1/traffic/promote", map[string]any{
		"taskDir":    taskDir,
		"findingId":  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"trafficIds": live.HotIDs,
		"host":       "127.0.0.1",
	}, &promoted)
	if promoted.Promoted != 1 {
		t.Fatalf("expected 1 promoted, got %+v", promoted)
	}

	if _, err := os.Stat(filepath.Join(taskDir, "traffic", "index.sqlite")); err != nil {
		t.Fatalf("index.sqlite missing after promote: %v", err)
	}
}

func TestHTTPRequestAndBatch(t *testing.T) {
	rpcSrv, cleanup := newTestRPC(t)
	defer cleanup()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redir" {
			http.Redirect(w, r, "/final", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = fmt.Fprintf(w, "ok:%s:%s", r.Method, r.URL.Path)
	}))
	defer origin.Close()

	evDir := t.TempDir()
	var res httpeng.RequestResult
	code := postJSON(t, rpcSrv.URL, "/v1/http/request", map[string]any{
		"method":      "POST",
		"url":         origin.URL + "/redir",
		"body":        "hello",
		"evidenceDir": evDir,
		"scope":       map[string]any{"allowHosts": []string{"127.0.0.1"}},
	}, &res)
	if code != 200 || res.Artifact.Status != 200 || res.BodyHead != "ok:GET:/final" {
		t.Fatalf("unexpected http result: %d %+v", code, res)
	}
	if _, err := os.Stat(filepath.Join(evDir, res.Artifact.RequestPath)); err != nil {
		t.Fatalf("missing request blob: %v", err)
	}
	if _, err := os.Stat(filepath.Join(evDir, res.Artifact.ResponsePath)); err != nil {
		t.Fatalf("missing response blob: %v", err)
	}

	items := make([]map[string]any, 12)
	for i := range items {
		items[i] = map[string]any{
			"url":         fmt.Sprintf("%s/item/%d", origin.URL, i),
			"evidenceDir": evDir,
			"scope":       map[string]any{"allowHosts": []string{"127.0.0.1"}},
		}
	}
	var batch httpeng.BatchResult
	code = postJSON(t, rpcSrv.URL, "/v1/http/batch", map[string]any{
		"concurrency": 6,
		"items":       items,
	}, &batch)
	if code != 200 || len(batch.Results) != 12 {
		t.Fatalf("unexpected batch result: %d len=%d", code, len(batch.Results))
	}
	for i, item := range batch.Results {
		want := fmt.Sprintf("ok:GET:/item/%d", i)
		if !item.OK || item.Result == nil || item.Result.BodyHead != want {
			t.Fatalf("batch[%d] mismatch: %+v", i, item)
		}
	}

	// Ensure TLS leaf cert endpoint works fast for IP and DNS hosts
	leafDir := t.TempDir()
	for _, h := range []string{"127.0.0.1", "sub.example.invalid"} {
		var lr map[string]any
		if c := postJSON(t, rpcSrv.URL, "/v1/tls/leaf", map[string]any{"taskDir": leafDir, "host": h}, &lr); c != 200 {
			t.Fatalf("leaf %s failed: %d %+v", h, c, lr)
		}
	}
	_ = net.IPv4(127, 0, 0, 1)
}

func TestOastAndLocalTunnel(t *testing.T) {
	rpcSrv, cleanup := newTestRPC(t)
	defer cleanup()

	// 1) OAST HTTP listener
	var oastStart struct {
		OK       bool   `json:"ok"`
		ID       string `json:"id"`
		Port     int    `json:"port"`
		BoundURL string `json:"boundUrl"`
	}
	if c := postJSON(t, rpcSrv.URL, "/v1/oast/http/start", map[string]any{
		"listenHost":    "127.0.0.1",
		"listenPort":    0,
		"publicBaseUrl": "http://127.0.0.1:8799",
	}, &oastStart); c != 200 || !oastStart.OK {
		t.Fatalf("oast start failed: %d %+v", c, oastStart)
	}
	defer postJSON(t, rpcSrv.URL, "/v1/oast/http/"+oastStart.ID+"/stop", map[string]any{}, nil)

	resp, err := http.Get(oastStart.BoundURL + "/t/tok-go-12345")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("oast callback failed: %v %+v", err, resp)
	}
	_ = resp.Body.Close()

	var hitsResp struct {
		OK   bool       `json:"ok"`
		Hits []oast.Hit `json:"hits"`
	}
	postJSON(t, rpcSrv.URL, "/v1/oast/http/"+oastStart.ID+"/hits", map[string]any{}, &hitsResp)
	if len(hitsResp.Hits) != 1 || hitsResp.Hits[0].Token != "tok-go-12345" {
		t.Fatalf("unexpected oast hits: %+v", hitsResp)
	}

	// 2) Local TCP tunnel forwarder
	echoSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "through-go-tunnel")
	}))
	defer echoSrv.Close()
	echoURL, _ := url.Parse(echoSrv.URL)
	_, echoPortStr, _ := net.SplitHostPort(echoURL.Host)
	var echoPort int
	_, _ = fmt.Sscanf(echoPortStr, "%d", &echoPort)

	var tunStart struct {
		OK     bool        `json:"ok"`
		Tunnel tunnel.Info `json:"tunnel"`
	}
	if c := postJSON(t, rpcSrv.URL, "/v1/tunnel/start", map[string]any{
		"kind":       "tcp",
		"targetHost": "127.0.0.1",
		"targetPort": echoPort,
	}, &tunStart); c != 200 || !tunStart.OK || tunStart.Tunnel.LocalPort == 0 {
		t.Fatalf("tunnel start failed: %d %+v", c, tunStart)
	}
	defer postJSON(t, rpcSrv.URL, "/v1/tunnel/"+tunStart.Tunnel.ID+"/stop", map[string]any{}, nil)

	tResp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", tunStart.Tunnel.LocalPort))
	if err != nil {
		t.Fatalf("request via go tunnel: %v", err)
	}
	tBody, _ := io.ReadAll(tResp.Body)
	_ = tResp.Body.Close()
	if string(tBody) != "through-go-tunnel" {
		t.Fatalf("unexpected tunnel body: %q", string(tBody))
	}
}
