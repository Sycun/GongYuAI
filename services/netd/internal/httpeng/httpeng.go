package httpeng

import (
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
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/store"
)

const (
	DefaultMaxRedirects      = 5
	DefaultMaxResponseBytes  = 2 * 1024 * 1024
	DefaultTimeoutMs         = 30_000
	ResponseHeadBytes        = 16 * 1024
	DefaultBrowserUserAgent  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	noResponseText           = "HTTP/1.1 0\n\n"
	MaxBatchConcurrency      = 64
)

var (
	tokenRe          = regexp.MustCompile(`^[!#$%&'*+\-.^_` + "`" + `|~0-9A-Za-z]+$`)
	sensitiveHeaders = map[string]bool{
		"authorization":       true,
		"cookie":              true,
		"proxy-authorization": true,
	}
	redirectStatuses = map[int]bool{
		301: true, 302: true, 303: true, 307: true, 308: true,
	}
)

type ScopeRule struct {
	AllowHosts    []string `json:"allowHosts,omitempty"`
	DenyHosts     []string `json:"denyHosts,omitempty"`
	AllowAll      bool     `json:"allowAll,omitempty"`
}

type RequestInput struct {
	Method           string            `json:"method,omitempty"`
	URL              string            `json:"url"`
	Headers          map[string]string `json:"headers,omitempty"`
	Body             *string           `json:"body,omitempty"`
	Follow           *bool             `json:"follow,omitempty"`
	TimeoutMs        *int              `json:"timeoutMs,omitempty"`
	MaxRedirects     *int              `json:"maxRedirects,omitempty"`
	MaxResponseBytes *int              `json:"maxResponseBytes,omitempty"`
	UserAgent        string            `json:"userAgent,omitempty"`
	EvidenceDir        string            `json:"evidenceDir"`
	ProxyURL           string            `json:"proxyUrl,omitempty"`
	InsecureTLS        bool              `json:"insecureTls,omitempty"`
	Scope              *ScopeRule        `json:"scope,omitempty"`
	SkipRequestPersist bool              `json:"skipRequestPersist,omitempty"`
}

type HttpArtifact struct {
	ID              string   `json:"id"`
	Method          string   `json:"method"`
	URL             string   `json:"url"`
	Host            string   `json:"host"`
	Path            string   `json:"path"`
	Status          int      `json:"status"`
	RequestSHA256   string   `json:"requestSha256"`
	ResponseSHA256  string   `json:"responseSha256"`
	RequestPath     string   `json:"requestPath"`
	ResponsePath    string   `json:"responsePath"`
	RequestBytes    int      `json:"requestBytes"`
	ResponseBytes   int      `json:"responseBytes"`
	ResponseHead    string   `json:"responseHead"`
	Truncated       bool     `json:"truncated"`
	Redirects       []string `json:"redirects"`
	StartedAt       string   `json:"startedAt"`
	DurationMs      int64    `json:"durationMs"`
	Error           string   `json:"error,omitempty"`
	BlockedRedirect string   `json:"blockedRedirect,omitempty"`
}

type RequestResult struct {
	Artifact HttpArtifact      `json:"artifact"`
	Headers  map[string]string `json:"headers"`
	BodyHead string            `json:"bodyHead"`
}

type BatchInput struct {
	Concurrency int            `json:"concurrency,omitempty"`
	Items       []RequestInput `json:"items"`
}

