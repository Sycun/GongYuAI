package tunnel

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/store"
)

type StartOptions struct {
	Kind       string `json:"kind"` // "tcp" | "http-connect"
	LocalPort  int    `json:"localPort,omitempty"`
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
	Via        string `json:"via,omitempty"` // http://host:port for http-connect
}

type Info struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	LocalPort  int    `json:"localPort"`
	TargetHost string `json:"targetHost"`
	TargetPort int    `json:"targetPort"`
	Via        string `json:"via,omitempty"`
	Status     string `json:"status"`
	CreatedAt  string `json:"createdAt"`
}

type Instance struct {
	info    Info
	viaHost string
	viaPort string
	ln      net.Listener
	mu      sync.Mutex
	conns   map[net.Conn]struct{}
	closed  bool
}

type Manager struct {
	mu      sync.Mutex
	tunnels map[string]*Instance
}

func NewManager() *Manager {
	return &Manager{tunnels: make(map[string]*Instance)}
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.tunnels)
}

func (m *Manager) Start(opts StartOptions) (*Info, error) {
	kind := strings.ToLower(strings.TrimSpace(opts.Kind))
	if kind != "tcp" && kind != "http-connect" {
		return nil, fmt.Errorf("unsupported tunnel kind %q (expected tcp or http-connect)", opts.Kind)
	}
	targetHost := strings.TrimSpace(opts.TargetHost)
	if targetHost == "" || opts.TargetPort <= 0 || opts.TargetPort > 65535 {
		return nil, errors.New("valid targetHost and targetPort (1-65535) are required")
	}
	var viaHost, viaPort string
	if kind == "http-connect" {
		u, err := url.Parse(strings.TrimSpace(opts.Via))
		if err != nil || u.Scheme != "http" || u.Hostname() == "" {
			return nil, errors.New("http-connect requires via as http://host:port")
		}
		viaHost = u.Hostname()
		viaPort = u.Port()
		if viaPort == "" {
			viaPort = "80"
		}
	}

	// Strictly bind 127.0.0.1 only
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", opts.LocalPort))
	if err != nil {
		return nil, err
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !tcpAddr.IP.Equal(net.ParseIP("127.0.0.1")) {
		_ = ln.Close()
		return nil, errors.New("tunnel listener must bind 127.0.0.1")
	}

	inst := &Instance{
		info: Info{
			ID:         store.NewUUID(),
			Kind:       kind,
			LocalPort:  tcpAddr.Port,
			TargetHost: targetHost,
			TargetPort: opts.TargetPort,
			Via:        opts.Via,
			Status:     "running",
			CreatedAt:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		},
		viaHost: viaHost,
		viaPort: viaPort,
		ln:      ln,
		conns:   make(map[net.Conn]struct{}),
	}

	m.mu.Lock()
	m.tunnels[inst.info.ID] = inst
	m.mu.Unlock()

	go inst.acceptLoop()
	cp := inst.info
	return &cp, nil
}

func (inst *Instance) track(c net.Conn) {
	inst.mu.Lock()
	if !inst.closed {
		inst.conns[c] = struct{}{}
	}
	inst.mu.Unlock()
}

func (inst *Instance) untrack(c net.Conn) {
	inst.mu.Lock()
	delete(inst.conns, c)
	inst.mu.Unlock()
}

func (inst *Instance) acceptLoop() {
	for {
		client, err := inst.ln.Accept()
		if err != nil {
			return
		}
		go inst.handleConn(client)
	}
}

func (inst *Instance) dialUpstream() (net.Conn, *bufio.Reader, error) {
	if inst.info.Kind == "tcp" {
		c, err := net.DialTimeout("tcp", net.JoinHostPort(inst.info.TargetHost, fmt.Sprintf("%d", inst.info.TargetPort)), 15*time.Second)
		return c, nil, err
	}
	up, err := net.DialTimeout("tcp", net.JoinHostPort(inst.viaHost, inst.viaPort), 15*time.Second)
	if err != nil {
		return nil, nil, err
	}
	authority := net.JoinHostPort(inst.info.TargetHost, fmt.Sprintf("%d", inst.info.TargetPort))
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority)
	_ = up.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := io.WriteString(up, req); err != nil {
		_ = up.Close()
		return nil, nil, err
	}
	br := bufio.NewReader(up)
	statusLine, err := br.ReadString('\n')
	if err != nil || !strings.Contains(statusLine, " 200") {
		_ = up.Close()
		return nil, nil, fmt.Errorf("upstream CONNECT rejected: %s", strings.TrimSpace(statusLine))
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			_ = up.Close()
			return nil, nil, err
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	_ = up.SetDeadline(time.Time{})
	return up, br, nil
}

func (inst *Instance) handleConn(client net.Conn) {
	inst.track(client)
	defer func() {
		inst.untrack(client)
		_ = client.Close()
	}()
	up, br, err := inst.dialUpstream()
	if err != nil {
		return
	}
	inst.track(up)
	defer func() {
		inst.untrack(up)
		_ = up.Close()
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(up, client)
		if tc, ok := up.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		if br != nil && br.Buffered() > 0 {
			_, _ = io.Copy(client, br)
		} else {
			_, _ = io.Copy(client, up)
		}
		if tc, ok := client.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	wg.Wait()
}

func (inst *Instance) Close() {
	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return
	}
	inst.closed = true
	inst.info.Status = "closed"
	conns := make([]net.Conn, 0, len(inst.conns))
	for c := range inst.conns {
		conns = append(conns, c)
	}
	inst.conns = make(map[net.Conn]struct{})
	inst.mu.Unlock()

	_ = inst.ln.Close()
	for _, c := range conns {
		_ = c.Close()
	}
}

func (m *Manager) Stop(id string) bool {
	m.mu.Lock()
	inst, ok := m.tunnels[id]
	delete(m.tunnels, id)
	m.mu.Unlock()
	if ok {
		inst.Close()
	}
	return ok
}

func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.tunnels))
	for _, t := range m.tunnels {
		out = append(out, t.info)
	}
	return out
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	all := make([]*Instance, 0, len(m.tunnels))
	for _, t := range m.tunnels {
		all = append(all, t)
	}
	m.tunnels = make(map[string]*Instance)
	m.mu.Unlock()
	for _, t := range all {
		t.Close()
	}
}
