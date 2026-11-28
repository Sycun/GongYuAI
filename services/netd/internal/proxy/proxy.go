package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/ring"
	"github.com/Sycun/GongYuAI/services/netd/internal/store"
	"github.com/Sycun/GongYuAI/services/netd/internal/tlsmitm"
)

var hopByHop = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"proxy-connection":    true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

type StartOptions struct {
	TaskID           string                 `json:"taskId"`
	TaskDir          string                 `json:"taskDir"`
	WorkerID         string                 `json:"workerId,omitempty"`
	IntentID         string                 `json:"intentId,omitempty"`
	Upstream         string                 `json:"upstream,omitempty"`
	InsecureUpstream bool                   `json:"insecureUpstream,omitempty"`
	Mode             string                 `json:"mode,omitempty"`
	Retention        *store.RetentionConfig `json:"retention,omitempty"`
	WindowConfig     *ring.WindowConfig     `json:"windowConfig,omitempty"`
}

type Instance struct {
	ID               string
	TaskID           string
	TaskDir          string
	Port             int
	CAPath           string
	Mode             string
	InsecureUpstream bool
	Retention        store.RetentionConfig
	WindowCfg        ring.WindowConfig

	ca     *tlsmitm.TaskCA
	tlsMgr *tlsmitm.Manager
	store  *store.StoreManager
	ring   *ring.Manager

	ln     net.Listener
	srv    *http.Server
	mu     sync.RWMutex
	worker string
	intent string
	upURL  *url.URL
	tr     *http.Transport
	conns  map[net.Conn]struct{}
	closed bool
}

type Manager struct {
	mu      sync.Mutex
	proxies map[string]*Instance
	tlsMgr  *tlsmitm.Manager
	store   *store.StoreManager
	ring    *ring.Manager
}

func NewManager(tlsMgr *tlsmitm.Manager, sm *store.StoreManager, rm *ring.Manager) *Manager {
	return &Manager{
		proxies: make(map[string]*Instance),
		tlsMgr:  tlsMgr,
		store:   sm,
		ring:    rm,
	}
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.proxies)
}

func parseUpstreamURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, nil
	}
	u, err := url.Parse(s)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "http" {
		return nil, errors.New("upstream proxy must be an http:// URL")
	}
	return u, nil
}

func makeTransport(up *url.URL, insecure bool) *http.Transport {
	tr := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: insecure,
		},
	}
	if up != nil {
		tr.Proxy = http.ProxyURL(up)
	}
	return tr
}

func (m *Manager) Start(opts StartOptions) (*Instance, error) {
	if strings.TrimSpace(opts.TaskID) == "" || strings.TrimSpace(opts.TaskDir) == "" {
		return nil, errors.New("taskId and taskDir are required")
	}
	upURL, err := parseUpstreamURL(opts.Upstream)
	if err != nil {
		return nil, err
	}
	ca, err := m.tlsMgr.EnsureCA(opts.TaskDir, "")
	if err != nil {
		return nil, err
	}
	mode := strings.ToLower(strings.TrimSpace(opts.Mode))
	if mode != "all" {
		mode = "finding-window"
	}
	ret := store.DefaultRetention()
	if opts.Retention != nil {
		ret = *opts.Retention
	}
	winCfg := ring.DefaultWindowConfig()
	if opts.WindowConfig != nil {
		winCfg = *opts.WindowConfig
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !tcpAddr.IP.Equal(net.ParseIP("127.0.0.1")) {
		_ = ln.Close()
		return nil, errors.New("traffic proxy must listen on 127.0.0.1")
	}

	inst := &Instance{
		ID:               store.NewUUID(),
		TaskID:           opts.TaskID,
		TaskDir:          filepath.Clean(opts.TaskDir),
		Port:             tcpAddr.Port,
		CAPath:           ca.CertPath,
		Mode:             mode,
		InsecureUpstream: opts.InsecureUpstream,
		Retention:        ret,
		WindowCfg:        winCfg,
		ca:               ca,
		tlsMgr:           m.tlsMgr,
		store:            m.store,
		ring:             m.ring,
		ln:               ln,
		worker:           opts.WorkerID,
		intent:           opts.IntentID,
		upURL:            upURL,
		tr:               makeTransport(upURL, opts.InsecureUpstream),
		conns:            make(map[net.Conn]struct{}),
	}
	inst.srv = &http.Server{
		Handler:           http.HandlerFunc(inst.serveHTTP),
		ReadHeaderTimeout: 30 * time.Second,
	}

	m.mu.Lock()
	m.proxies[inst.ID] = inst
	m.mu.Unlock()

	go func() {
		_ = inst.srv.Serve(ln)
	}()
	return inst, nil
}

func (m *Manager) Get(id string) *Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.proxies[id]
}

