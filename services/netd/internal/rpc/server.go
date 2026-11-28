package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/httpeng"
	"github.com/Sycun/GongYuAI/services/netd/internal/oast"
	"github.com/Sycun/GongYuAI/services/netd/internal/proxy"
	"github.com/Sycun/GongYuAI/services/netd/internal/ring"
	"github.com/Sycun/GongYuAI/services/netd/internal/store"
	"github.com/Sycun/GongYuAI/services/netd/internal/tlsmitm"
	"github.com/Sycun/GongYuAI/services/netd/internal/tunnel"
)

const Version = "0.2.0"

type Server struct {
	startedAt time.Time
	tlsMgr    *tlsmitm.Manager
	storeMgr  *store.StoreManager
	ringMgr   *ring.Manager
	proxyMgr  *proxy.Manager
	httpEng   *httpeng.Engine
	oastMgr   *oast.Manager
	tunnelMgr *tunnel.Manager
	shutdown  func()
}

func NewServer(
	tlsMgr *tlsmitm.Manager,
	storeMgr *store.StoreManager,
	ringMgr *ring.Manager,
	proxyMgr *proxy.Manager,
	httpEng *httpeng.Engine,
	oastMgr *oast.Manager,
	tunnelMgr *tunnel.Manager,
	shutdown func(),
) *Server {
	return &Server{
		startedAt: time.Now(),
		tlsMgr:    tlsMgr,
		storeMgr:  storeMgr,
		ringMgr:   ringMgr,
		proxyMgr:  proxyMgr,
		httpEng:   httpEng,
		oastMgr:   oastMgr,
		tunnelMgr: tunnelMgr,
		shutdown:  shutdown,
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	msg := "error"
	if err != nil {
		msg = err.Error()
	}
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func decodeBody(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.handleHealth)
	mux.HandleFunc("/v1/shutdown", s.handleShutdown)
	mux.HandleFunc("/v1/tls/leaf", s.handleTLSLeaf)
	mux.HandleFunc("/v1/proxy/start", s.handleProxyStart)
	mux.HandleFunc("/v1/proxy/", s.handleProxySub)
	mux.HandleFunc("/v1/traffic/ring/size", s.handleRingSize)
	mux.HandleFunc("/v1/traffic/ring/clear", s.handleRingClear)
	mux.HandleFunc("/v1/traffic/ring/query", s.handleRingQuery)
	mux.HandleFunc("/v1/traffic/query-live", s.handleQueryLive)
	mux.HandleFunc("/v1/traffic/get-live", s.handleGetLive)
	mux.HandleFunc("/v1/traffic/body-live", s.handleBodyLive)
	mux.HandleFunc("/v1/traffic/promote", s.handlePromote)
	mux.HandleFunc("/v1/traffic/window/open", s.handleWindowOpen)
	mux.HandleFunc("/v1/traffic/window/close", s.handleWindowClose)
	mux.HandleFunc("/v1/traffic/window/active", s.handleWindowActive)
	mux.HandleFunc("/v1/http/request", s.handleHTTPRequest)
	mux.HandleFunc("/v1/http/batch", s.handleHTTPBatch)
	mux.HandleFunc("/v1/oast/http/start", s.handleOastHTTPStart)
	mux.HandleFunc("/v1/oast/http/", s.handleOastHTTPSub)
	mux.HandleFunc("/v1/oast/dns/start", s.handleOastDNSStart)
	mux.HandleFunc("/v1/oast/dns/", s.handleOastDNSSub)
	mux.HandleFunc("/v1/tunnel/start", s.handleTunnelStart)
	mux.HandleFunc("/v1/tunnel/list", s.handleTunnelList)
	mux.HandleFunc("/v1/tunnel/", s.handleTunnelSub)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	oastHTTP, oastDNS := 0, 0
	if s.oastMgr != nil {
		oastHTTP, oastDNS = s.oastMgr.Counts()
	}
	tunnels := 0
	if s.tunnelMgr != nil {
		tunnels = s.tunnelMgr.Count()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"version":        Version,
		"pid":            os.Getpid(),
		"uptimeMs":       time.Since(s.startedAt).Milliseconds(),
		"proxies":        s.proxyMgr.Count(),
		"oastHttp":       oastHTTP,
		"oastDns":        oastDNS,
		"tunnels":        tunnels,
		"certCacheSize":  s.tlsMgr.CacheSize(),
		"heapAllocBytes": mem.HeapAlloc,
		"sysBytes":       mem.Sys,
	})
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	if s.shutdown != nil {
		go func() {
			time.Sleep(15 * time.Millisecond)
			s.shutdown()
		}()
	}
}

