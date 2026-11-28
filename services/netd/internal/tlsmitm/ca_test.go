package tlsmitm_test

import (
	"crypto/x509"
	"os"
	"sync"
	"testing"

	"github.com/Sycun/GongYuAI/services/netd/internal/tlsmitm"
)

func TestEnsureCAConcurrentAndReload(t *testing.T) {
	mgr := tlsmitm.NewManager(2)
	taskDir := t.TempDir()

	if _, err := mgr.EnsureCA(taskDir, "bad\nsubject"); err == nil {
		t.Fatal("expected CRLF subject to be rejected")
	}

	var wg sync.WaitGroup
	cas := make([]*tlsmitm.TaskCA, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ca, err := mgr.EnsureCA(taskDir, "/O=GongYu/CN=GongYu Test CA")
			if err != nil {
				t.Errorf("EnsureCA[%d]: %v", idx, err)
				return
			}
			cas[idx] = ca
		}(i)
	}
	wg.Wait()

	base := cas[0]
	if base == nil || !base.Cert.IsCA || base.Cert.Subject.CommonName != "GongYu Test CA" {
		t.Fatalf("unexpected CA: %+v", base)
	}
	for i, ca := range cas {
		if ca == nil || ca.Cert.SerialNumber.Cmp(base.Cert.SerialNumber) != 0 {
			t.Fatalf("CA mismatch across concurrent callers at %d", i)
		}
	}
	info, err := os.Stat(base.KeyPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 CA private key, got mode=%v err=%v", info.Mode().Perm(), err)
	}

	mgr.InvalidateTask(taskDir)
	reloaded, err := mgr.EnsureCA(taskDir, "")
	if err != nil || reloaded.Cert.SerialNumber.Cmp(base.Cert.SerialNumber) != 0 {
		t.Fatalf("expected reload to reuse persisted CA, err=%v", err)
	}
}

func TestLeafCertSANsAndLRUEviction(t *testing.T) {
	mgr := tlsmitm.NewManager(2)
	ca, err := mgr.EnsureCA(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{"", "../etc", "a/b", `a\b`} {
		if _, err := mgr.LeafCert(ca, bad); err == nil {
			t.Fatalf("expected invalid host %q to fail", bad)
		}
	}

	dnsCert, err := mgr.LeafCert(ca, "API.Example.TEST")
	if err != nil || len(dnsCert.Leaf.DNSNames) != 1 || dnsCert.Leaf.DNSNames[0] != "api.example.test" {
		t.Fatalf("unexpected DNS leaf: %+v err=%v", dnsCert, err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	if _, err := dnsCert.Leaf.Verify(x509.VerifyOptions{
		DNSName: "api.example.test",
		Roots:   pool,
	}); err != nil {
		t.Fatalf("DNS leaf failed x509 chain verification: %v", err)
	}

	ipCert, err := mgr.LeafCert(ca, "[::1]")
	if err != nil || len(ipCert.Leaf.IPAddresses) != 1 || ipCert.Leaf.IPAddresses[0].String() != "::1" {
		t.Fatalf("unexpected IPv6 leaf: %+v err=%v", ipCert, err)
	}
	if mgr.CacheSize() != 2 {
		t.Fatalf("expected cache size 2, got %d", mgr.CacheSize())
	}

	// Touch dnsCert so ipCert becomes LRU, then insert a 3rd host and confirm bounded cache size
	_, _ = mgr.LeafCert(ca, "api.example.test")
	thirdCert, err := mgr.LeafCert(ca, "127.0.0.1")
	if err != nil || mgr.CacheSize() != 2 {
		t.Fatalf("expected LRU cap at 2, got size=%d err=%v", mgr.CacheSize(), err)
	}
	cachedDNS, _ := mgr.LeafCert(ca, "api.example.test")
	if cachedDNS != dnsCert || thirdCert == nil {
		t.Fatal("expected MRU entry to stay cached after eviction")
	}
}