func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	inst, ok := m.proxies[id]
	if ok {
		delete(m.proxies, id)
	}
	m.mu.Unlock()
	if !ok {
		return nil
	}
	return inst.Close()
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	all := make([]*Instance, 0, len(m.proxies))
	for _, p := range m.proxies {
		all = append(all, p)
	}
	m.proxies = make(map[string]*Instance)
	m.mu.Unlock()
	for _, p := range all {
		_ = p.Close()
	}
}

func (inst *Instance) SetUpstream(raw string) error {
	up, err := parseUpstreamURL(raw)
	if err != nil {
		return err
	}
	newTr := makeTransport(up, inst.InsecureUpstream)
	inst.mu.Lock()
	oldTr := inst.tr
	inst.upURL = up
	inst.tr = newTr
	inst.mu.Unlock()
	if oldTr != nil {
		oldTr.CloseIdleConnections()
	}
	return nil
}

func (inst *Instance) SetContext(workerID, intentID *string) {
	inst.mu.Lock()
	if workerID != nil {
		inst.worker = *workerID
	}
	if intentID != nil {
		inst.intent = *intentID
	}
	inst.mu.Unlock()
}

func (inst *Instance) Close() error {
	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return nil
	}
	inst.closed = true
	conns := make([]net.Conn, 0, len(inst.conns))
	for c := range inst.conns {
		conns = append(conns, c)
	}
	inst.conns = make(map[net.Conn]struct{})
	tr := inst.tr
	inst.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = inst.srv.Shutdown(ctx)
	_ = inst.ln.Close()
	for _, c := range conns {
		_ = c.Close()
	}
	if tr != nil {
		tr.CloseIdleConnections()
	}
	inst.store.CloseTask(inst.TaskDir)
	return nil
}

func (inst *Instance) trackConn(c net.Conn) {
	inst.mu.Lock()
	if !inst.closed {
		inst.conns[c] = struct{}{}
	}
	inst.mu.Unlock()
}

func (inst *Instance) untrackConn(c net.Conn) {
	inst.mu.Lock()
	delete(inst.conns, c)
	inst.mu.Unlock()
}

func headersToMap(h http.Header) map[string]any {
	out := make(map[string]any, len(h))
	for k, vals := range h {
		lk := strings.ToLower(k)
		if hopByHop[lk] || len(vals) == 0 {
			continue
		}
		if len(vals) == 1 {
			out[lk] = vals[0]
		} else {
			cp := make([]string, len(vals))
			copy(cp, vals)
			out[lk] = cp
		}
	}
	return out
}