func (s *Server) handleTLSLeaf(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string `json:"taskDir"`
		Host    string `json:"host"`
		Subject string `json:"subject,omitempty"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	ca, err := s.tlsMgr.EnsureCA(body.TaskDir, body.Subject)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	leaf, err := s.tlsMgr.LeafCert(ca, body.Host)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"caPath":   ca.CertPath,
		"subject":  leaf.Leaf.Subject.CommonName,
		"notAfter": leaf.Leaf.NotAfter.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleProxyStart(w http.ResponseWriter, r *http.Request) {
	var opts proxy.StartOptions
	if err := decodeBody(r, &opts); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	inst, err := s.proxyMgr.Start(opts)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"proxyId":  inst.ID,
		"port":     inst.Port,
		"caPath":   inst.CAPath,
		"proxyUrl": fmt.Sprintf("http://127.0.0.1:%d", inst.Port),
	})
}

func (s *Server) handleProxySub(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/v1/proxy/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
		return
	}
	proxyID, action := parts[0], parts[1]
	inst := s.proxyMgr.Get(proxyID)
	if inst == nil {
		if action == "stop" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "proxy not found"})
		return
	}
	switch action {
	case "stop":
		if err := s.proxyMgr.Stop(proxyID); err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "upstream":
		var body struct {
			Upstream *string `json:"upstream"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		up := ""
		if body.Upstream != nil {
			up = *body.Upstream
		}
		if err := inst.SetUpstream(up); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "context":
		var body struct {
			WorkerID *string `json:"workerId"`
			IntentID *string `json:"intentId"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		inst.SetContext(body.WorkerID, body.IntentID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown proxy action"})
	}
}

func (s *Server) handleRingSize(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string `json:"taskDir"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "size": s.ringMgr.Size(body.TaskDir)})
}

func (s *Server) handleRingClear(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string `json:"taskDir,omitempty"`
	}
	_ = decodeBody(r, &body)
	s.ringMgr.Clear(body.TaskDir)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRingQuery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string             `json:"taskDir"`
		Query   store.TrafficQuery `json:"query"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"traffic": s.ringMgr.QueryRing(body.TaskDir, body.Query),
	})
}

func (s *Server) handleQueryLive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string             `json:"taskDir"`
		Query   store.TrafficQuery `json:"query"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	page, err := s.ringMgr.QueryLive(body.TaskDir, body.Query)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) handleGetLive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string `json:"taskDir"`
		ID      string `json:"id"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	rec, hot, err := s.ringMgr.GetLive(body.TaskDir, body.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "record": rec, "hot": hot})
}

func (s *Server) handleBodyLive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir  string `json:"taskDir"`
		ID       string `json:"id"`
		Side     string `json:"side"`
		Offset   int    `json:"offset"`
		MaxBytes int    `json:"maxBytes"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	slice, status, err := s.ringMgr.ReadBodyLive(body.TaskDir, body.ID, body.Side, body.Offset, body.MaxBytes)
	if err != nil {
		writeErr(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, slice)
}

func (s *Server) handlePromote(w http.ResponseWriter, r *http.Request) {
	var opts ring.PromoteOptions
	if err := decodeBody(r, &opts); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	res, err := s.ringMgr.PromoteForFinding(opts)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleWindowOpen(w http.ResponseWriter, r *http.Request) {
	var opts ring.OpenWindowOptions
	if err := decodeBody(r, &opts); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	win := s.ringMgr.OpenWindow(opts)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "window": win})
}

