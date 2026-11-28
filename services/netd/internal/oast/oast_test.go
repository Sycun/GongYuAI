package oast_test

import (
	"bytes"
	"encoding/binary"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/oast"
)

func buildDNSQuery(id uint16, qname string, qtype uint16) []byte {
	var b bytes.Buffer
	var hdr [12]byte
	binary.BigEndian.PutUint16(hdr[0:2], id)
	binary.BigEndian.PutUint16(hdr[2:4], 0x0100)
	binary.BigEndian.PutUint16(hdr[4:6], 1)
	b.Write(hdr[:])
	for _, label := range strings.Split(qname, ".") {
		if label == "" {
			continue
		}
		b.WriteByte(byte(len(label)))
		b.WriteString(label)
	}
	b.WriteByte(0)
	var tail [4]byte
	binary.BigEndian.PutUint16(tail[0:2], qtype)
	binary.BigEndian.PutUint16(tail[2:4], 1)
	b.Write(tail[:])
	return b.Bytes()
}

func TestHTTPOastTokensAndLimits(t *testing.T) {
	mgr := oast.NewManager()
	defer mgr.StopAll()

	if _, err := mgr.StartHTTP(oast.HTTPOptions{PublicBaseURL: ""}); err == nil {
		t.Fatal("expected missing publicBaseUrl error")
	}

	maxBody := 32
	inst, err := mgr.StartHTTP(oast.HTTPOptions{
		ListenHost:    "127.0.0.1",
		ListenPort:    0,
		PublicBaseURL: "http://oast.example.test",
		MaxBodyBytes:  &maxBody,
	})
	if err != nil {
		t.Fatal(err)
	}
	ch, existing, unsub := inst.Subscribe()
	defer unsub()
	if len(existing) != 0 {
		t.Fatalf("expected 0 initial hits, got %d", len(existing))
	}

	// Missing token -> 400
	resp400, err := http.Get(inst.BoundURL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp400.Body.Close()
	if resp400.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 without token, got %d", resp400.StatusCode)
	}

	// Query param token + X-Forwarded-For
	reqQ, _ := http.NewRequest("POST", inst.BoundURL+"/callback?t=tokquery123", strings.NewReader("small"))
	reqQ.Header.Set("X-Forwarded-For", "10.9.8.7, 127.0.0.1")
	reqQ.Header.Set("User-Agent", "OastProbe/1.0")
	respQ, err := http.DefaultClient.Do(reqQ)
	if err != nil || respQ.StatusCode != 200 {
		t.Fatalf("query token request failed: resp=%+v err=%v", respQ, err)
	}
	_ = respQ.Body.Close()

	// Host header subdomain token
	reqH, _ := http.NewRequest("GET", inst.BoundURL+"/", nil)
	reqH.Host = "subtoken9999.oast.example.test:8080"
	respH, err := http.DefaultClient.Do(reqH)
	if err != nil || respH.StatusCode != 200 {
		t.Fatalf("host token request failed: resp=%+v err=%v", respH, err)
	}
	_ = respH.Body.Close()

	// Oversized body (>32 bytes) must be dropped without publishing a hit
	reqBig, _ := http.NewRequest("POST", inst.BoundURL+"/t/oversizedtok", strings.NewReader(strings.Repeat("X", 128)))
	_, _ = http.DefaultClient.Do(reqBig)

	var got []oast.Hit
	deadline := time.After(2 * time.Second)
	for len(got) < 2 {
		select {
		case h := <-ch:
			got = append(got, h)
		case <-deadline:
			t.Fatalf("timed out waiting for hits, got %+v", got)
		}
	}
	if got[0].Token != "tokquery123" || got[0].SourceIP != "10.9.8.7" || got[1].Token != "subtoken9999" {
		t.Fatalf("unexpected hit metadata: %+v", got)
	}
	if len(inst.Hits()) != 2 {
		t.Fatalf("oversized request must not record a hit, total=%d", len(inst.Hits()))
	}
}

func TestDNSOastTokenValidationAndServer(t *testing.T) {
	if tok := oast.DNSTokenFor("AbCd1234.OAST.Test.", "oast.test"); tok != "abcd1234" {
		t.Fatalf("expected abcd1234, got %q", tok)
	}
	for _, bad := range []string{"short.oast.test", "a.b.abcd1234.oast.test", "bad_char12.oast.test", "abcd1234.other.test"} {
		if tok := oast.DNSTokenFor(bad, "oast.test"); tok != "" {
			t.Fatalf("expected %q to be rejected, got %q", bad, tok)
		}
	}

	mgr := oast.NewManager()
	defer mgr.StopAll()
	ttl := 120
	dnsInst, err := mgr.StartDNS(oast.DNSOptions{
		ListenHost: "127.0.0.1",
		ListenPort: 0,
		Domain:     "oast.test",
		AnswerIP:   "192.0.2.55",
		TTLSec:     &ttl,
	})
	if err != nil {
		t.Fatal(err)
	}

	client, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: dnsInst.Port})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))

	// 1) Valid A query -> RCODE 0 + 1 answer ending in 192.0.2.55 + hit recorded
	qValid := buildDNSQuery(0x1234, "deadbeef01.oast.test", 1)
	if _, err := client.Write(qValid); err != nil {
		t.Fatal(err)
	}
	resp := make([]byte, 512)
	n, err := client.Read(resp)
	if err != nil || n < 28 {
		t.Fatalf("unexpected DNS A reply len=%d err=%v", n, err)
	}
	if rcode := binary.BigEndian.Uint16(resp[2:4]) & 0x0f; rcode != 0 {
		t.Fatalf("expected RCODE 0, got %d", rcode)
	}
	if gotIP := net.IP(resp[n-4 : n]).String(); gotIP != "192.0.2.55" {
		t.Fatalf("expected answer IP 192.0.2.55, got %s", gotIP)
	}

	// 2) Non-matching domain -> NXDOMAIN (RCODE 3) and no extra hit
	qMiss := buildDNSQuery(0x5678, "deadbeef01.wrong.test", 1)
	_, _ = client.Write(qMiss)
	n2, err := client.Read(resp)
	if err != nil || (binary.BigEndian.Uint16(resp[2:4])&0x0f) != 3 || n2 == 0 {
		t.Fatalf("expected NXDOMAIN on wrong domain, err=%v", err)
	}

	hits := dnsInst.Hits()
	if len(hits) != 1 || hits[0].Token != "deadbeef01" || hits[0].Protocol != "dns" {
		t.Fatalf("unexpected DNS hits: %+v", hits)
	}
}