func copyUpstreamHeaders(dst http.Header, src http.Header) {
	for k, vals := range src {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

func (inst *Instance) serveHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Method == http.MethodConnect {
		inst.handleConnect(w, req)
		return
	}
	var target *url.URL
	var err error
	if req.URL.Scheme != "" && req.URL.Host != "" {
		target = req.URL
	} else {
		host := req.Host
		if host == "" {
			http.Error(w, "proxy request is missing a host", http.StatusBadGateway)
			return
		}
		target, err = url.Parse("http://" + host + req.URL.RequestURI())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	inst.forwardAndRecord(w, req, target)
}

func splitHostPortDefault(authority, defaultPort string) (string, string) {
	if h, p, err := net.SplitHostPort(authority); err == nil {
		if p == "" {
			p = defaultPort
		}
		return h, p
	}
	return strings.Trim(authority, "[]"), defaultPort
}

func (inst *Instance) handleConnect(w http.ResponseWriter, req *http.Request) {
	host, port := splitHostPortDefault(req.Host, "443")
	if host == "" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, bufRW, err := hj.Hijack()
	if err != nil {
		return
	}
	inst.trackConn(clientConn)
	defer func() {
		inst.untrackConn(clientConn)
		_ = clientConn.Close()
	}()

	if _, err := io.WriteString(clientConn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}

	var baseConn net.Conn = clientConn
	if bufRW != nil && bufRW.Reader.Buffered() > 0 {
		baseConn = &bufferedConn{Conn: clientConn, r: bufRW.Reader}
	}

	tlsCfg := &tls.Config{
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			name := host
			if hello != nil && strings.TrimSpace(hello.ServerName) != "" {
				name = hello.ServerName
			}
			return inst.tlsMgr.LeafCert(inst.ca, name)
		},
	}
	tlsConn := tls.Server(baseConn, tlsCfg)
	if err := tlsConn.Handshake(); err != nil {
		return
	}

	br := bufio.NewReader(tlsConn)
	for {
		innerReq, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		targetHost := host
		if port != "443" {
			targetHost = net.JoinHostPort(host, port)
		}
		target, err := url.Parse("https://" + targetHost + innerReq.URL.RequestURI())
		if err != nil {
			_ = innerReq.Body.Close()
			return
		}
		rw := newConnResponseWriter(tlsConn, innerReq)
		inst.forwardAndRecord(rw, innerReq, target)
		_ = innerReq.Body.Close()
		rw.finish()
		if innerReq.Close || rw.closeAfter {
			return
		}
	}
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) {
	return b.r.Read(p)
}

type connResponseWriter struct {
	conn        net.Conn
	req         *http.Request
	header      http.Header
	wroteHeader bool
	chunked     bool
	closeAfter  bool
}

func newConnResponseWriter(conn net.Conn, req *http.Request) *connResponseWriter {
	return &connResponseWriter{
		conn:   conn,
		req:    req,
		header: make(http.Header),
	}
}

func (w *connResponseWriter) Header() http.Header { return w.header }

func (w *connResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	statusText := http.StatusText(status)
	if statusText == "" {
		statusText = "Status"
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "HTTP/1.1 %d %s\r\n", status, statusText)
	hasCL := w.header.Get("Content-Length") != ""
	if !hasCL && status != http.StatusNoContent && status != http.StatusNotModified && w.req.Method != http.MethodHead {
		if w.req.Close {
			w.closeAfter = true
			w.header.Set("Connection", "close")
		} else {
			w.chunked = true
			w.header.Set("Transfer-Encoding", "chunked")
		}
	}
	for k, vals := range w.header {
		for _, v := range vals {
			fmt.Fprintf(&sb, "%s: %s\r\n", k, v)
		}
	}
	sb.WriteString("\r\n")
	_, _ = io.WriteString(w.conn, sb.String())
}

func (w *connResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if len(p) == 0 {
		return 0, nil
	}
	if w.chunked {
		if _, err := fmt.Fprintf(w.conn, "%x\r\n", len(p)); err != nil {
			return 0, err
		}
		n, err := w.conn.Write(p)
		if err != nil {
			return n, err
		}
		if _, err := io.WriteString(w.conn, "\r\n"); err != nil {
			return n, err
		}
		return n, nil
	}
	return w.conn.Write(p)
}

func (w *connResponseWriter) finish() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.chunked {
		_, _ = io.WriteString(w.conn, "0\r\n\r\n")
	}
}

func captureReader(r io.Reader, capBytes int, contentType string) ([]byte, *ring.CapturedBody, error) {
	if r == nil {
		return nil, &ring.CapturedBody{SHA256: emptySHA256, ContentType: contentType}, nil
	}
	var full bytes.Buffer
	h := sha256.New()
	var head bytes.Buffer
	var total int64
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = h.Write(chunk)
			_, _ = full.Write(chunk)
			total += int64(n)
			if head.Len() < capBytes {
				take := capBytes - head.Len()
				if take > n {
					take = n
				}
				_, _ = head.Write(chunk[:take])
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
	}
	return full.Bytes(), &ring.CapturedBody{
		Head:        head.Bytes(),
		Size:        total,
		SHA256:      hex.EncodeToString(h.Sum(nil)),
		ContentType: contentType,
	}, nil
}

var emptySHA256 = func() string {
	s := sha256.Sum256(nil)
	return hex.EncodeToString(s[:])
}()

