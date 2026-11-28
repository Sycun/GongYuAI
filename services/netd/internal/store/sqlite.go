package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

type TrafficWrite struct {
	ID         string          `json:"id,omitempty"`
	TaskID     string          `json:"taskId"`
	IntentID   string          `json:"intentId,omitempty"`
	WorkerID   string          `json:"workerId,omitempty"`
	Method     string          `json:"method"`
	URL        string          `json:"url"`
	Host       string          `json:"host"`
	Path       string          `json:"path"`
	Status     int             `json:"status"`
	DurationMs int64           `json:"durationMs"`
	StartedAt  string          `json:"startedAt"`
	ReqHeaders map[string]any  `json:"reqHeaders"`
	ResHeaders map[string]any  `json:"resHeaders"`
	ReqBody    *TrafficBlobRef `json:"reqBody,omitempty"`
	ResBody    *TrafficBlobRef `json:"resBody,omitempty"`
	ReqPreview string          `json:"reqPreview,omitempty"`
	ResPreview string          `json:"resPreview,omitempty"`
	FindingIDs []string        `json:"findingIds,omitempty"`
}

type TrafficRecord struct {
	ID          string          `json:"id"`
	TaskID      string          `json:"taskId"`
	IntentID    string          `json:"intentId,omitempty"`
	WorkerID    string          `json:"workerId,omitempty"`
	Method      string          `json:"method"`
	URL         string          `json:"url"`
	Host        string          `json:"host"`
	Path        string          `json:"path"`
	Status      int             `json:"status"`
	DurationMs  int64           `json:"durationMs"`
	StartedAt   string          `json:"startedAt"`
	ReqHeaders  map[string]any  `json:"reqHeaders"`
	ResHeaders  map[string]any  `json:"resHeaders"`
	ReqBodyBlob *TrafficBlobRef `json:"reqBodyBlob,omitempty"`
	ResBodyBlob *TrafficBlobRef `json:"resBodyBlob,omitempty"`
	FindingIDs  []string        `json:"findingIds,omitempty"`
}

