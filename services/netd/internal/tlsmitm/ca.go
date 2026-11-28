package tlsmitm

import (
	"container/list"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	DefaultCASubject  = "Local Proxy Root CA"
	DefaultLeafMaxCap = 2048
)

type TaskCA struct {
	CertPath string
	KeyPath  string
	Dir      string
	Cert     *x509.Certificate
	Key      crypto.Signer
	CertPEM  []byte
}

type leafEntry struct {
	key  string
	cert *tls.Certificate
}

type Manager struct {
	mu      sync.Mutex
	cas     map[string]*TaskCA
	leaves  map[string]*list.Element
	lru     *list.List
	maxLeaf int
}

func NewManager(maxLeaf int) *Manager {
	if maxLeaf <= 0 {
		maxLeaf = DefaultLeafMaxCap
	}
	return &Manager{
		cas:     make(map[string]*TaskCA),
		leaves:  make(map[string]*list.Element),
		lru:     list.New(),
		maxLeaf: maxLeaf,
	}
}

func (m *Manager) CacheSize() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lru.Len()
}

func (m *Manager) InvalidateTask(taskDir string) {
	clean := filepath.Clean(taskDir)
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.cas, clean)
}

func parsePrivateKey(pemBytes []byte) (crypto.Signer, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("invalid PEM private key")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if signer, ok := key.(crypto.Signer); ok {
			return signer, nil
		}
		return nil, errors.New("PKCS8 key is not a signer")
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, errors.New("unsupported CA private key format")
}

func loadCA(dir, certPath, keyPath string) (*TaskCA, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, errors.New("invalid CA cert PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	signer, err := parsePrivateKey(keyPEM)
	if err != nil {
		return nil, err
	}
	return &TaskCA{
		CertPath: certPath,
		KeyPath:  keyPath,
		Dir:      dir,
		Cert:     cert,
		Key:      signer,
		CertPEM:  certPEM,
	}, nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	n, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, err
	}
	if n.Sign() <= 0 {
		n = big.NewInt(1)
	}
	return n, nil
}

func parseCommonName(subject string) string {
	s := strings.TrimSpace(subject)
	if s == "" {
		return DefaultCASubject
	}
	for _, part := range strings.Split(s, "/") {
		if strings.HasPrefix(part, "CN=") {
			cn := strings.TrimSpace(strings.TrimPrefix(part, "CN="))
			if cn != "" {
				return cn
			}
		}
	}
	return s
}

func createCAFiles(dir, certPath, keyPath, subject string) (*TaskCA, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().Add(-5 * time.Minute)
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: parseCommonName(subject),
		},
		NotBefore:             now,
		NotAfter:              now.Add(30 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	nonce := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	tmpKey := filepath.Join(dir, "ca.key."+nonce+".tmp")
	tmpCrt := filepath.Join(dir, "ca.crt."+nonce+".tmp")
	if err := os.WriteFile(tmpKey, keyPEM, 0o600); err != nil {
		return nil, err
	}
	_ = os.Chmod(tmpKey, 0o600)
	if err := os.WriteFile(tmpCrt, certPEM, 0o644); err != nil {
		_ = os.Remove(tmpKey)
		return nil, err
	}
	_ = os.Chmod(tmpCrt, 0o644)
	if err := os.Rename(tmpKey, keyPath); err != nil {
		_ = os.Remove(tmpKey)
		_ = os.Remove(tmpCrt)
		return nil, err
	}
	if err := os.Rename(tmpCrt, certPath); err != nil {
		_ = os.Remove(tmpCrt)
		return nil, err
	}
	return &TaskCA{
		CertPath: certPath,
		KeyPath:  keyPath,
		Dir:      dir,
		Cert:     cert,
		Key:      priv,
		CertPEM:  certPEM,
	}, nil
}