func spoolStreamToFile(taskDir string, r io.Reader, dst io.Writer, contentType string, maxPreview int, headers map[string]any) (*store.TrafficBlobRef, string, error) {
	if r == nil {
		return nil, "", nil
	}
	tmpDir := filepath.Join(taskDir, "traffic", "_tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, "", err
	}
	tmpPath := filepath.Join(tmpDir, store.NewUUID())
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, "", err
	}
	previewCap := maxPreview
	if previewCap > 8192 {
		previewCap = 8192
	}
	if previewCap < 0 {
		previewCap = 0
	}
	rawPreviewCap := previewCap
	if previewCap > 0 && store.HasSupportedContentEncoding(headers) {
		rawPreviewCap = 64 * 1024
	}
	var preview bytes.Buffer
	h := sha256.New()
	var total int64
	buf := make([]byte, 32*1024)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = h.Write(chunk)
			total += int64(n)
			if rawPreviewCap > 0 && preview.Len() < rawPreviewCap {
				take := rawPreviewCap - preview.Len()
				if take > n {
					take = n
				}
				_, _ = preview.Write(chunk[:take])
			}
			if _, werr := f.Write(chunk); werr != nil {
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return nil, "", werr
			}
			if dst != nil {
				if _, werr := dst.Write(chunk); werr != nil {
					_ = f.Close()
					_ = os.Remove(tmpPath)
					return nil, "", werr
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return nil, "", rerr
		}
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return nil, "", err
	}
	ref, err := store.CommitHashedFile(taskDir, tmpPath, hex.EncodeToString(h.Sum(nil)), total, contentType)
	if err != nil {
		return nil, "", err
	}
	prevText := ""
	if previewCap > 0 && preview.Len() > 0 {
		prevText = store.DecodeTrafficPreview(preview.Bytes(), headers, previewCap)
	}
	return ref, prevText, nil
}