type BatchItemResult struct {
	OK     bool           `json:"ok"`
	Result *RequestResult `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

type BatchResult struct {
	Results []BatchItemResult `json:"results"`
}

type Engine struct {
	mu         sync.Mutex
	transports map[string]*http.Transport
	dirs       sync.Map
}

func NewEngine() *Engine {
	return &Engine{
		transports: make(map[string]*http.Transport),
	}
}

func (e *Engine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, tr := range e.transports {
		tr.CloseIdleConnections()
	}
	e.transports = make(map[string]*http.Transport)
}

func (e *Engine) transportFor(proxyURL string, insecure bool) (*http.Transport, error) {
	key := fmt.Sprintf("%s|%v", proxyURL, insecure)
	e.mu.Lock()
	if tr, ok := e.transports[key]; ok {
		e.mu.Unlock()
		return tr, nil
	}
	e.mu.Unlock()

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
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: insecure,
		},
	}
	if strings.TrimSpace(proxyURL) != "" {
		u, err := url.Parse(strings.TrimSpace(proxyURL))
		if err != nil {
			return nil, err
		}
		tr.Proxy = http.ProxyURL(u)
	}
	e.mu.Lock()
	if existing, ok := e.transports[key]; ok {
		e.mu.Unlock()
		tr.CloseIdleConnections()
		return existing, nil
	}
	e.transports[key] = tr
	e.mu.Unlock()
	return tr, nil
}

func (e *Engine) ensureHttpDir(evidenceDir string) error {
	dir := filepath.Join(evidenceDir, "http")
	if _, ok := e.dirs.Load(dir); ok {
		if _, err := os.Stat(dir); err == nil {
			return nil
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	e.dirs.Store(dir, struct{}{})
	return nil
}

func (e *Engine) persistBlob(evidenceDir, kind, text string) (shaHex, relPath string, byteLen int, err error) {
	raw := []byte(text)
	sum := sha256.Sum256(raw)
	shaHex = hex.EncodeToString(sum[:])
	relPath = fmt.Sprintf("http/%s.%s.txt", shaHex, kind)
	if err = e.ensureHttpDir(evidenceDir); err != nil {
		return "", "", 0, err
	}
	absPath := filepath.Join(evidenceDir, relPath)
	if _, statErr := os.Stat(absPath); statErr != nil {
		f, openErr := os.OpenFile(absPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if openErr != nil {
			if !os.IsExist(openErr) {
				return "", "", 0, openErr
			}
		} else {
			_, werr := f.Write(raw)
			cerr := f.Close()
			if werr != nil {
				return "", "", 0, werr
			}
			if cerr != nil {
				return "", "", 0, cerr
			}
		}
	}
	return shaHex, relPath, len(raw), nil
}

func utf8SequenceStart(b []byte, endExclusive int) int {
	if endExclusive <= 0 {
		return 0
	}
	idx := endExclusive - 1
	for idx >= 0 && (b[idx]&0xc0) == 0x80 {
		idx--
	}
	if idx < 0 {
		return endExclusive
	}
	lead := b[idx]
	width := 1
	if (lead & 0xe0) == 0xc0 {
		width = 2
	} else if (lead & 0xf0) == 0xe0 {
		width = 3
	} else if (lead & 0xf8) == 0xf0 {
		width = 4
	}
	if endExclusive-idx < width {
		return idx
	}
	return endExclusive
}

func utf8Boundary(b []byte, cut int) int {
	if cut <= 0 {
		return 0
	}
	if cut >= len(b) {
		return len(b)
	}
	return utf8SequenceStart(b, cut)
}

func serializeRequest(method, rawURL string, headers map[string]string, body *string) string {
	var sb strings.Builder
	sb.WriteString(method)
	sb.WriteByte(' ')
	sb.WriteString(rawURL)
	keys := make([]string, 0, len(headers))
	for k := range headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		sb.WriteByte('\n')
		sb.WriteString(k)
		sb.WriteString(": ")
		sb.WriteString(headers[k])
	}
	sb.WriteString("\n\n")
	if body != nil {
		sb.WriteString(*body)
	}
	return sb.String()
}

type headerPair struct {
	name  string
	value string
}

func serializeResponse(status int, pairs []headerPair, body string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "HTTP/1.1 %d", status)
	for _, p := range pairs {
		sb.WriteByte('\n')
		sb.WriteString(p.name)
		sb.WriteString(": ")
		sb.WriteString(p.value)
	}
	sb.WriteString("\n\n")
	sb.WriteString(body)
	return sb.String()
}

func resolveDefaultUA(configured string) string {
	if s := strings.TrimSpace(configured); s != "" {
		return s
	}
	if s := strings.TrimSpace(os.Getenv("GY_HTTP_USER_AGENT")); s != "" {
		return s
	}
	return DefaultBrowserUserAgent
}

func hasHeader(headers map[string]string, name string) bool {
	for k := range headers {
		if strings.EqualFold(k, name) {
			return true
		}
	}
	return false
}

func stripSensitive(headers map[string]string) map[string]string {
	next := make(map[string]string, len(headers))
	for k, v := range headers {
		if sensitiveHeaders[strings.ToLower(k)] {
			continue
		}
		next[k] = v
	}
	return next
}

func rewriteForRedirect(status int, method string, body *string, headers map[string]string) (string, *string, map[string]string) {
	dropBody := ((status == 301 || status == 302) && method == "POST") ||
		(status == 303 && method != "GET" && method != "HEAD")
	if !dropBody {
		return method, body, headers
	}
	next := make(map[string]string, len(headers))
	for k, v := range headers {
		lk := strings.ToLower(k)
		if lk == "content-length" || lk == "content-type" {
			continue
		}
		next[k] = v
	}
	return "GET", nil, next
}

func matchHostPattern(host, pattern string) bool {
	h := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	p := strings.ToLower(strings.Trim(strings.TrimSpace(pattern), "[]"))
	if p == "" {
		return false
	}
	if p == "*" {
		return true
	}
	if strings.HasPrefix(p, "*.") {
		suf := p[1:]
		return strings.HasSuffix(h, suf) && len(h) > len(suf)
	}
	if _, cidr, err := net.ParseCIDR(p); err == nil {
		if ip := net.ParseIP(h); ip != nil {
			return cidr.Contains(ip)
		}
		return false
	}
	return h == p
}

func scopeAllows(scope *ScopeRule, host string) (bool, string) {
	if scope == nil {
		return true, ""
	}
	for _, deny := range scope.DenyHosts {
		if matchHostPattern(host, deny) {
			return false, "host in outOfScope"
		}
	}
	if scope.AllowAll || len(scope.AllowHosts) == 0 {
		return true, ""
	}
	for _, allow := range scope.AllowHosts {
		if matchHostPattern(host, allow) {
			return true, ""
		}
	}
	return false, "host not in scope"
}

func sameOrigin(a, b *url.URL) bool {
	portOf := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		if strings.EqualFold(u.Scheme, "https") {
			return "443"
		}
		return "80"
	}
	return strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(a.Hostname(), b.Hostname()) &&
		portOf(a) == portOf(b)
}

func readBoundedBody(r io.Reader, maxBytes int) ([]byte, bool, error) {
	if r == nil {
		return nil, false, nil
	}
	if maxBytes == 0 {
		var one [1]byte
		n, err := r.Read(one[:])
		if n > 0 {
			return []byte{}, true, nil
		}
		if err == io.EOF {
			return []byte{}, false, nil
		}
		return []byte{}, false, err
	}
	lr := io.LimitReader(r, int64(maxBytes)+1)
	data, err := io.ReadAll(lr)
	if err != nil {
		return nil, false, err
	}
	if len(data) > maxBytes {
		return data[:maxBytes], true, nil
	}
	return data, false, nil
}

func (e *Engine) Perform(ctx context.Context, input RequestInput) (*RequestResult, error) {
	startedAt := time.Now()
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		method = "GET"
	}
	if !tokenRe.MatchString(method) {
		return nil, fmt.Errorf("invalid HTTP method: %q", input.Method)
	}
	headers := make(map[string]string, len(input.Headers)+1)
	for k, v := range input.Headers {
		if !tokenRe.MatchString(k) {
			return nil, fmt.Errorf("invalid HTTP header name: %q", k)
		}
		if strings.ContainsAny(v, "\r\n\x00") {
			return nil, fmt.Errorf("invalid HTTP header value for %q: CR/LF/NUL not allowed", k)
		}
		headers[k] = v
	}
	if !hasHeader(headers, "user-agent") {
		ua := resolveDefaultUA(input.UserAgent)
		if strings.ContainsAny(ua, "\r\n\x00") {
			return nil, errors.New("invalid User-Agent")
		}
		headers["User-Agent"] = ua
	}

	initialURL, err := url.Parse(input.URL)
	if err != nil || initialURL.Scheme == "" || initialURL.Host == "" {
		return nil, fmt.Errorf("invalid URL: %s", input.URL)
	}
	initialURL.Fragment = ""
	if initialURL.Path == "" {
		initialURL.Path = "/"
	} else {
		trailingSlash := strings.HasSuffix(initialURL.Path, "/") && initialURL.Path != "/"
		cleaned := path.Clean(initialURL.Path)
		if !strings.HasPrefix(cleaned, "/") {
			cleaned = "/" + cleaned
		}
		if trailingSlash && !strings.HasSuffix(cleaned, "/") {
			cleaned += "/"
		}
		initialURL.Path = cleaned
	}
	normURL := initialURL.String()
	host := strings.ToLower(initialURL.Hostname())
	pathStr := initialURL.RequestURI()
	follow := true
	if input.Follow != nil {
		follow = *input.Follow
	}
	maxRedirects := DefaultMaxRedirects
	if input.MaxRedirects != nil && *input.MaxRedirects >= 0 {
		maxRedirects = *input.MaxRedirects
	}
	maxRespBytes := DefaultMaxResponseBytes
	if input.MaxResponseBytes != nil && *input.MaxResponseBytes >= 0 {
		maxRespBytes = *input.MaxResponseBytes
	}
	timeoutMs := DefaultTimeoutMs
	if input.TimeoutMs != nil && *input.TimeoutMs > 0 {
		timeoutMs = *input.TimeoutMs
	}

	var reqSHA, reqPath string
	var reqBytes int
	if !input.SkipRequestPersist {
		reqText := serializeRequest(method, normURL, headers, input.Body)
		reqSHA, reqPath, reqBytes, err = e.persistBlob(input.EvidenceDir, "req", reqText)
		if err != nil {
			return nil, err
		}
	}

	finish := func(status int, resText string, resHeaders map[string]string, bodyHead string, truncated bool, redirects []string, errMsg, blocked string) (*RequestResult, error) {
		resSHA, resPath, resBytes, perr := e.persistBlob(input.EvidenceDir, "res", resText)
		if perr != nil {
			return nil, perr
		}
		if redirects == nil {
			redirects = []string{}
		}
		if resHeaders == nil {
			resHeaders = map[string]string{}
		}
		return &RequestResult{
			Artifact: HttpArtifact{
				ID:              store.NewUUID(),
				Method:          method,
				URL:             normURL,
				Host:            host,
				Path:            pathStr,
				Status:          status,
				RequestSHA256:   reqSHA,
				ResponseSHA256:  resSHA,
				RequestPath:     reqPath,
				ResponsePath:    resPath,
				RequestBytes:    reqBytes,
				ResponseBytes:   resBytes,
				ResponseHead:    bodyHead,
				Truncated:       truncated,
				Redirects:       redirects,
				StartedAt:       startedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
				DurationMs:      time.Since(startedAt).Milliseconds(),
				Error:           errMsg,
				BlockedRedirect: blocked,
			},
			Headers:  resHeaders,
			BodyHead: bodyHead,
		}, nil
	}

	if ok, reason := scopeAllows(input.Scope, host); !ok {
		msg := fmt.Sprintf("blocked: host %s denied by authorizeHost", host)
		if reason != "" {
			msg += ": " + reason
		}
		return finish(0, noResponseText, nil, "", false, nil, msg, host)
	}

	tr, err := e.transportFor(input.ProxyURL, input.InsecureTLS)
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	curURL := initialURL
	curMethod := method
	curHeaders := headers
	curBody := input.Body
	redirects := []string{}

	for {
		var bodyReader io.Reader
		if curBody != nil {
			bodyReader = bytes.NewBufferString(*curBody)
		}
		httpReq, err := http.NewRequestWithContext(reqCtx, curMethod, curURL.String(), bodyReader)
		if err != nil {
			return finish(0, noResponseText, nil, "", false, redirects, "network error: "+err.Error(), "")
		}
		for k, v := range curHeaders {
			httpReq.Header.Set(k, v)
		}

		resp, err := client.Do(httpReq)
		if err != nil {
			errMsg := "network error: " + err.Error()
			if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
				errMsg = fmt.Sprintf("timeout after %dms", timeoutMs)
			}
			return finish(0, noResponseText, nil, "", false, redirects, errMsg, "")
		}
		bodyBuf, truncated, readErr := readBoundedBody(resp.Body, maxRespBytes)
		_ = resp.Body.Close()
		if readErr != nil {
			errMsg := "network error: " + readErr.Error()
			if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
				errMsg = fmt.Sprintf("timeout after %dms", timeoutMs)
			}
			return finish(0, noResponseText, nil, "", false, redirects, errMsg, "")
		}

		if truncated && len(bodyBuf) > 0 {
			bodyBuf = bodyBuf[:utf8SequenceStart(bodyBuf, len(bodyBuf))]
		}

		resHeaderKeys := make([]string, 0, len(resp.Header))
		for k := range resp.Header {
			resHeaderKeys = append(resHeaderKeys, k)
		}
		sort.Strings(resHeaderKeys)
		pairs := make([]headerPair, 0, len(resHeaderKeys))
		resHeaders := make(map[string]string, len(resHeaderKeys))
		for _, k := range resHeaderKeys {
			lk := strings.ToLower(k)
			vals := resp.Header[k]
			for _, v := range vals {
				pairs = append(pairs, headerPair{name: lk, value: v})
			}
			resHeaders[lk] = strings.Join(vals, ", ")
		}
		headCut := len(bodyBuf)
		if headCut > ResponseHeadBytes {
			headCut = ResponseHeadBytes
		}
		headEnd := utf8Boundary(bodyBuf, headCut)
		bodyHead := string(bodyBuf[:headEnd])
		resText := serializeResponse(resp.StatusCode, pairs, string(bodyBuf))

		loc := resp.Header.Get("Location")
		if follow && redirectStatuses[resp.StatusCode] && len(redirects) < maxRedirects && loc != "" {
			if rel, perr := url.Parse(loc); perr == nil {
				target := curURL.ResolveReference(rel)
				target.Fragment = ""
				if target.Scheme == "http" || target.Scheme == "https" {
					targetHost := strings.ToLower(target.Hostname())
					if ok, _ := scopeAllows(input.Scope, targetHost); !ok {
						return finish(resp.StatusCode, resText, resHeaders, bodyHead, truncated, redirects, "", targetHost)
					}
					redirects = append(redirects, target.String())
					nm, nb, nh := rewriteForRedirect(resp.StatusCode, curMethod, curBody, curHeaders)
					if !sameOrigin(curURL, target) {
						nh = stripSensitive(nh)
					}
					curMethod, curBody, curHeaders = nm, nb, nh
					curURL = target
					continue
				}
			}
		}

		return finish(resp.StatusCode, resText, resHeaders, bodyHead, truncated, redirects, "", "")
	}
}

func (e *Engine) PerformBatch(ctx context.Context, batch BatchInput) *BatchResult {
	n := len(batch.Items)
	results := make([]BatchItemResult, n)
	if n == 0 {
		return &BatchResult{Results: results}
	}
	conc := batch.Concurrency
	if conc <= 0 {
		conc = 16
	}
	if conc > MaxBatchConcurrency {
		conc = MaxBatchConcurrency
	}
	if conc > n {
		conc = n
	}

	jobs := make(chan int, n)
	for i := 0; i < n; i++ {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	for w := 0; w < conc; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				res, err := e.Perform(ctx, batch.Items[idx])
				if err != nil {
					results[idx] = BatchItemResult{OK: false, Error: err.Error()}
				} else {
					results[idx] = BatchItemResult{OK: true, Result: res}
				}
			}
		}()
	}
	wg.Wait()
	return &BatchResult{Results: results}
}