func (s *Server) handleWindowClose(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir   string `json:"taskDir"`
		FindingID string `json:"findingId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "closed": s.ringMgr.CloseWindow(body.TaskDir, body.FindingID)})
}

func (s *Server) handleWindowActive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskDir string `json:"taskDir"`
		NowMs   int64  `json:"nowMs,omitempty"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"windows": s.ringMgr.ActiveWindows(body.TaskDir, body.NowMs),
	})
}

func (s *Server) handleHTTPRequest(w http.ResponseWriter, r *http.Request) {
	var input httpeng.RequestInput
	if err := decodeBody(r, &input); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	res, err := s.httpEng.Perform(r.Context(), input)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleHTTPBatch(w http.ResponseWriter, r *http.Request) {
	var input httpeng.BatchInput
	if err := decodeBody(r, &input); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	res := s.httpEng.PerformBatch(context.Background(), input)
	writeJSON(w, http.StatusOK, res)
}

func streamOastHits(w http.ResponseWriter, r *http.Request, sub func() (chan oast.Hit, []oast.Hit, func())) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)
	if fl != nil {
		fl.Flush()
	}
	ch, existing, unsub := sub()
	defer unsub()
	enc := json.NewEncoder(w)
	for _, h := range existing {
		if err := enc.Encode(h); err != nil {
			return
		}
		if fl != nil {
			fl.Flush()
		}
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case h, ok := <-ch:
			if !ok {
				return
			}
			if err := enc.Encode(h); err != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
		}
	}
}

func (s *Server) handleOastHTTPStart(w http.ResponseWriter, r *http.Request) {
	var opts oast.HTTPOptions
	if err := decodeBody(r, &opts); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	inst, err := s.oastMgr.StartHTTP(opts)
	if err != nil {
		if le, ok := err.(*oast.ListenError); ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": le.Msg, "code": le.Code})
			return
		}
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"id":            inst.ID,
		"port":          inst.Port,
		"boundUrl":      inst.BoundURL,
		"publicBaseUrl": inst.PublicBaseURL,
	})
}

func (s *Server) handleOastHTTPSub(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/v1/oast/http/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
		return
	}
	id, action := parts[0], parts[1]
	inst := s.oastMgr.GetHTTP(id)
	if inst == nil {
		if action == "stop" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "oast http listener not found"})
		return
	}
	switch action {
	case "stop":
		s.oastMgr.StopHTTP(id)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "hits":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hits": inst.Hits()})
	case "events":
		streamOastHits(w, r, inst.Subscribe)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown oast action"})
	}
}

func (s *Server) handleOastDNSStart(w http.ResponseWriter, r *http.Request) {
	var opts oast.DNSOptions
	if err := decodeBody(r, &opts); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	inst, err := s.oastMgr.StartDNS(opts)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"id":     inst.ID,
		"port":   inst.Port,
		"domain": inst.Domain,
	})
}

func (s *Server) handleOastDNSSub(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/v1/oast/dns/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
		return
	}
	id, action := parts[0], parts[1]
	inst := s.oastMgr.GetDNS(id)
	if inst == nil {
		if action == "stop" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "oast dns listener not found"})
		return
	}
	switch action {
	case "stop":
		s.oastMgr.StopDNS(id)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "hits":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hits": inst.Hits()})
	case "events":
		streamOastHits(w, r, inst.Subscribe)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown oast dns action"})
	}
}

func (s *Server) handleTunnelStart(w http.ResponseWriter, r *http.Request) {
	var opts tunnel.StartOptions
	if err := decodeBody(r, &opts); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	info, err := s.tunnelMgr.Start(opts)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tunnel": info})
}

func (s *Server) handleTunnelList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tunnels": s.tunnelMgr.List()})
}

func (s *Server) handleTunnelSub(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/v1/tunnel/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 || parts[1] != "stop" {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
		return
	}
	stopped := s.tunnelMgr.Stop(parts[0])
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stopped": stopped})
}