func (inst *Instance) forwardAndRecord(w http.ResponseWriter, req *http.Request, target *url.URL) {
	started := time.Now()
	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	reqHeadersMap := headersToMap(req.Header)
	reqCT := store.ContentTypeBase(reqHeadersMap)

	inst.mu.RLock()
	tr := inst.tr
	workerID := inst.worker
	intentID := inst.intent
	inst.mu.RUnlock()

	if inst.Mode == "finding-window" {
		reqBytes, reqCap, err := captureReader(req.Body, inst.WindowCfg.RingBodyBytes, reqCT)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		var bodyReader io.Reader
		if len(reqBytes) > 0 {
			bodyReader = bytes.NewReader(reqBytes)
		}
		outReq, err := http.NewRequestWithContext(req.Context(), method, target.String(), bodyReader)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		copyUpstreamHeaders(outReq.Header, req.Header)
		if len(reqBytes) > 0 {
			outReq.ContentLength = int64(len(reqBytes))
		}
		upRes, err := tr.RoundTrip(outReq)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer upRes.Body.Close()

		resHeadersMap := headersToMap(upRes.Header)
		resCT := store.ContentTypeBase(resHeadersMap)
		pathStr := target.RequestURI()
		if pathStr == "" {
			pathStr = "/"
		}
		writeMeta := store.TrafficWrite{
			TaskID:     inst.TaskID,
			IntentID:   intentID,
			WorkerID:   workerID,
			Method:     method,
			URL:        target.String(),
			Host:       target.Hostname(),
			Path:       pathStr,
			Status:     upRes.StatusCode,
			StartedAt:  started.UTC().Format("2006-01-02T15:04:05.000Z"),
			ReqHeaders: reqHeadersMap,
			ResHeaders: resHeadersMap,
		}
		same404, host404 := inst.ring.NoteNoise404(inst.TaskDir, writeMeta.Status, writeMeta.Method, writeMeta.Host, writeMeta.Path)
		skip := (inst.Retention.CompactStaticAssets && store.IsStaticAssetExchange(writeMeta)) ||
			store.IsNoiseExchange(writeMeta, same404, host404, inst.Retention)

		copyUpstreamHeaders(w.Header(), upRes.Header)
		w.Header().Del("Content-Length")
		w.WriteHeader(upRes.StatusCode)
		if skip {
			_, _ = io.Copy(w, upRes.Body)
			return
		}

		// Stream response bytes to client while capturing bounded head + true sha256/size
		h := sha256.New()
		var head bytes.Buffer
		var total int64
		buf := make([]byte, 32*1024)
		for {
			n, rerr := upRes.Body.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				_, _ = h.Write(chunk)
				total += int64(n)
				if head.Len() < inst.WindowCfg.RingBodyBytes {
					take := inst.WindowCfg.RingBodyBytes - head.Len()
					if take > n {
						take = n
					}
					_, _ = head.Write(chunk[:take])
				}
				_, _ = w.Write(chunk)
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				return
			}
		}
		resCap := &ring.CapturedBody{
			Head:        head.Bytes(),
			Size:        total,
			SHA256:      hex.EncodeToString(h.Sum(nil)),
			ContentType: resCT,
		}
		writeMeta.DurationMs = time.Since(started).Milliseconds()
		winIDs := inst.ring.MatchWindows(inst.TaskDir, intentID, target.Hostname(), time.Now().UnixMilli())
		if len(winIDs) > 0 {
			_, _ = inst.ring.PersistCaptured(inst.TaskDir, "", writeMeta, reqCap, resCap, winIDs, &inst.Retention)
			inst.ring.ConsumeWindows(inst.TaskDir, winIDs)
		} else {
			inst.ring.Push(inst.TaskDir, &ring.RingEntry{
				ID:      store.NewUUID(),
				AtMs:    started.UnixMilli(),
				Write:   writeMeta,
				ReqBody: reqCap,
				ResBody: resCap,
			}, inst.WindowCfg.RingMax)
		}
		return
	}

	// mode == "all": spool request and response to blobs + insert into index.sqlite BEFORE returning
	reqRef, reqPreview, reqBuf, err := inst.spoolRequest(req.Body, reqCT, reqHeadersMap)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	var bodyReader io.Reader
	if len(reqBuf) > 0 {
		bodyReader = bytes.NewReader(reqBuf)
	}
	outReq, err := http.NewRequestWithContext(req.Context(), method, target.String(), bodyReader)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copyUpstreamHeaders(outReq.Header, req.Header)
	if len(reqBuf) > 0 {
		outReq.ContentLength = int64(len(reqBuf))
	}
	upRes, err := tr.RoundTrip(outReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer upRes.Body.Close()

	resHeadersMap := headersToMap(upRes.Header)
	resCT := store.ContentTypeBase(resHeadersMap)
	copyUpstreamHeaders(w.Header(), upRes.Header)
	w.Header().Del("Content-Length")
	w.WriteHeader(upRes.StatusCode)

	resRef, resPreview, err := spoolStreamToFile(inst.TaskDir, upRes.Body, w, resCT, inst.Retention.MaxPreviewChars, resHeadersMap)
	if err != nil {
		return
	}

	pathStr := target.RequestURI()
	if pathStr == "" {
		pathStr = "/"
	}
	winIDs := inst.ring.MatchWindows(inst.TaskDir, intentID, target.Hostname(), time.Now().UnixMilli())
	if _, insErr := inst.store.InsertTraffic(inst.TaskDir, store.TrafficWrite{
		TaskID:     inst.TaskID,
		IntentID:   intentID,
		WorkerID:   workerID,
		Method:     method,
		URL:        target.String(),
		Host:       target.Hostname(),
		Path:       pathStr,
		Status:     upRes.StatusCode,
		DurationMs: time.Since(started).Milliseconds(),
		StartedAt:  started.UTC().Format("2006-01-02T15:04:05.000Z"),
		ReqHeaders: reqHeadersMap,
		ResHeaders: resHeadersMap,
		ReqBody:    reqRef,
		ResBody:    resRef,
		ReqPreview: reqPreview,
		ResPreview: resPreview,
		FindingIDs: winIDs,
	}, &inst.Retention); insErr != nil {
		fmt.Fprintf(os.Stderr, "gy-netd: insertTraffic error (%s): %v\n", inst.TaskDir, insErr)
	}
	if len(winIDs) > 0 {
		inst.ring.ConsumeWindows(inst.TaskDir, winIDs)
	}
}

func (inst *Instance) spoolRequest(body io.Reader, contentType string, headers map[string]any) (*store.TrafficBlobRef, string, []byte, error) {
	if body == nil {
		return nil, "", nil, nil
	}
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, "", nil, err
	}
	if len(raw) == 0 {
		return nil, "", nil, nil
	}
	ref, err := store.PutBlob(inst.TaskDir, raw, contentType)
	if err != nil {
		return nil, "", nil, err
	}
	prevCap := inst.Retention.MaxPreviewChars
	if prevCap > 8192 {
		prevCap = 8192
	}
	prev := ""
	if prevCap > 0 {
		sample := raw
		rawCap := prevCap
		if store.HasSupportedContentEncoding(headers) {
			rawCap = 64 * 1024
		}
		if len(sample) > rawCap {
			sample = sample[:rawCap]
		}
		prev = store.DecodeTrafficPreview(sample, headers, prevCap)
	}
	return ref, prev, raw, nil
}
