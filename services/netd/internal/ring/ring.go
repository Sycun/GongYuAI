package ring

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/store"
)

const (
	DefaultRingMax       = 300
	DefaultRingBodyBytes = 64 * 1024
	DefaultPreWindowMs   = 5 * 60_000
	DefaultPreMaxItems   = 25
	DefaultPostWindowMs  = 5 * 60_000
	DefaultPostMaxItems  = 30
	DefaultConfirmItems  = 5
	ringHeadersChars     = 8192
	noiseKeysMax         = 10_000
	TruncatedHeader      = "x-gy-body-truncated"
)

type WindowConfig struct {
	RingMax       int `json:"ringMax"`
	RingBodyBytes int `json:"ringBodyBytes"`
	PreWindowMs   int `json:"preWindowMs"`
	PreMaxItems   int `json:"preMaxItems"`
	PostWindowMs  int `json:"postWindowMs"`
	PostMaxItems  int `json:"postMaxItems"`
}

func envIntMin(name string, fallback, minVal int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if n < minVal {
		return minVal
	}
	return n
}

func DefaultWindowConfig() WindowConfig {
	return WindowConfig{
		RingMax:       envIntMin("GY_TRAFFIC_RING_MAX", DefaultRingMax, 1),
		RingBodyBytes: envIntMin("GY_TRAFFIC_RING_BODY_BYTES", DefaultRingBodyBytes, 0),
		PreWindowMs:   envIntMin("GY_TRAFFIC_PRE_WINDOW_MS", DefaultPreWindowMs, 0),
		PreMaxItems:   envIntMin("GY_TRAFFIC_PRE_MAX_ITEMS", DefaultPreMaxItems, 0),
		PostWindowMs:  envIntMin("GY_TRAFFIC_POST_WINDOW_MS", DefaultPostWindowMs, 0),
		PostMaxItems:  envIntMin("GY_TRAFFIC_POST_MAX_ITEMS", DefaultPostMaxItems, 0),
	}
}

type CapturedBody struct {
	Head        []byte `json:"-"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType,omitempty"`
}

type RingEntry struct {
	ID        string
	AtMs      int64
	Write     store.TrafficWrite
	ReqBody   *CapturedBody
	ResBody   *CapturedBody
	Persisted bool
}

type PostWindow struct {
	FindingID string `json:"findingId"`
	IntentID  string `json:"intentId,omitempty"`
	Host      string `json:"host,omitempty"`
	ExpiresAt int64  `json:"expiresAt"`
	Remaining int    `json:"remaining"`
}

type taskRing struct {
	entries []*RingEntry
	byID    map[string]*RingEntry
}

type noiseState struct {
	samePath map[string]int
	host     map[string]int
}

type Manager struct {
	mu      sync.Mutex
	store   *store.StoreManager
	rings   map[string]*taskRing
	windows map[string]map[string]*PostWindow
	noise   map[string]*noiseState
}

func NewManager(sm *store.StoreManager) *Manager {
	return &Manager{
		store:   sm,
		rings:   make(map[string]*taskRing),
		windows: make(map[string]map[string]*PostWindow),
		noise:   make(map[string]*noiseState),
	}
}

func keyOf(taskDir string) string {
	return filepath.Clean(taskDir)
}

func (m *Manager) ringOfLocked(k string) *taskRing {
	r, ok := m.rings[k]
	if !ok {
		r = &taskRing{byID: make(map[string]*RingEntry)}
		m.rings[k] = r
	}
	return r
}

