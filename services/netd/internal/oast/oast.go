package oast

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/store"
)

const (
	DefaultMaxBodyBytes   = 64 * 1024
	CloseGraceDuration    = 1000 * time.Millisecond
	minTokenLabelLen      = 8
	maxTokenLabelLen      = 64
	maxRetainedHits       = 1000
	dnsTypeA              = 1
	dnsClassIN            = 1
	dnsRcodeNXDomain      = 3
)

type Hit struct {
	Token     string `json:"token"`
	At        string `json:"at"`
	SourceIP  string `json:"sourceIp"`
	Method    string `json:"method,omitempty"`
	Path      string `json:"path,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
	Protocol  string `json:"protocol"`
}

type HTTPOptions struct {
	ListenHost    string `json:"listenHost,omitempty"`
	ListenPort    int    `json:"listenPort,omitempty"`
	PublicBaseURL string `json:"publicBaseUrl"`
	MaxBodyBytes  *int   `json:"maxBodyBytes,omitempty"`
}

type DNSOptions struct {
	ListenHost string `json:"listenHost,omitempty"`
	ListenPort int    `json:"listenPort,omitempty"`
	Domain     string `json:"domain"`
	AnswerIP   string `json:"answerIp,omitempty"`
	TTLSec     *int   `json:"ttlSec,omitempty"`
}

type ListenError struct {
	Code string
	Msg  string
}

func (e *ListenError) Error() string { return e.Msg }

func errnoCode(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case syscall.EADDRINUSE:
			return "EADDRINUSE"
		case syscall.EACCES:
			return "EACCES"
		case syscall.EADDRNOTAVAIL:
			return "EADDRNOTAVAIL"
		}
	}
	if strings.Contains(strings.ToLower(err.Error()), "address already in use") {
		return "EADDRINUSE"
	}
	return "UNKNOWN"
}

type hitBroker struct {
	mu     sync.Mutex
	hits   []Hit
	subs   map[chan Hit]struct{}
	closed bool
}

func newHitBroker() *hitBroker {
	return &hitBroker{subs: make(map[chan Hit]struct{})}
}

func (b *hitBroker) publish(h Hit) {
	b.mu.Lock()
	b.hits = append(b.hits, h)
	if len(b.hits) > maxRetainedHits {
		b.hits = b.hits[len(b.hits)-maxRetainedHits:]
	}
	for ch := range b.subs {
		select {
		case ch <- h:
		default:
		}
	}
	b.mu.Unlock()
}

func (b *hitBroker) subscribe() (chan Hit, []Hit, func()) {
	ch := make(chan Hit, 128)
	b.mu.Lock()
	if b.closed {
		close(ch)
		b.mu.Unlock()
		return ch, nil, func() {}
	}
	b.subs[ch] = struct{}{}
	existing := append([]Hit(nil), b.hits...)
	b.mu.Unlock()
	unsub := func() {
		b.mu.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
	return ch, existing, unsub
}

func (b *hitBroker) snapshot() []Hit {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.hits == nil {
		return []Hit{}
	}
	return append([]Hit(nil), b.hits...)
}

func (b *hitBroker) closeAll() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	for ch := range b.subs {
		close(ch)
	}
	b.subs = make(map[chan Hit]struct{})
	b.mu.Unlock()
}

type HTTPInstance struct {
	ID            string
	Port          int
	BoundURL      string
	PublicBaseURL string
	maxBodyBytes  int
	ln            net.Listener
	srv           *http.Server
	broker        *hitBroker
	mu            sync.Mutex
	conns         map[net.Conn]struct{}
	closed        bool
}

type DNSInstance struct {
	ID       string
	Port     int
	Domain   string
	answerIP [4]byte
	ttlSec   uint32
	conn     *net.UDPConn
	broker   *hitBroker
	mu       sync.Mutex
	closed   bool
}

type Manager struct {
	mu   sync.Mutex
	http map[string]*HTTPInstance
	dns  map[string]*DNSInstance
}

func NewManager() *Manager {
	return &Manager{
		http: make(map[string]*HTTPInstance),
		dns:  make(map[string]*DNSInstance),
	}
}

func (m *Manager) Counts() (int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.http), len(m.dns)
}

func formatURLHost(host string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

func cleanToken(s string) string {
	return strings.TrimSpace(s)
}

func tokenFromHost(hostHeader string) string {
	h := strings.TrimSpace(hostHeader)
	if h == "" || strings.HasPrefix(h, "[") {
		return ""
	}
	if idx := strings.IndexByte(h, ':'); idx >= 0 {
		h = h[:idx]
	}
	h = strings.TrimSuffix(h, ".")
	parts := strings.Split(h, ".")
	labels := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			labels = append(labels, p)
		}
	}
	if len(labels) < 3 || len(labels[0]) < minTokenLabelLen {
		return ""
	}
	return cleanToken(labels[0])
}

func extractHTTPToken(req *http.Request) string {
	raw := req.RequestURI
	if raw == "" && req.URL != nil {
		raw = req.URL.RequestURI()
	}
	var pathname string
	var query url.Values
	if u, err := url.Parse(raw); err == nil {
		pathname = u.Path
		query = u.Query()
	} else {
		if idx := strings.IndexByte(raw, '?'); idx >= 0 {
			pathname = raw[:idx]
			query, _ = url.ParseQuery(raw[idx+1:])
		} else {
			pathname = raw
		}
	}
	segs := []string{}
	for _, seg := range strings.Split(pathname, "/") {
		if seg != "" {
			segs = append(segs, seg)
		}
	}
	if len(segs) >= 2 && segs[0] == "t" {
		dec := segs[1]
		if unesc, err := url.PathUnescape(segs[1]); err == nil {
			dec = unesc
		}
		if tok := cleanToken(dec); tok != "" {
			return tok
		}
	}
	if query != nil {
		if tok := cleanToken(query.Get("t")); tok != "" {
			return tok
		}
	}
	return tokenFromHost(req.Host)
}

func sourceIPOf(req *http.Request) string {
	if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	return strings.TrimPrefix(strings.TrimPrefix(host, "::ffff:"), "::FFFF:")
}

func (m *Manager) StartHTTP(opts HTTPOptions) (*HTTPInstance, error) {
	pub := strings.TrimRight(strings.TrimSpace(opts.PublicBaseURL), "/")
	if pub == "" {
		return nil, errors.New("OAST 监听需要 publicBaseUrl")
	}
	host := strings.TrimSpace(opts.ListenHost)
	if host == "" {
		host = "127.0.0.1"
	}
	maxBody := DefaultMaxBodyBytes
	if opts.MaxBodyBytes != nil && *opts.MaxBodyBytes >= 0 {
		maxBody = *opts.MaxBodyBytes
	}

	addr := net.JoinHostPort(host, fmt.Sprintf("%d", opts.ListenPort))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		code := errnoCode(err)
		return nil, &ListenError{
			Code: code,
			Msg:  fmt.Sprintf("OAST 监听无法绑定 %s:%d（%s）：%v", host, opts.ListenPort, code, err),
		}
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return nil, errors.New("OAST 监听启动后没有可用的 TCP 地址")
	}

	inst := &HTTPInstance{
		ID:            store.NewUUID(),
		Port:          tcpAddr.Port,
		BoundURL:      fmt.Sprintf("http://%s:%d", formatURLHost(tcpAddr.IP.String()), tcpAddr.Port),
		PublicBaseURL: pub,
		maxBodyBytes:  maxBody,
		ln:            ln,
		broker:        newHitBroker(),
		conns:         make(map[net.Conn]struct{}),
	}
	inst.srv = &http.Server{
		Handler: http.HandlerFunc(inst.handleHTTP),
		ConnState: func(c net.Conn, st http.ConnState) {
			inst.mu.Lock()
			if st == http.StateNew {
				inst.conns[c] = struct{}{}
			} else if st == http.StateClosed || st == http.StateHijacked {
				delete(inst.conns, c)
			}
			inst.mu.Unlock()
		},
	}

	m.mu.Lock()
	m.http[inst.ID] = inst
	m.mu.Unlock()

	go func() {
		_ = inst.srv.Serve(ln)
	}()
	return inst, nil
}

func (inst *HTTPInstance) handleHTTP(w http.ResponseWriter, req *http.Request) {
	token := extractHTTPToken(req)
	if token == "" {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "missing oast token\n")
		return
	}

	if req.Body != nil {
		lr := io.LimitReader(req.Body, int64(inst.maxBodyBytes)+1)
		n, err := io.Copy(io.Discard, lr)
		if err != nil || n > int64(inst.maxBodyBytes) {
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, herr := hj.Hijack(); herr == nil {
					_ = conn.Close()
					return
				}
			}
			return
		}
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusOK)
	if fl, ok := w.(http.Flusher); ok {
		fl.Flush()
	}

	rawPath := req.RequestURI
	if rawPath == "" && req.URL != nil {
		rawPath = req.URL.RequestURI()
	}
	inst.broker.publish(Hit{
		Token:     token,
		At:        time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		SourceIP:  sourceIPOf(req),
		Method:    req.Method,
		Path:      rawPath,
		UserAgent: req.Header.Get("User-Agent"),
		Protocol:  "http",
	})
}

func (inst *HTTPInstance) Close() {
	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return
	}
	inst.closed = true
	inst.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), CloseGraceDuration)
	defer cancel()
	_ = inst.srv.Shutdown(ctx)
	_ = inst.srv.Close()
	_ = inst.ln.Close()

	inst.mu.Lock()
	for c := range inst.conns {
		_ = c.Close()
	}
	inst.conns = make(map[net.Conn]struct{})
	inst.mu.Unlock()
	inst.broker.closeAll()
}

func (inst *HTTPInstance) Subscribe() (chan Hit, []Hit, func()) { return inst.broker.subscribe() }
func (inst *HTTPInstance) Hits() []Hit                           { return inst.broker.snapshot() }

func (m *Manager) GetHTTP(id string) *HTTPInstance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.http[id]
}

func (m *Manager) StopHTTP(id string) {
	m.mu.Lock()
	inst := m.http[id]
	delete(m.http, id)
	m.mu.Unlock()
	if inst != nil {
		inst.Close()
	}
}

func DNSTokenFor(name, domain string) string {
	norm := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
	suffix := strings.Trim(strings.ToLower(strings.TrimSpace(domain)), ".")
	if suffix == "" || !strings.HasSuffix(norm, "."+suffix) {
		return ""
	}
	label := norm[:len(norm)-len(suffix)-1]
	if strings.Contains(label, ".") || len(label) < minTokenLabelLen || len(label) > maxTokenLabelLen {
		return ""
	}
	for i := 0; i < len(label); i++ {
		c := label[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			return ""
		}
	}
	return label
}

func decodeQName(buf []byte, offset int) (string, int, bool) {
	labels := []string{}
	cursor := offset
	for guard := 0; guard < 64; guard++ {
		if cursor >= len(buf) {
			return "", 0, false
		}
		l := int(buf[cursor])
		cursor++
		if l == 0 {
			return strings.Join(labels, "."), cursor, true
		}
		if (l & 0xc0) != 0 {
			return "", 0, false
		}
		if cursor+l > len(buf) {
			return "", 0, false
		}
		labels = append(labels, string(buf[cursor:cursor+l]))
		cursor += l
	}
	return "", 0, false
}

func buildDNSResponse(query []byte, questionEnd int, answerIP *[4]byte, ttlSec uint32) []byte {
	header := make([]byte, 12)
	copy(header[0:2], query[0:2])
	rcode := uint16(dnsRcodeNXDomain)
	ancount := uint16(0)
	if answerIP != nil {
		rcode = 0
		ancount = 1
	}
	binary.BigEndian.PutUint16(header[2:4], 0x8580|rcode)
	binary.BigEndian.PutUint16(header[4:6], 1)
	binary.BigEndian.PutUint16(header[6:8], ancount)
	question := query[12:questionEnd]
	if answerIP == nil {
		out := make([]byte, 0, len(header)+len(question))
		out = append(out, header...)
		out = append(out, question...)
		return out
	}
	ans := make([]byte, 16)
	binary.BigEndian.PutUint16(ans[0:2], 0xc00c)
	binary.BigEndian.PutUint16(ans[2:4], dnsTypeA)
	binary.BigEndian.PutUint16(ans[4:6], dnsClassIN)
	binary.BigEndian.PutUint32(ans[6:10], ttlSec)
	binary.BigEndian.PutUint16(ans[10:12], 4)
	copy(ans[12:16], answerIP[:])

	out := make([]byte, 0, len(header)+len(question)+len(ans))
	out = append(out, header...)
	out = append(out, question...)
	out = append(out, ans...)
	return out
}

func (m *Manager) StartDNS(opts DNSOptions) (*DNSInstance, error) {
	domain := strings.Trim(strings.ToLower(strings.TrimSpace(opts.Domain)), ".")
	if domain == "" {
		return nil, errors.New("oast dns domain required")
	}
	host := strings.TrimSpace(opts.ListenHost)
	if host == "" {
		host = "127.0.0.1"
	}
	ip4 := [4]byte{127, 0, 0, 1}
	if parsed := net.ParseIP(strings.TrimSpace(opts.AnswerIP)).To4(); parsed != nil {
		copy(ip4[:], parsed)
	}
	ttl := 60
	if opts.TTLSec != nil {
		ttl = *opts.TTLSec
		if ttl < 0 {
			ttl = 0
		}
		if ttl > 86400 {
			ttl = 86400
		}
	}

	udpAddr, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, fmt.Sprintf("%d", opts.ListenPort)))
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp4", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("oast dns listen %s:%d failed: %w", host, opts.ListenPort, err)
	}
	local := conn.LocalAddr().(*net.UDPAddr)

	inst := &DNSInstance{
		ID:       store.NewUUID(),
		Port:     local.Port,
		Domain:   domain,
		answerIP: ip4,
		ttlSec:   uint32(ttl),
		conn:     conn,
		broker:   newHitBroker(),
	}

	m.mu.Lock()
	m.dns[inst.ID] = inst
	m.mu.Unlock()

	go inst.serveLoop()
	return inst, nil
}

func (inst *DNSInstance) serveLoop() {
	buf := make([]byte, 2048)
	for {
		n, raddr, err := inst.conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		msg := buf[:n]
		if len(msg) < 12 {
			continue
		}
		qdcount := binary.BigEndian.Uint16(msg[4:6])
		if qdcount < 1 {
			_, _ = inst.conn.WriteToUDP(buildDNSResponse(msg, 12, nil, inst.ttlSec), raddr)
			continue
		}
		qname, next, ok := decodeQName(msg, 12)
		if !ok || next+4 > len(msg) {
			_, _ = inst.conn.WriteToUDP(buildDNSResponse(msg, 12, nil, inst.ttlSec), raddr)
			continue
		}
		qtype := binary.BigEndian.Uint16(msg[next : next+2])
		qEnd := next + 4
		token := DNSTokenFor(qname, inst.Domain)
		valid := token != "" && qtype == dnsTypeA
		var ansPtr *[4]byte
		if valid {
			ipCopy := inst.answerIP
			ansPtr = &ipCopy
		}
		_, _ = inst.conn.WriteToUDP(buildDNSResponse(msg, qEnd, ansPtr, inst.ttlSec), raddr)
		if !valid {
			continue
		}
		inst.broker.publish(Hit{
			Token:    token,
			At:       time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			SourceIP: raddr.IP.String(),
			Protocol: "dns",
		})
	}
}

func (inst *DNSInstance) Close() {
	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return
	}
	inst.closed = true
	inst.mu.Unlock()
	_ = inst.conn.Close()
	inst.broker.closeAll()
}

func (inst *DNSInstance) Subscribe() (chan Hit, []Hit, func()) { return inst.broker.subscribe() }
func (inst *DNSInstance) Hits() []Hit                           { return inst.broker.snapshot() }

func (m *Manager) GetDNS(id string) *DNSInstance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.dns[id]
}

func (m *Manager) StopDNS(id string) {
	m.mu.Lock()
	inst := m.dns[id]
	delete(m.dns, id)
	m.mu.Unlock()
	if inst != nil {
		inst.Close()
	}
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	hs := make([]*HTTPInstance, 0, len(m.http))
	for _, h := range m.http {
		hs = append(hs, h)
	}
	ds := make([]*DNSInstance, 0, len(m.dns))
	for _, d := range m.dns {
		ds = append(ds, d)
	}
	m.http = make(map[string]*HTTPInstance)
	m.dns = make(map[string]*DNSInstance)
	m.mu.Unlock()
	for _, h := range hs {
		h.Close()
	}
	for _, d := range ds {
		d.Close()
	}
}
