package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/Sycun/GongYuAI/services/netd/internal/httpeng"
	"github.com/Sycun/GongYuAI/services/netd/internal/oast"
	"github.com/Sycun/GongYuAI/services/netd/internal/proxy"
	"github.com/Sycun/GongYuAI/services/netd/internal/ring"
	"github.com/Sycun/GongYuAI/services/netd/internal/rpc"
	"github.com/Sycun/GongYuAI/services/netd/internal/store"
	"github.com/Sycun/GongYuAI/services/netd/internal/tlsmitm"
	"github.com/Sycun/GongYuAI/services/netd/internal/tunnel"
)

func main() {
	socketPath := flag.String("socket", "", "Unix domain socket path (required)")
	parentPID := flag.Int("parent-pid", 0, "Optional parent PID to watch; exit when parent dies")
	flag.Parse()

	if *socketPath == "" {
		fmt.Fprintln(os.Stderr, "gy-netd: --socket <path> is required")
		os.Exit(2)
	}

	sockDir := filepath.Dir(*socketPath)
	if err := os.MkdirAll(sockDir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "gy-netd: mkdir %s: %v\n", sockDir, err)
		os.Exit(1)
	}
	_ = os.Chmod(sockDir, 0o700)
	_ = os.Remove(*socketPath)

	ln, err := net.Listen("unix", *socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gy-netd: listen unix %s: %v\n", *socketPath, err)
		os.Exit(1)
	}
	_ = os.Chmod(*socketPath, 0o600)

	tlsMgr := tlsmitm.NewManager(tlsmitm.DefaultLeafMaxCap)
	storeMgr := store.NewStoreManager()
	ringMgr := ring.NewManager(storeMgr)
	proxyMgr := proxy.NewManager(tlsMgr, storeMgr, ringMgr)
	httpEngine := httpeng.NewEngine()
	oastMgr := oast.NewManager()
	tunnelMgr := tunnel.NewManager()

	ctx, cancel := context.WithCancel(context.Background())
	var shutdownOnce sync.Once
	var httpSrv *http.Server

	doShutdown := func() {
		shutdownOnce.Do(func() {
			cancel()
			sctx, scancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer scancel()
			if httpSrv != nil {
				_ = httpSrv.Shutdown(sctx)
			}
			proxyMgr.StopAll()
			oastMgr.StopAll()
			tunnelMgr.StopAll()
			httpEngine.Close()
			storeMgr.CloseAll()
			_ = ln.Close()
			_ = os.Remove(*socketPath)
		})
	}

	rpcSrv := rpc.NewServer(tlsMgr, storeMgr, ringMgr, proxyMgr, httpEngine, oastMgr, tunnelMgr, doShutdown)
	httpSrv = &http.Server{
		Handler:           rpcSrv.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
	}

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case <-sigCh:
			doShutdown()
		case <-ctx.Done():
		}
	}()

	if *parentPID > 1 {
		go func(pid int) {
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if err := syscall.Kill(pid, 0); err != nil {
						doShutdown()
						return
					}
				}
			}
		}(*parentPID)
	}

	if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "gy-netd: serve: %v\n", err)
		doShutdown()
		os.Exit(1)
	}
	doShutdown()
}