func (m *Manager) Push(taskDir string, entry *RingEntry, maxOverride int) *RingEntry {
	max := DefaultWindowConfig().RingMax
	if maxOverride > 0 {
		max = maxOverride
	}
	if entry.ID == "" {
		entry.ID = store.NewUUID()
	}
	if entry.AtMs == 0 {
		entry.AtMs = time.Now().UnixMilli()
	}
	entry.Write.ReqHeaders = store.CapHeaders(entry.Write.ReqHeaders, ringHeadersChars)
	entry.Write.ResHeaders = store.CapHeaders(entry.Write.ResHeaders, ringHeadersChars)
	entry.Persisted = false

	k := keyOf(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.ringOfLocked(k)
	r.entries = append(r.entries, entry)
	r.byID[entry.ID] = entry
	for len(r.entries) > max {
		dropped := r.entries[0]
		r.entries = r.entries[1:]
		delete(r.byID, dropped.ID)
	}
	return entry
}

func (m *Manager) Size(taskDir string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rings[keyOf(taskDir)]
	if r == nil {
		return 0
	}
	return len(r.entries)
}

func (m *Manager) Clear(taskDir string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if strings.TrimSpace(taskDir) == "" {
		m.rings = make(map[string]*taskRing)
		m.windows = make(map[string]map[string]*PostWindow)
		m.noise = make(map[string]*noiseState)
		return
	}
	k := keyOf(taskDir)
	delete(m.rings, k)
	delete(m.windows, k)
	delete(m.noise, k)
}

func (m *Manager) NoteNoise404(taskDir string, status int, method, host, path string) (int, int) {
	if status != 404 {
		return 0, 0
	}
	k := keyOf(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	ns, ok := m.noise[k]
	if !ok {
		ns = &noiseState{samePath: make(map[string]int), host: make(map[string]int)}
		m.noise[k] = ns
	}
	if len(ns.samePath) > noiseKeysMax {
		ns.samePath = make(map[string]int)
	}
	if len(ns.host) > noiseKeysMax {
		ns.host = make(map[string]int)
	}
	hk := strings.ToLower(host)
	pk := strings.ToUpper(method) + " " + hk + " " + path
	same := ns.samePath[pk]
	hc := ns.host[hk]
	ns.samePath[pk] = same + 1
	ns.host[hk] = hc + 1
	return same, hc
}

func blobRefOf(body *CapturedBody) *store.TrafficBlobRef {
	if body == nil || body.Size <= 0 {
		return nil
	}
	return &store.TrafficBlobRef{
		SHA256:      body.SHA256,
		Size:        body.Size,
		ContentType: body.ContentType,
	}
}

func ringRecord(e *RingEntry) store.TrafficRecord {
	return store.TrafficRecord{
		ID:          e.ID,
		TaskID:      e.Write.TaskID,
		IntentID:    e.Write.IntentID,
		WorkerID:    e.Write.WorkerID,
		Method:      e.Write.Method,
		URL:         e.Write.URL,
		Host:        e.Write.Host,
		Path:        e.Write.Path,
		Status:      e.Write.Status,
		DurationMs:  e.Write.DurationMs,
		StartedAt:   e.Write.StartedAt,
		ReqHeaders:  e.Write.ReqHeaders,
		ResHeaders:  e.Write.ResHeaders,
		ReqBodyBlob: blobRefOf(e.ReqBody),
		ResBodyBlob: blobRefOf(e.ResBody),
	}
}

func previewOf(body *CapturedBody, headers map[string]any, max int) string {
	if body == nil || max <= 0 {
		return ""
	}
	if max > 8192 {
		max = 8192
	}
	return store.DecodeTrafficPreview(body.Head, headers, max)
}

func ringMatches(e *RingEntry, q store.TrafficQuery) bool {
	w := e.Write
	if w.TaskID != q.TaskID {
		return false
	}
	if v := strings.TrimSpace(q.IntentID); v != "" && w.IntentID != v {
		return false
	}
	if v := strings.TrimSpace(q.WorkerID); v != "" && w.WorkerID != v {
		return false
	}
	if v := strings.TrimSpace(q.Method); v != "" && !strings.EqualFold(w.Method, v) {
		return false
	}
	if v := strings.TrimSpace(q.Host); v != "" && !strings.EqualFold(w.Host, v) {
		return false
	}
	if v := strings.TrimSpace(q.Path); v != "" && w.Path != v {
		return false
	}
	if q.Status != nil && w.Status != *q.Status {
		return false
	}
	if strings.TrimSpace(q.FindingID) != "" {
		return false
	}
	if q.StartedAfter != "" && w.StartedAt < q.StartedAfter {
		return false
	}
	if q.StartedBefore != "" && w.StartedAt > q.StartedBefore {
		return false
	}
	if kw := strings.ToLower(strings.TrimSpace(q.Keyword)); kw != "" {
		reqH, _ := json.Marshal(w.ReqHeaders)
		resH, _ := json.Marshal(w.ResHeaders)
		hay := strings.ToLower(strings.Join([]string{
			w.URL, w.Host, w.Path,
			previewOf(e.ReqBody, w.ReqHeaders, 8192),
			previewOf(e.ResBody, w.ResHeaders, 8192),
			string(reqH), string(resH),
		}, "\n"))
		if !strings.Contains(hay, kw) {
			return false
		}
	}
	return true
}

func (m *Manager) QueryRing(taskDir string, q store.TrafficQuery) []store.TrafficRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rings[keyOf(taskDir)]
	if r == nil {
		return []store.TrafficRecord{}
	}
	out := []store.TrafficRecord{}
	for _, e := range r.entries {
		if !e.Persisted && ringMatches(e, q) {
			out = append(out, ringRecord(e))
		}
	}
	return out
}

type LiveTrafficPage struct {
	Traffic    []store.TrafficRecord `json:"traffic"`
	Total      int                   `json:"total"`
	NextOffset *int                  `json:"nextOffset"`
	HotIDs     []string              `json:"hotIds"`
}

func (m *Manager) QueryLive(taskDir string, q store.TrafficQuery) (*LiveTrafficPage, error) {
	offset := q.Offset
	if offset < 0 {
		offset = 0
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	hot := m.QueryRing(taskDir, q)
	hotStart := offset
	if hotStart > len(hot) {
		hotStart = len(hot)
	}
	hotEnd := offset + limit
	if hotEnd > len(hot) {
		hotEnd = len(hot)
	}
	hotPage := hot[hotStart:hotEnd]

	dbOffset := offset - len(hot)
	if dbOffset < 0 {
		dbOffset = 0
	}
	dbLimit := limit - len(hotPage)
	dbQ := q
	dbQ.Offset = dbOffset
	if dbLimit > 0 {
		dbQ.Limit = dbLimit
	} else {
		dbQ.Limit = 1
	}
	dbPage, err := m.store.QueryTraffic(taskDir, dbQ)
	if err != nil {
		return nil, err
	}

	hotIDSet := make(map[string]bool, len(hotPage))
	hotIDs := make([]string, 0, len(hotPage))
	for _, row := range hotPage {
		hotIDSet[row.ID] = true
		hotIDs = append(hotIDs, row.ID)
	}
	traffic := append([]store.TrafficRecord{}, hotPage...)
	if dbLimit > 0 {
		for _, row := range dbPage.Traffic {
			if !hotIDSet[row.ID] {
				traffic = append(traffic, row)
			}
		}
	}
	total := len(hot) + dbPage.Total
	next := offset + len(traffic)
	var nextPtr *int
	if next < total {
		nextPtr = &next
	}
	return &LiveTrafficPage{
		Traffic:    traffic,
		Total:      total,
		NextOffset: nextPtr,
		HotIDs:     hotIDs,
	}, nil
}

func (m *Manager) GetLive(taskDir, id string) (*store.TrafficRecord, bool, error) {
	rec, err := m.store.GetTraffic(taskDir, id)
	if err != nil {
		return nil, false, err
	}
	if rec != nil {
		return rec, false, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rings[keyOf(taskDir)]
	if r == nil {
		return nil, false, nil
	}
	e := r.byID[id]
	if e == nil {
		return nil, false, nil
	}
	rr := ringRecord(e)
	return &rr, true, nil
}

type LiveBodySlice struct {
	SHA256          string `json:"sha256"`
	Offset          int    `json:"offset"`
	MaxBytes        int    `json:"maxBytes"`
	Size            int64  `json:"size"`
	RawSize         *int64 `json:"rawSize,omitempty"`
	DecodedEncoding string `json:"decodedEncoding,omitempty"`
	BytesBase64     string `json:"bytesBase64"`
	NextOffset      *int   `json:"nextOffset"`
	Side            string `json:"side"`
	ContentType     string `json:"contentType,omitempty"`
	Body            string `json:"body"`
	EvidenceRef     string `json:"evidenceRef"`
	Truncated       *bool  `json:"truncated,omitempty"`
	BufferedBytes   *int   `json:"bufferedBytes,omitempty"`
	Source          string `json:"source"`
}

func (m *Manager) ReadBodyLive(taskDir, trafficID, side string, offset, maxBytes int) (*LiveBodySlice, int, error) {
	if offset < 0 {
		return nil, 400, errors.New("invalid offset")
	}
	if maxBytes == 0 {
		maxBytes = store.DefaultBlobRead
	}
	if maxBytes < 1 {
		return nil, 400, errors.New("invalid maxBytes")
	}
	if maxBytes > store.MaxBlobRead {
		return nil, 400, fmt.Errorf("maxBytes exceeds %d", store.MaxBlobRead)
	}

	if rec, err := m.store.GetTraffic(taskDir, trafficID); err == nil && rec != nil {
		blob := rec.ResBodyBlob
		headers := rec.ResHeaders
		if side == "req" {
			blob = rec.ReqBodyBlob
			headers = rec.ReqHeaders
		}
		if blob == nil {
			return nil, 404, fmt.Errorf("no %s body", side)
		}
		if store.HasSupportedContentEncoding(headers) {
			if raw, err := store.ReadBlobBytes(taskDir, blob.SHA256, store.MaxCompressedBlobBytes); err == nil && raw != nil {
				if dec := store.DecodeTrafficBody(raw, headers, store.MaxDecompressedBlobBytes); dec != nil {
					end := offset + maxBytes
					if end > len(dec.Bytes) {
						end = len(dec.Bytes)
					}
					var chunk []byte
					if offset < len(dec.Bytes) {
						chunk = dec.Bytes[offset:end]
					}
					next := offset + len(chunk)
					var nextPtr *int
					if next < len(dec.Bytes) {
						nextPtr = &next
					}
					rawSz := blob.Size
					return &LiveBodySlice{
						SHA256:          strings.ToLower(strings.TrimSpace(blob.SHA256)),
						Offset:          offset,
						MaxBytes:        maxBytes,
						Size:            int64(len(dec.Bytes)),
						RawSize:         &rawSz,
						DecodedEncoding: dec.Encoding,
						BytesBase64:     base64.StdEncoding.EncodeToString(chunk),
						NextOffset:      nextPtr,
						Side:            side,
						ContentType:     blob.ContentType,
						Body:            string(chunk),
						EvidenceRef:     "http:" + rec.ID,
						Source:          "store",
					}, 200, nil
				}
			}
		}
		chunk, size, nextPtr, err := store.ReadBlobSlice(taskDir, blob.SHA256, offset, maxBytes)
		if err != nil {
			return nil, 500, err
		}
		return &LiveBodySlice{
			SHA256:      strings.ToLower(strings.TrimSpace(blob.SHA256)),
			Offset:      offset,
			MaxBytes:    maxBytes,
			Size:        size,
			BytesBase64: base64.StdEncoding.EncodeToString(chunk),
			NextOffset:  nextPtr,
			Side:        side,
			ContentType: blob.ContentType,
			Body:        string(chunk),
			EvidenceRef: "http:" + rec.ID,
			Source:      "store",
		}, 200, nil
	}

	m.mu.Lock()
	var e *RingEntry
	if r := m.rings[keyOf(taskDir)]; r != nil {
		e = r.byID[trafficID]
	}
	m.mu.Unlock()
	if e == nil {
		return nil, 404, errors.New("traffic not found")
	}
	body := e.ResBody
	headers := e.Write.ResHeaders
	if side == "req" {
		body = e.ReqBody
		headers = e.Write.ReqHeaders
	}
	if body == nil || body.Size <= 0 {
		return nil, 404, fmt.Errorf("no %s body", side)
	}
	bufLen := len(body.Head)
	if dec := store.DecodeTrafficBody(body.Head, headers, store.MaxDecompressedBlobBytes); dec != nil {
		end := offset + maxBytes
		if end > len(dec.Bytes) {
			end = len(dec.Bytes)
		}
		var chunk []byte
		if offset < len(dec.Bytes) {
			chunk = dec.Bytes[offset:end]
		}
		next := offset + len(chunk)
		var nextPtr *int
		if next < len(dec.Bytes) {
			nextPtr = &next
		}
		rawSz := body.Size
		trunc := body.Size > int64(bufLen) || dec.Partial
		return &LiveBodySlice{
			SHA256:          body.SHA256,
			Offset:          offset,
			MaxBytes:        maxBytes,
			Size:            int64(len(dec.Bytes)),
			RawSize:         &rawSz,
			DecodedEncoding: dec.Encoding,
			BytesBase64:     base64.StdEncoding.EncodeToString(chunk),
			NextOffset:      nextPtr,
			Side:            side,
			ContentType:     body.ContentType,
			Body:            string(chunk),
			EvidenceRef:     "http:" + e.ID,
			Truncated:       &trunc,
			BufferedBytes:   &bufLen,
			Source:          "ring",
		}, 200, nil
	}

	end := offset + maxBytes
	if end > bufLen {
		end = bufLen
	}
	var chunk []byte
	if offset < bufLen {
		chunk = body.Head[offset:end]
	}
	next := offset + len(chunk)
	var nextPtr *int
	if next < bufLen {
		nextPtr = &next
	}
	trunc := body.Size > int64(bufLen)
	return &LiveBodySlice{
		SHA256:        body.SHA256,
		Offset:        offset,
		MaxBytes:      maxBytes,
		Size:          body.Size,
		BytesBase64:   base64.StdEncoding.EncodeToString(chunk),
		NextOffset:    nextPtr,
		Side:          side,
		ContentType:   body.ContentType,
		Body:          string(chunk),
		EvidenceRef:   "http:" + e.ID,
		Truncated:     &trunc,
		BufferedBytes: &bufLen,
		Source:        "ring",
	}, 200, nil
}

func storeCapturedBody(taskDir string, body *CapturedBody) (*store.TrafficBlobRef, string, error) {
	if body == nil || len(body.Head) == 0 {
		return nil, "", nil
	}
	ref, err := store.PutBlob(taskDir, body.Head, body.ContentType)
	if err != nil {
		return nil, "", err
	}
	if body.Size <= int64(len(body.Head)) {
		return ref, "", nil
	}
	return ref, fmt.Sprintf("size=%d sha256=%s kept=%d", body.Size, body.SHA256, len(body.Head)), nil
}

func (m *Manager) PersistCaptured(taskDir, id string, write store.TrafficWrite, reqBody, resBody *CapturedBody, findingIDs []string, ret *store.RetentionConfig) (*store.TrafficRecord, error) {
	cfg := store.DefaultRetention()
	if ret != nil {
		cfg = *ret
	}
	reqRef, reqTrunc, err := storeCapturedBody(taskDir, reqBody)
	if err != nil {
		return nil, err
	}
	resRef, resTrunc, err := storeCapturedBody(taskDir, resBody)
	if err != nil {
		return nil, err
	}
	resHeaders := make(map[string]any, len(write.ResHeaders)+2)
	for k, v := range write.ResHeaders {
		resHeaders[k] = v
	}
	if reqTrunc != "" {
		resHeaders[TruncatedHeader+"-req"] = reqTrunc
	}
	if resTrunc != "" {
		resHeaders[TruncatedHeader+"-res"] = resTrunc
	}
	w := write
	w.ID = id
	w.ResHeaders = resHeaders
	w.ReqBody = reqRef
	w.ResBody = resRef
	w.ReqPreview = previewOf(reqBody, write.ReqHeaders, cfg.MaxPreviewChars)
	w.ResPreview = previewOf(resBody, write.ResHeaders, cfg.MaxPreviewChars)
	w.FindingIDs = findingIDs
	return m.store.InsertTraffic(taskDir, w, &cfg)
}

func TargetHostOf(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.Trim(u.Hostname(), "[]"))
}

type PromoteOptions struct {
	TaskDir      string                 `json:"taskDir"`
	FindingID    string                 `json:"findingId"`
	IntentID     string                 `json:"intentId,omitempty"`
	Host         string                 `json:"host,omitempty"`
	Asset        string                 `json:"asset,omitempty"`
	TrafficIDs   []string               `json:"trafficIds,omitempty"`
	PreWindowMs  *int                   `json:"preWindowMs,omitempty"`
	PreMaxItems  *int                   `json:"preMaxItems,omitempty"`
	PostWindowMs *int                   `json:"postWindowMs,omitempty"`
	PostMaxItems *int                   `json:"postMaxItems,omitempty"`
	Converge     bool                   `json:"converge,omitempty"`
	Retention    *store.RetentionConfig `json:"retention,omitempty"`
	NowMs        *int64                 `json:"nowMs,omitempty"`
}

type WindowView struct {
	ExpiresAt string `json:"expiresAt"`
	Remaining int    `json:"remaining"`
	IntentID  string `json:"intentId,omitempty"`
	Host      string `json:"host,omitempty"`
}

type PromoteResult struct {
	FindingID  string      `json:"findingId"`
	TrafficIDs []string    `json:"trafficIds"`
	Promoted   int         `json:"promoted"`
	Window     *WindowView `json:"window"`
}

func (m *Manager) PromoteForFinding(opts PromoteOptions) (*PromoteResult, error) {
	defs := DefaultWindowConfig()
	now := time.Now().UnixMilli()
	if opts.NowMs != nil {
		now = *opts.NowMs
	}
	intentID := strings.TrimSpace(opts.IntentID)
	host := TargetHostOf(opts.Host)
	if host == "" {
		host = TargetHostOf(opts.Asset)
	}
	preWindowMs := defs.PreWindowMs
	if opts.PreWindowMs != nil {
		preWindowMs = *opts.PreWindowMs
	}
	preMaxItems := defs.PreMaxItems
	if opts.PreMaxItems != nil {
		preMaxItems = *opts.PreMaxItems
	}

	linked := make(map[string]bool)
	linkedOrder := []string{}
	addLinked := func(id string) {
		if !linked[id] {
			linked[id] = true
			linkedOrder = append(linkedOrder, id)
		}
	}
	promoted := 0

	isPersisted := func(e *RingEntry) bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return e.Persisted
	}
	markPersisted := func(e *RingEntry) {
		m.mu.Lock()
		e.Persisted = true
		m.mu.Unlock()
	}

	persistEntry := func(e *RingEntry) error {
		if isPersisted(e) {
			_ = m.store.LinkTrafficFinding(opts.TaskDir, e.ID, opts.FindingID)
			addLinked(e.ID)
			return nil
		}
		if existing, _ := m.store.GetTraffic(opts.TaskDir, e.ID); existing != nil {
			markPersisted(e)
			_ = m.store.LinkTrafficFinding(opts.TaskDir, e.ID, opts.FindingID)
			addLinked(e.ID)
			return nil
		}
		if _, err := m.PersistCaptured(opts.TaskDir, e.ID, e.Write, e.ReqBody, e.ResBody, []string{opts.FindingID}, opts.Retention); err != nil {
			return err
		}
		markPersisted(e)
		promoted++
		addLinked(e.ID)
		return nil
	}

	k := keyOf(opts.TaskDir)
	for _, rawID := range opts.TrafficIDs {
		tid := strings.TrimPrefix(strings.TrimSpace(rawID), "http:")
		if tid == "" {
			continue
		}
		m.mu.Lock()
		var entry *RingEntry
		if r := m.rings[k]; r != nil {
			entry = r.byID[tid]
		}
		m.mu.Unlock()
		if entry != nil {
			if err := persistEntry(entry); err != nil {
				return nil, err
			}
		} else if existing, _ := m.store.GetTraffic(opts.TaskDir, tid); existing != nil {
			_ = m.store.LinkTrafficFinding(opts.TaskDir, tid, opts.FindingID)
			addLinked(tid)
		}
	}

	if (intentID != "" || host != "") && preMaxItems > 0 {
		since := now - int64(preWindowMs)
		var picks []*RingEntry
		m.mu.Lock()
		if r := m.rings[k]; r != nil {
			for i := len(r.entries) - 1; i >= 0 && len(picks) < preMaxItems; i-- {
				e := r.entries[i]
				if e.AtMs < since {
					break
				}
				sameIntent := intentID != "" && e.Write.IntentID == intentID
				sameHost := host != "" && strings.EqualFold(e.Write.Host, host)
				if sameIntent || sameHost {
					picks = append(picks, e)
				}
			}
		}
		m.mu.Unlock()
		for i := len(picks) - 1; i >= 0; i-- {
			if err := persistEntry(picks[i]); err != nil {
				return nil, err
			}
		}
	}

	win := m.OpenWindow(OpenWindowOptions{
		TaskDir:      opts.TaskDir,
		FindingID:    opts.FindingID,
		IntentID:     intentID,
		Host:         host,
		PostWindowMs: opts.PostWindowMs,
		PostMaxItems: opts.PostMaxItems,
		Converge:     opts.Converge,
		NowMs:        &now,
	})
	return &PromoteResult{
		FindingID:  opts.FindingID,
		TrafficIDs: linkedOrder,
		Promoted:   promoted,
		Window:     win,
	}, nil
}

type OpenWindowOptions struct {
	TaskDir      string `json:"taskDir"`
	FindingID    string `json:"findingId"`
	IntentID     string `json:"intentId,omitempty"`
	Host         string `json:"host,omitempty"`
	PostWindowMs *int   `json:"postWindowMs,omitempty"`
	PostMaxItems *int   `json:"postMaxItems,omitempty"`
	Converge     bool   `json:"converge,omitempty"`
	NowMs        *int64 `json:"nowMs,omitempty"`
}

func (m *Manager) OpenWindow(opts OpenWindowOptions) *WindowView {
	defs := DefaultWindowConfig()
	now := time.Now().UnixMilli()
	if opts.NowMs != nil {
		now = *opts.NowMs
	}
	intentID := strings.TrimSpace(opts.IntentID)
	host := TargetHostOf(opts.Host)
	ms := int64(defs.PostWindowMs)
	if opts.PostWindowMs != nil {
		ms = int64(*opts.PostWindowMs)
	}

	k := keyOf(opts.TaskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	byF, ok := m.windows[k]
	if !ok {
		byF = make(map[string]*PostWindow)
		m.windows[k] = byF
	}
	existing := byF[opts.FindingID]
	if opts.Converge {
		capItems := DefaultConfirmItems
		if opts.PostMaxItems != nil {
			capItems = *opts.PostMaxItems
		}
		if existing != nil && existing.ExpiresAt > now {
			if capItems < existing.Remaining {
				existing.Remaining = capItems
			}
			if now+ms < existing.ExpiresAt {
				existing.ExpiresAt = now + ms
			}
			if intentID != "" && existing.IntentID == "" {
				existing.IntentID = intentID
			}
			if host != "" && existing.Host == "" {
				existing.Host = host
			}
		} else if intentID != "" || host != "" {
			byF[opts.FindingID] = &PostWindow{
				FindingID: opts.FindingID,
				IntentID:  intentID,
				Host:      host,
				ExpiresAt: now + ms,
				Remaining: capItems,
			}
		}
	} else if intentID != "" || host != "" {
		maxItems := defs.PostMaxItems
		if opts.PostMaxItems != nil {
			maxItems = *opts.PostMaxItems
		}
		effIntent := intentID
		if effIntent == "" && existing != nil {
			effIntent = existing.IntentID
		}
		effHost := host
		if effHost == "" && existing != nil {
			effHost = existing.Host
		}
		byF[opts.FindingID] = &PostWindow{
			FindingID: opts.FindingID,
			IntentID:  effIntent,
			Host:      effHost,
			ExpiresAt: now + ms,
			Remaining: maxItems,
		}
	}
	win := byF[opts.FindingID]
	if win == nil || win.Remaining <= 0 || win.ExpiresAt <= now {
		delete(byF, opts.FindingID)
		return nil
	}
	return &WindowView{
		ExpiresAt: time.UnixMilli(win.ExpiresAt).UTC().Format("2006-01-02T15:04:05.000Z"),
		Remaining: win.Remaining,
		IntentID:  win.IntentID,
		Host:      win.Host,
	}
}

func (m *Manager) CloseWindow(taskDir, findingID string) bool {
	k := keyOf(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	byF := m.windows[k]
	if byF == nil {
		return false
	}
	_, existed := byF[findingID]
	delete(byF, findingID)
	return existed
}

func (m *Manager) MatchWindows(taskDir, intentID, host string, nowMs int64) []string {
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
	k := keyOf(taskDir)
	lh := strings.ToLower(host)
	m.mu.Lock()
	defer m.mu.Unlock()
	byF := m.windows[k]
	if len(byF) == 0 {
		return nil
	}
	var out []string
	for id, win := range byF {
		if win.ExpiresAt <= nowMs || win.Remaining <= 0 {
			delete(byF, id)
			continue
		}
		sameIntent := win.IntentID != "" && intentID == win.IntentID
		sameHost := win.Host != "" && win.Host == lh
		if sameIntent || sameHost {
			out = append(out, id)
		}
	}
	return out
}

func (m *Manager) ConsumeWindows(taskDir string, findingIDs []string) {
	k := keyOf(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	byF := m.windows[k]
	if byF == nil {
		return
	}
	for _, id := range findingIDs {
		win := byF[id]
		if win == nil {
			continue
		}
		win.Remaining--
		if win.Remaining <= 0 {
			delete(byF, id)
		}
	}
}

func (m *Manager) ActiveWindows(taskDir string, nowMs int64) []PostWindow {
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
	k := keyOf(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	byF := m.windows[k]
	out := []PostWindow{}
	for _, win := range byF {
		if win.ExpiresAt > nowMs && win.Remaining > 0 {
			out = append(out, *win)
		}
	}
	return out
}
