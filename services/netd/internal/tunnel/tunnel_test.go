package tunnel_test

import (
	"bufio"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/tunnel"
)

func TestValidationAndTCPForwarding(t *testing.T) {
	mgr := tunnel.NewManager()
	defer mgr.StopAll()

	if _, err := mgr.Start(tunnel.StartOptions{Kind: "socks5", TargetHost: "127.0.0.1", TargetPort: 80}); err == nil {
		t.Fatal("expected unsupported kind error")
	}
	if _, err := mgr.Start(tunnel.StartOptions{Kind: "tcp", TargetHost: "", TargetPort: 80}); err == nil {
		t.Fatal("expected empty targetHost error")
	}
	if _, err := mgr.Start(tunnel.StartOptions{Kind: "tcp", TargetHost: "127.0.0.1", TargetPort: 70000}); err == nil {
		t.Fatal("expected invalid targetPort error")
	}
	if _, err := mgr.Start(tunnel.StartOptions{Kind: "http-connect", TargetHost: "127.0.0.1", TargetPort: 80, Via: "socks5://127.0.0.1:1080"}); err == nil {
		t.Fatal("expected non-http via error")
	}

	// Upstream echo TCP server
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoLn.Close()
	go func() {
		for {
			c, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(c)
		}
	}()

	echoPort := echoLn.Addr().(*net.TCPAddr).Port
	info, err := mgr.Start(tunnel.StartOptions{
		Kind:       "tcp",
		TargetHost: "127.0.0.1",
		TargetPort: echoPort,
	})
	if err != nil || info.LocalPort <= 0 || mgr.Count() != 1 || len(mgr.List()) != 1 {
		t.Fatalf("unexpected TCP tunnel start: info=%+v count=%d err=%v", info, mgr.Count(), err)
	}

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(info.LocalPort)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "ping-through-tcp-tunnel\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "ping-through-tcp-tunnel\n" {
		t.Fatalf("unexpected echo response: %q err=%v", line, err)
	}

	if !mgr.Stop(info.ID) || mgr.Stop(info.ID) || mgr.Count() != 0 {
		t.Fatal("Stop should return true once and clear manager state")
	}
}

func TestHTTPConnectTunnel(t *testing.T) {
	mgr := tunnel.NewManager()
	defer mgr.StopAll()

	// Target server
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetLn.Close()
	go func() {
		for {
			c, err := targetLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				br := bufio.NewReader(conn)
				msg, _ := br.ReadString('\n')
				_, _ = io.WriteString(conn, "CONNECTED:"+msg)
			}(c)
		}
	}()
	targetPort := targetLn.Addr().(*net.TCPAddr).Port

	// Minimal HTTP CONNECT proxy supporting allow + reject
	proxyLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer proxyLn.Close()
	go func() {
		for {
			client, err := proxyLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				reqLine, err := br.ReadString('\n')
				if err != nil {
					return
				}
				for {
					h, err := br.ReadString('\n')
					if err != nil || h == "\r\n" || h == "\n" {
						break
					}
				}
				parts := strings.Fields(reqLine)
				if len(parts) < 2 || parts[0] != "CONNECT" || strings.HasSuffix(parts[1], ":1") {
					_, _ = io.WriteString(c, "HTTP/1.1 403 Forbidden\r\n\r\n")
					return
				}
				up, err := net.DialTimeout("tcp", parts[1], 3*time.Second)
				if err != nil {
					_, _ = io.WriteString(c, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
					return
				}
				defer up.Close()
				_, _ = io.WriteString(c, "HTTP/1.1 200 Connection Established\r\nX-Proxy: test\r\n\r\n")
				go func() { _, _ = io.Copy(up, br) }()
				_, _ = io.Copy(c, up)
			}(client)
		}
	}()
	proxyPort := proxyLn.Addr().(*net.TCPAddr).Port

	tun, err := mgr.Start(tunnel.StartOptions{
		Kind:       "http-connect",
		TargetHost: "127.0.0.1",
		TargetPort: targetPort,
		Via:        "http://127.0.0.1:" + itoa(proxyPort),
	})
	if err != nil {
		t.Fatal(err)
	}
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+itoa(tun.LocalPort), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = io.WriteString(c, "pivot-hello\n")
	reply, err := bufio.NewReader(c).ReadString('\n')
	if err != nil || reply != "CONNECTED:pivot-hello\n" {
		t.Fatalf("unexpected http-connect reply: %q err=%v", reply, err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
