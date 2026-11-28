package store

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

const (
	MaxCompressedBlobBytes   = 2 * 1024 * 1024
	MaxDecompressedBlobBytes = 8 * 1024 * 1024
	partialFallbackInput     = 64 * 1024
)

var errTooLarge = errors.New("decompressed output exceeds limit")

type DecodedBody struct {
	Bytes    []byte
	Encoding string
	Partial  bool
}

// ParseContentEncodings returns tokens in application order, [] when identity/absent,
// or nil when any encoding token is unsupported.
func ParseContentEncodings(headers map[string]any) []string {
	if len(headers) == 0 {
		return []string{}
	}
	var tokens []string
	for k, raw := range headers {
		if !strings.EqualFold(k, "content-encoding") || raw == nil {
			continue
		}
		var parts []string
		switch v := raw.(type) {
		case string:
			parts = []string{v}
		case []string:
			parts = v
		case []any:
			for _, item := range v {
				if s, ok := item.(string); ok {
					parts = append(parts, s)
				}
			}
		}
		for _, part := range parts {
			for _, item := range strings.Split(part, ",") {
				norm := strings.ToLower(strings.TrimSpace(item))
				if norm == "" || norm == "identity" {
					continue
				}
				tokens = append(tokens, norm)
			}
		}
	}
	if len(tokens) == 0 {
		return []string{}
	}
	for _, tok := range tokens {
		switch tok {
		case "gzip", "x-gzip", "deflate", "br", "zstd":
		default:
			return nil
		}
	}
	return tokens
}

func HasSupportedContentEncoding(headers map[string]any) bool {
	enc := ParseContentEncodings(headers)
	return enc != nil && len(enc) > 0
}

func readBounded(r io.Reader, maxOut int) ([]byte, bool, error) {
	var buf bytes.Buffer
	tmp := make([]byte, 16*1024)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			if buf.Len()+n > maxOut {
				return nil, false, errTooLarge
			}
			buf.Write(tmp[:n])
		}
		if err == io.EOF {
			return buf.Bytes(), false, nil
		}
		if err != nil {
			if buf.Len() > 0 && (errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(err.Error(), "unexpected EOF")) {
				return buf.Bytes(), true, nil
			}
			return nil, false, err
		}
	}
}

func decompressOnce(raw []byte, enc string, maxOut int) ([]byte, bool, error) {
	switch enc {
	case "gzip", "x-gzip":
		gr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, false, err
		}
		defer gr.Close()
		return readBounded(gr, maxOut)
	case "deflate":
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err == nil {
			out, partial, rerr := readBounded(zr, maxOut)
			_ = zr.Close()
			if rerr == nil || errors.Is(rerr, errTooLarge) {
				return out, partial, rerr
			}
		}
		fr := flate.NewReader(bytes.NewReader(raw))
		defer fr.Close()
		return readBounded(fr, maxOut)
	case "br":
		br := brotli.NewReader(bytes.NewReader(raw))
		return readBounded(br, maxOut)
	case "zstd":
		dec, err := zstd.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, false, err
		}
		defer dec.Close()
		return readBounded(dec, maxOut)
	default:
		return nil, false, errors.New("unsupported encoding")
	}
}

func DecodeTrafficBody(raw []byte, headers map[string]any, maxOut int) *DecodedBody {
	if maxOut <= 0 {
		maxOut = MaxDecompressedBlobBytes
	}
	encs := ParseContentEncodings(headers)
	if encs == nil || len(encs) == 0 {
		return nil
	}
	cur := raw
	partial := false
	for i := len(encs) - 1; i >= 0; i-- {
		if len(cur) == 0 {
			continue
		}
		out, isPartial, err := decompressOnce(cur, encs[i], maxOut)
		if err != nil {
			if errors.Is(err, errTooLarge) && len(cur) > partialFallbackInput {
				out2, _, err2 := decompressOnce(cur[:partialFallbackInput], encs[i], maxOut)
				if err2 == nil && len(out2) > 0 {
					cur = out2
					partial = true
					continue
				}
			}
			return nil
		}
		cur = out
		if isPartial {
			partial = true
		}
	}
	return &DecodedBody{
		Bytes:    cur,
		Encoding: strings.Join(encs, ", "),
		Partial:  partial,
	}
}

func DecodeTrafficPreview(raw []byte, headers map[string]any, maxBytes int) string {
	if maxBytes <= 0 || len(raw) == 0 {
		return ""
	}
	src := raw
	if dec := DecodeTrafficBody(raw, headers, MaxDecompressedBlobBytes); dec != nil {
		src = dec.Bytes
	}
	if len(src) > maxBytes {
		src = src[:maxBytes]
	}
	return string(src)
}