type TrafficQuery struct {
	TaskID        string `json:"taskId"`
	IntentID      string `json:"intentId,omitempty"`
	WorkerID      string `json:"workerId,omitempty"`
	Method        string `json:"method,omitempty"`
	Host          string `json:"host,omitempty"`
	Path          string `json:"path,omitempty"`
	Status        *int   `json:"status,omitempty"`
	FindingID     string `json:"findingId,omitempty"`
	StartedAfter  string `json:"startedAfter,omitempty"`
	StartedBefore string `json:"startedBefore,omitempty"`
	Keyword       string `json:"keyword,omitempty"`
	Offset        int    `json:"offset,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

type TrafficPage struct {
	Traffic    []TrafficRecord `json:"traffic"`
	Total      int             `json:"total"`
	NextOffset *int            `json:"nextOffset"`
}

type taskDB struct {
	mu          sync.Mutex
	db          *sql.DB
	sincePrune  int
}

type StoreManager struct {
	mu  sync.Mutex
	dbs map[string]*taskDB
}

func NewStoreManager() *StoreManager {
	return &StoreManager{dbs: make(map[string]*taskDB)}
}

func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (m *StoreManager) open(taskDir string) (*taskDB, error) {
	key := filepath.Clean(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.dbs[key]; ok {
		return existing, nil
	}

	dbPath := filepath.Join(key, "traffic", "index.sqlite")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, err
	}
	_, statErr := os.Stat(dbPath)
	fresh := statErr != nil

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)

	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if fresh {
		_, _ = db.Exec("PRAGMA auto_vacuum = INCREMENTAL")
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA temp_store = MEMORY",
		"PRAGMA cache_size = -16000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			_ = db.Close()
			return nil, err
		}
	}

	const ddl = `
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      intent_id TEXT,
      worker_id TEXT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      req_headers_json TEXT NOT NULL,
      res_headers_json TEXT NOT NULL,
      req_sha256 TEXT,
      req_size INTEGER,
      req_type TEXT,
      res_sha256 TEXT,
      res_size INTEGER,
      res_type TEXT,
      req_preview TEXT NOT NULL DEFAULT '',
      res_preview TEXT NOT NULL DEFAULT '',
      finding_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_exchanges_task ON exchanges(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_exchanges_noise ON exchanges(task_id, host, status, path);
    CREATE TABLE IF NOT EXISTS validate_jobs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      status TEXT NOT NULL,
      validation_id TEXT,
      qualification TEXT,
      traffic_ids_json TEXT NOT NULL DEFAULT '[]',
      packet_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validate_jobs_finding
      ON validate_jobs(task_id, finding_id, created_at);
	`
	if _, err := db.Exec(ddl); err != nil {
		_ = db.Close()
		return nil, err
	}

	tdb := &taskDB{db: db}
	m.dbs[key] = tdb
	return tdb, nil
}

func (m *StoreManager) CloseTask(taskDir string) {
	key := filepath.Clean(taskDir)
	m.mu.Lock()
	tdb, ok := m.dbs[key]
	if ok {
		delete(m.dbs, key)
	}
	m.mu.Unlock()
	if ok {
		tdb.mu.Lock()
		_ = tdb.db.Close()
		tdb.mu.Unlock()
	}
}

func (m *StoreManager) CloseAll() {
	m.mu.Lock()
	all := m.dbs
	m.dbs = make(map[string]*taskDB)
	m.mu.Unlock()
	for _, tdb := range all {
		tdb.mu.Lock()
		_ = tdb.db.Close()
		tdb.mu.Unlock()
	}
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (m *StoreManager) InsertTraffic(taskDir string, input TrafficWrite, cfg *RetentionConfig) (*TrafficRecord, error) {
	tdb, err := m.open(taskDir)
	if err != nil {
		return nil, err
	}
	tdb.mu.Lock()
	defer tdb.mu.Unlock()

	ret := DefaultRetention()
	if cfg != nil {
		ret = *cfg
	}

	if input.ID != "" {
		if existing, err := getTrafficLocked(tdb.db, input.ID); err == nil && existing != nil {
			for _, fid := range input.FindingIDs {
				_ = linkTrafficFindingLocked(tdb.db, input.ID, fid)
			}
			return getTrafficLocked(tdb.db, input.ID)
		}
	}

	same404, host404 := 0, 0
	if input.Status == 404 {
		_ = tdb.db.QueryRow(
			`SELECT count(*) FROM exchanges WHERE task_id = ? AND host = ? AND path = ? AND method = ? AND status = 404`,
			input.TaskID, input.Host, input.Path, input.Method,
		).Scan(&same404)
		_ = tdb.db.QueryRow(
			`SELECT count(*) FROM exchanges WHERE task_id = ? AND host = ? AND status = 404`,
			input.TaskID, input.Host,
		).Scan(&host404)
	}

	metadataOnly := (ret.CompactStaticAssets && IsStaticAssetExchange(input)) || IsNoiseExchange(input, same404, host404, ret)
	shaped := ShapeTrafficWrite(input, ret, metadataOnly)

	id := input.ID
	if id == "" {
		id = NewUUID()
	}
	reqHeadersJSON, _ := json.Marshal(shaped.ReqHeaders)
	if len(reqHeadersJSON) == 0 || string(reqHeadersJSON) == "null" {
		reqHeadersJSON = []byte("{}")
	}
	resHeadersJSON, _ := json.Marshal(shaped.ResHeaders)
	if len(resHeadersJSON) == 0 || string(resHeadersJSON) == "null" {
		resHeadersJSON = []byte("{}")
	}
	fids := shaped.FindingIDs
	if fids == nil {
		fids = []string{}
	}
	findingJSON, _ := json.Marshal(fids)

	var reqSHA, reqType, resSHA, resType any
	var reqSize, resSize any
	if shaped.ReqBody != nil {
		reqSHA = shaped.ReqBody.SHA256
		reqSize = shaped.ReqBody.Size
		reqType = nullableStr(shaped.ReqBody.ContentType)
	}
	if shaped.ResBody != nil {
		resSHA = shaped.ResBody.SHA256
		resSize = shaped.ResBody.Size
		resType = nullableStr(shaped.ResBody.ContentType)
	}

	_, err = tdb.db.Exec(
		`INSERT INTO exchanges (
			id, task_id, intent_id, worker_id, method, url, host, path, status, duration_ms, started_at,
			req_headers_json, res_headers_json, req_sha256, req_size, req_type, res_sha256, res_size, res_type,
			req_preview, res_preview, finding_ids_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		shaped.TaskID,
		nullableStr(shaped.IntentID),
		nullableStr(shaped.WorkerID),
		shaped.Method,
		shaped.URL,
		shaped.Host,
		shaped.Path,
		shaped.Status,
		shaped.DurationMs,
		shaped.StartedAt,
		string(reqHeadersJSON),
		string(resHeadersJSON),
		reqSHA, reqSize, reqType,
		resSHA, resSize, resType,
		shaped.ReqPreview,
		shaped.ResPreview,
		string(findingJSON),
	)
	if err != nil {
		return nil, err
	}

	maybePruneLocked(tdb, ret, id)

	rec := &TrafficRecord{
		ID:          id,
		TaskID:      shaped.TaskID,
		IntentID:    shaped.IntentID,
		WorkerID:    shaped.WorkerID,
		Method:      shaped.Method,
		URL:         shaped.URL,
		Host:        shaped.Host,
		Path:        shaped.Path,
		Status:      shaped.Status,
		DurationMs:  shaped.DurationMs,
		StartedAt:   shaped.StartedAt,
		ReqHeaders:  shaped.ReqHeaders,
		ResHeaders:  shaped.ResHeaders,
		ReqBodyBlob: shaped.ReqBody,
		ResBodyBlob: shaped.ResBody,
	}
	if len(fids) > 0 {
		rec.FindingIDs = fids
	}
	return rec, nil
}

func maybePruneLocked(tdb *taskDB, cfg RetentionConfig, protectID string) {
	if cfg.MaxExchanges <= 0 {
		return
	}
	tdb.sincePrune++
	every := cfg.PruneCheckEvery
	if every < 1 {
		every = 1
	}
	if tdb.sincePrune < every {
		return
	}
	tdb.sincePrune = 0
	var total int
	if err := tdb.db.QueryRow("SELECT count(*) FROM exchanges").Scan(&total); err != nil {
		return
	}
	if !TrafficPruneDue(total, cfg.MaxExchanges, cfg.PruneSlack) {
		return
	}
	remove := TrafficPruneCount(total, cfg.MaxExchanges)
	if remove <= 0 {
		return
	}
	res, err := tdb.db.Exec(
		`DELETE FROM exchanges
		 WHERE id IN (
			SELECT id FROM exchanges
			WHERE id != ?
			  AND (
				finding_ids_json = '[]'
				OR finding_ids_json = ''
				OR (json_valid(finding_ids_json) AND json_array_length(finding_ids_json) = 0)
			  )
			ORDER BY started_at ASC, rowid ASC
			LIMIT ?
		 )`,
		protectID, remove,
	)
	if err != nil {
		return
	}
	if deleted, _ := res.RowsAffected(); deleted > 0 && cfg.VacuumPages > 0 {
		_, _ = tdb.db.Exec(fmt.Sprintf("PRAGMA incremental_vacuum(%d)", cfg.VacuumPages))
	}
}

func scanRecord(scanner interface{ Scan(...any) error }) (*TrafficRecord, error) {
	var (
		id, taskID, method, urlStr, host, path, startedAt string
		intentID, workerID                                sql.NullString
		status                                            int
		durationMs                                        int64
		reqHeadersJSON, resHeadersJSON, findingJSON       string
		reqSHA, reqType, resSHA, resType                  sql.NullString
		reqSize, resSize                                  sql.NullInt64
	)
	err := scanner.Scan(
		&id, &taskID, &intentID, &workerID, &method, &urlStr, &host, &path, &status, &durationMs, &startedAt,
		&reqHeadersJSON, &resHeadersJSON, &reqSHA, &reqSize, &reqType, &resSHA, &resSize, &resType, &findingJSON,
	)
	if err != nil {
		return nil, err
	}
	reqH := map[string]any{}
	resH := map[string]any{}
	_ = json.Unmarshal([]byte(reqHeadersJSON), &reqH)
	_ = json.Unmarshal([]byte(resHeadersJSON), &resH)
	var fids []string
	_ = json.Unmarshal([]byte(findingJSON), &fids)

	rec := &TrafficRecord{
		ID:         id,
		TaskID:     taskID,
		IntentID:   intentID.String,
		WorkerID:   workerID.String,
		Method:     method,
		URL:        urlStr,
		Host:       host,
		Path:       path,
		Status:     status,
		DurationMs: durationMs,
		StartedAt:  startedAt,
		ReqHeaders: reqH,
		ResHeaders: resH,
	}
	if reqSHA.Valid && reqSHA.String != "" {
		rec.ReqBodyBlob = &TrafficBlobRef{SHA256: reqSHA.String, Size: reqSize.Int64, ContentType: reqType.String}
	}
	if resSHA.Valid && resSHA.String != "" {
		rec.ResBodyBlob = &TrafficBlobRef{SHA256: resSHA.String, Size: resSize.Int64, ContentType: resType.String}
	}
	if len(fids) > 0 {
		rec.FindingIDs = fids
	}
	return rec, nil
}

const selectCols = `id, task_id, intent_id, worker_id, method, url, host, path, status, duration_ms, started_at,
	req_headers_json, res_headers_json, req_sha256, req_size, req_type, res_sha256, res_size, res_type, finding_ids_json`

func getTrafficLocked(db *sql.DB, id string) (*TrafficRecord, error) {
	row := db.QueryRow("SELECT "+selectCols+" FROM exchanges WHERE id = ?", id)
	rec, err := scanRecord(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return rec, err
}

func (m *StoreManager) GetTraffic(taskDir, id string) (*TrafficRecord, error) {
	tdb, err := m.open(taskDir)
	if err != nil {
		return nil, err
	}
	tdb.mu.Lock()
	defer tdb.mu.Unlock()
	return getTrafficLocked(tdb.db, id)
}

func linkTrafficFindingLocked(db *sql.DB, trafficID, findingID string) error {
	var raw string
	err := db.QueryRow("SELECT finding_ids_json FROM exchanges WHERE id = ?", trafficID).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	var ids []string
	_ = json.Unmarshal([]byte(raw), &ids)
	for _, existing := range ids {
		if existing == findingID {
			return nil
		}
	}
	ids = append(ids, findingID)
	b, _ := json.Marshal(ids)
	_, err = db.Exec("UPDATE exchanges SET finding_ids_json = ? WHERE id = ?", string(b), trafficID)
	return err
}

func (m *StoreManager) LinkTrafficFinding(taskDir, trafficID, findingID string) error {
	tdb, err := m.open(taskDir)
	if err != nil {
		return err
	}
	tdb.mu.Lock()
	defer tdb.mu.Unlock()
	return linkTrafficFindingLocked(tdb.db, trafficID, findingID)
}

func (m *StoreManager) QueryTraffic(taskDir string, q TrafficQuery) (*TrafficPage, error) {
	tdb, err := m.open(taskDir)
	if err != nil {
		return nil, err
	}
	tdb.mu.Lock()
	defer tdb.mu.Unlock()

	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	offset := q.Offset
	if offset < 0 {
		offset = 0
	}

	clauses := []string{"task_id = ?"}
	args := []any{q.TaskID}
	if v := strings.TrimSpace(q.IntentID); v != "" {
		clauses = append(clauses, "intent_id = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(q.WorkerID); v != "" {
		clauses = append(clauses, "worker_id = ?")
		args = append(args, v)
	}
	if v := strings.ToUpper(strings.TrimSpace(q.Method)); v != "" {
		clauses = append(clauses, "method = ?")
		args = append(args, v)
	}
	if v := strings.ToLower(strings.TrimSpace(q.Host)); v != "" {
		clauses = append(clauses, "lower(host) = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(q.Path); v != "" {
		clauses = append(clauses, "path = ?")
		args = append(args, v)
	}
	if q.Status != nil {
		clauses = append(clauses, "status = ?")
		args = append(args, *q.Status)
	}
	if v := strings.TrimSpace(q.FindingID); v != "" {
		clauses = append(clauses, "instr(finding_ids_json, ?) > 0")
		args = append(args, v)
	}
	if v := strings.TrimSpace(q.StartedAfter); v != "" {
		clauses = append(clauses, "started_at >= ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(q.StartedBefore); v != "" {
		clauses = append(clauses, "started_at <= ?")
		args = append(args, v)
	}
	if v := strings.ToLower(strings.TrimSpace(q.Keyword)); v != "" {
		clauses = append(clauses, "instr(lower(url || char(10) || host || char(10) || path || char(10) || req_preview || char(10) || res_preview || char(10) || req_headers_json || char(10) || res_headers_json), ?) > 0")
		args = append(args, v)
	}

	where := "WHERE " + strings.Join(clauses, " AND ")
	var total int
	if err := tdb.db.QueryRow("SELECT count(*) FROM exchanges "+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	qArgs := append(append([]any{}, args...), limit, offset)
	rows, err := tdb.db.Query("SELECT "+selectCols+" FROM exchanges "+where+" ORDER BY started_at ASC, rowid ASC LIMIT ? OFFSET ?", qArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	traffic := []TrafficRecord{}
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		traffic = append(traffic, *rec)
	}
	next := offset + len(traffic)
	var nextPtr *int
	if next < total {
		nextPtr = &next
	}
	return &TrafficPage{Traffic: traffic, Total: total, NextOffset: nextPtr}, nil
}