// EnsureCA loads or atomically creates a per-task CA under <taskDir>/traffic/.
func (m *Manager) EnsureCA(taskDir, subject string) (*TaskCA, error) {
	if strings.ContainsAny(subject, "\r\n\x00") {
		return nil, errors.New("invalid CA subject")
	}
	clean := filepath.Clean(taskDir)
	dir := filepath.Join(clean, "traffic")
	certPath := filepath.Join(dir, "ca.crt")
	keyPath := filepath.Join(dir, "ca.key")

	m.mu.Lock()
	if cached, ok := m.cas[clean]; ok {
		if _, err := os.Stat(certPath); err == nil {
			m.mu.Unlock()
			return cached, nil
		}
		delete(m.cas, clean)
	}
	m.mu.Unlock()

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0o700)

	if ca, err := loadCA(dir, certPath, keyPath); err == nil {
		m.mu.Lock()
		m.cas[clean] = ca
		m.mu.Unlock()
		return ca, nil
	}

	lockDir := filepath.Join(dir, ".ca-init.lock")
	deadline := time.Now().Add(8 * time.Second)
	acquired := false
	for time.Now().Before(deadline) {
		if ca, err := loadCA(dir, certPath, keyPath); err == nil {
			m.mu.Lock()
			m.cas[clean] = ca
			m.mu.Unlock()
			return ca, nil
		}
		if err := os.Mkdir(lockDir, 0o700); err == nil {
			acquired = true
			break
		}
		if info, err := os.Stat(lockDir); err == nil && time.Since(info.ModTime()) > 15*time.Second {
			_ = os.RemoveAll(lockDir)
			continue
		}
		time.Sleep(25 * time.Millisecond)
	}
	if acquired {
		defer os.RemoveAll(lockDir)
	}

	if ca, err := loadCA(dir, certPath, keyPath); err == nil {
		m.mu.Lock()
		m.cas[clean] = ca
		m.mu.Unlock()
		return ca, nil
	}

	ca, err := createCAFiles(dir, certPath, keyPath, subject)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.cas[clean] = ca
	m.mu.Unlock()
	return ca, nil
}

// LeafCert returns an in-memory ECDSA P-256 leaf certificate for host, signed by the task CA.
func (m *Manager) LeafCert(ca *TaskCA, host string) (*tls.Certificate, error) {
	name := strings.ToLower(strings.TrimSpace(host))
	name = strings.TrimPrefix(strings.TrimSuffix(name, "]"), "[")
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		return nil, errors.New("invalid certificate host")
	}
	cacheKey := ca.CertPath + "\n" + name

	m.mu.Lock()
	if elem, ok := m.leaves[cacheKey]; ok {
		m.lru.MoveToFront(elem)
		cert := elem.Value.(*leafEntry).cert
		m.mu.Unlock()
		return cert, nil
	}
	m.mu.Unlock()

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().Add(-5 * time.Minute)
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: name,
		},
		NotBefore:             now,
		NotAfter:              now.Add(7 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
	}
	if ip := net.ParseIP(name); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{name}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.Cert, &priv.PublicKey, ca.Key)
	if err != nil {
		return nil, err
	}
	parsedLeaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	tlsCert := &tls.Certificate{
		Certificate: [][]byte{der, ca.Cert.Raw},
		PrivateKey:  priv,
		Leaf:        parsedLeaf,
	}

	m.mu.Lock()
	if elem, ok := m.leaves[cacheKey]; ok {
		m.lru.MoveToFront(elem)
		cert := elem.Value.(*leafEntry).cert
		m.mu.Unlock()
		return cert, nil
	}
	elem := m.lru.PushFront(&leafEntry{key: cacheKey, cert: tlsCert})
	m.leaves[cacheKey] = elem
	for m.lru.Len() > m.maxLeaf {
		back := m.lru.Back()
		if back == nil {
			break
		}
		m.lru.Remove(back)
		delete(m.leaves, back.Value.(*leafEntry).key)
	}
	m.mu.Unlock()
	return tlsCert, nil
}
