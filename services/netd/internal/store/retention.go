package store

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	TrafficPreviewChars    = 1024
	TrafficHeadersChars    = 2048
	TrafficMaxExchanges    = 8000
	TrafficPruneCheckEvery = 200
	TrafficPruneSlack      = 500
	TrafficVacuumPages     = 200
	headerValueCap         = 240
)

type RetentionConfig struct {
	MaxPreviewChars     int  `json:"maxPreviewChars"`
	MaxHeadersJsonChars int  `json:"maxHeadersJsonChars"`
	MaxExchanges        int  `json:"maxExchanges"`
	CompactStaticAssets bool `json:"compactStaticAssets"`
	CompactNoise        bool `json:"compactNoise"`
	NoiseRepeatAfter    int  `json:"noiseRepeatAfter"`
	NoiseHostThreshold  int  `json:"noiseHostThreshold"`
	PruneCheckEvery     int  `json:"pruneCheckEvery"`
	PruneSlack          int  `json:"pruneSlack"`
	VacuumPages         int  `json:"vacuumPages"`
}

func envInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func envOn(name string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	if raw == "" {
		return fallback
	}
	switch raw {
	case "0", "false", "off", "no":
		return false
	default:
		return true
	}
}

func DefaultRetention() RetentionConfig {
	maxPreview := envInt("GY_TRAFFIC_MAX_PREVIEW_CHARS", TrafficPreviewChars)
	if maxPreview < 0 {
		maxPreview = 0
	}
	maxHeaders := envInt("GY_TRAFFIC_MAX_HEADERS_CHARS", TrafficHeadersChars)
	if maxHeaders < 64 {
		maxHeaders = 64
	}
	maxEx := envInt("GY_TRAFFIC_MAX_EXCHANGES", TrafficMaxExchanges)
	if maxEx < 0 {
		maxEx = 0
	}
	repeatAfter := envInt("GY_TRAFFIC_NOISE_REPEAT_AFTER", 1)
	if repeatAfter < 1 {
		repeatAfter = 1
	}
	hostThresh := envInt("GY_TRAFFIC_NOISE_HOST_THRESHOLD", 32)
	if hostThresh < 1 {
		hostThresh = 1
	}
	pruneEvery := envInt("GY_TRAFFIC_PRUNE_CHECK_EVERY", TrafficPruneCheckEvery)
	if pruneEvery < 1 {
		pruneEvery = 1
	}
	pruneSlack := envInt("GY_TRAFFIC_PRUNE_SLACK", TrafficPruneSlack)
	if pruneSlack < 0 {
		pruneSlack = 0
	}
	vac := envInt("GY_TRAFFIC_VACUUM_PAGES", TrafficVacuumPages)
	if vac < 0 {
		vac = 0
	}
	return RetentionConfig{
		MaxPreviewChars:     maxPreview,
		MaxHeadersJsonChars: maxHeaders,
		MaxExchanges:        maxEx,
		CompactStaticAssets: envOn("GY_TRAFFIC_COMPACT_STATIC", true),
		CompactNoise:        envOn("GY_TRAFFIC_COMPACT_NOISE", true),
		NoiseRepeatAfter:    repeatAfter,
		NoiseHostThreshold:  hostThresh,
		PruneCheckEvery:     pruneEvery,
		PruneSlack:          pruneSlack,
		VacuumPages:         vac,
	}
}

var (
	headerPriority = map[string]int{
		"content-encoding": 0,
		"content-type":     1,
		"content-length":   2,
		"location":         3,
		"host":             4,
		"server":           5,
		"www-authenticate": 6,
		"authorization":    7,
		"cookie":           8,
		"set-cookie":       9,
	}
	slimHeadersSet = map[string]bool{
		"content-encoding": true,
		"content-type":     true,
		"content-length":   true,
		"location":         true,
		"host":             true,
		"server":           true,
		"cache-control":    true,
		"etag":             true,
	}
	staticExtRe  = regexp.MustCompile(`(?i)\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|woff2?|ttf|otf|eot|css|js|mjs|map)$`)
	staticTypeRe = regexp.MustCompile(`(?i)^(?:image/|font/|text/css\b|text/javascript\b|application/javascript\b|application/x-javascript\b|application/font-)`)
	apiTypeRe    = regexp.MustCompile(`(?i)json|html|xml|graphql|text/plain|problem\+`)
	binPreviewRe = regexp.MustCompile(`(?i)^(?:image|audio|video|font)/|^application/(?:octet-stream|zip|gzip|pdf|wasm|x-font|font)`)
)

func HeaderValue(headers map[string]any, name string) string {
	target := strings.ToLower(name)
	for k, v := range headers {
		if strings.ToLower(k) != target {
			continue
		}
		switch tv := v.(type) {
		case string:
			return tv
		case []string:
			if len(tv) > 0 {
				return tv[0]
			}
		case []any:
			if len(tv) > 0 {
				if s, ok := tv[0].(string); ok {
					return s
				}
			}
		}
	}
	return ""
}

func ContentTypeBase(headers map[string]any) string {
	ct := HeaderValue(headers, "content-type")
	if idx := strings.Index(ct, ";"); idx >= 0 {
		ct = ct[:idx]
	}
	return strings.ToLower(strings.TrimSpace(ct))
}

func hasFinding(ids []string) bool {
	for _, id := range ids {
		if strings.TrimSpace(id) != "" {
			return true
		}
	}
	return false
}

func responseSetsState(resHeaders map[string]any) bool {
	return strings.TrimSpace(HeaderValue(resHeaders, "set-cookie")) != ""
}

func IsStaticAssetExchange(w TrafficWrite) bool {
	if hasFinding(w.FindingIDs) || responseSetsState(w.ResHeaders) {
		return false
	}
	m := strings.ToUpper(w.Method)
	if m != "GET" && m != "HEAD" {
		return false
	}
	switch w.Status {
	case 200, 204, 301, 302, 304:
	default:
		return false
	}
	ct := ContentTypeBase(w.ResHeaders)
	if ct != "" && apiTypeRe.MatchString(ct) {
		return false
	}
	pathOnly := w.Path
	if idx := strings.Index(pathOnly, "?"); idx >= 0 {
		pathOnly = pathOnly[:idx]
	}
	pathOnly = strings.ToLower(pathOnly)
	if strings.Contains(pathOnly, "/api/") || strings.Contains(pathOnly, "graphql") {
		return false
	}
	if ct != "" && staticTypeRe.MatchString(ct) {
		return true
	}
	if staticExtRe.MatchString(pathOnly) && (ct == "" || staticTypeRe.MatchString(ct) || ct == "application/octet-stream") {
		return true
	}
	return false
}

func IsNoiseExchange(w TrafficWrite, samePath404, host404 int, cfg RetentionConfig) bool {
	if !cfg.CompactNoise || hasFinding(w.FindingIDs) || responseSetsState(w.ResHeaders) {
		return false
	}
	if w.Status != 404 {
		return false
	}
	if samePath404 >= cfg.NoiseRepeatAfter {
		return true
	}
	return host404 >= cfg.NoiseHostThreshold
}

func clipString(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

func UsablePreview(text, ct string, maxChars int) string {
	if maxChars <= 0 || text == "" {
		return ""
	}
	if binPreviewRe.MatchString(ct) {
		return ""
	}
	sample := []rune(text)
	if len(sample) > 256 {
		sample = sample[:256]
	}
	bad := 0
	for _, r := range sample {
		if r == 0xfffd || r == 0 || (r < 32 && r != 9 && r != 10 && r != 13) {
			bad++
		}
	}
	if len(sample) > 0 && float64(bad)/float64(len(sample)) > 0.3 {
		return ""
	}
	return clipString(text, maxChars)
}

func clipHeaderMap(headers map[string]any) map[string]any {
	out := make(map[string]any, len(headers))
	for k, v := range headers {
		switch tv := v.(type) {
		case string:
			out[k] = clipString(tv, headerValueCap)
		case []string:
			cp := make([]string, len(tv))
			for i, item := range tv {
				cp[i] = clipString(item, headerValueCap)
			}
			out[k] = cp
		case []any:
			cp := make([]string, 0, len(tv))
			for _, item := range tv {
				if s, ok := item.(string); ok {
					cp = append(cp, clipString(s, headerValueCap))
				}
			}
			out[k] = cp
		}
	}
	return out
}

func jsonLen(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(b)
}

func CapHeaders(headers map[string]any, maxChars int) map[string]any {
	full := clipHeaderMap(headers)
	if jsonLen(full) <= maxChars {
		return full
	}
	keys := make([]string, 0, len(full))
	for k := range full {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		pi, oki := headerPriority[strings.ToLower(keys[i])]
		if !oki {
			pi = len(headerPriority)
		}
		pj, okj := headerPriority[strings.ToLower(keys[j])]
		if !okj {
			pj = len(headerPriority)
		}
		if pi != pj {
			return pi < pj
		}
		return keys[i] < keys[j]
	})
	kept := make(map[string]any)
	for _, k := range keys {
		kept[k] = full[k]
		if jsonLen(kept) > maxChars {
			delete(kept, k)
		}
	}
	return kept
}

func SlimHeaders(headers map[string]any, maxChars int) map[string]any {
	slim := make(map[string]any)
	for k, v := range headers {
		if slimHeadersSet[strings.ToLower(k)] {
			slim[k] = v
		}
	}
	return CapHeaders(slim, maxChars)
}

func ShapeTrafficWrite(w TrafficWrite, cfg RetentionConfig, metadataOnly bool) TrafficWrite {
	out := w
	if metadataOnly && !hasFinding(w.FindingIDs) {
		out.ReqPreview = ""
		out.ResPreview = ""
		out.ReqHeaders = SlimHeaders(w.ReqHeaders, cfg.MaxHeadersJsonChars)
		out.ResHeaders = SlimHeaders(w.ResHeaders, cfg.MaxHeadersJsonChars)
		return out
	}
	out.ReqPreview = UsablePreview(w.ReqPreview, ContentTypeBase(w.ReqHeaders), cfg.MaxPreviewChars)
	out.ResPreview = UsablePreview(w.ResPreview, ContentTypeBase(w.ResHeaders), cfg.MaxPreviewChars)
	out.ReqHeaders = CapHeaders(w.ReqHeaders, cfg.MaxHeadersJsonChars)
	out.ResHeaders = CapHeaders(w.ResHeaders, cfg.MaxHeadersJsonChars)
	return out
}

func TrafficPruneDue(total, maxExchanges, slack int) bool {
	if slack < 0 {
		slack = 0
	}
	return maxExchanges > 0 && total > maxExchanges+slack
}

func TrafficPruneCount(total, maxExchanges int) int {
	if maxExchanges <= 0 || total <= maxExchanges {
		return 0
	}
	low := int(float64(maxExchanges) * 0.9)
	if low < 1 {
		low = 1
	}
	if total <= low {
		return 0
	}
	return total - low
}
