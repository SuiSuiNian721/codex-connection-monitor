package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestParseSystemProxyPrefersLocalHTTPS(t *testing.T) {
	settings := "<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7890\n  HTTPSEnable : 1\n  HTTPSProxy : localhost\n  HTTPSPort : 7891\n}\n"
	if got := parseSystemProxy(settings); got != "http://localhost:7891" {
		t.Fatalf("proxy = %q", got)
	}
}

func TestParseSystemProxyRejectsRemoteAndInvalidPort(t *testing.T) {
	for _, settings := range []string{
		"HTTPEnable : 1\nHTTPProxy : example.com\nHTTPPort : 7890",
		"HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 0",
		"HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 65536",
	} {
		if got := parseSystemProxy(settings); got != "" {
			t.Fatalf("expected no proxy, got %q", got)
		}
	}
}

func TestConnectionMustReachConfiguredLocalProxy(t *testing.T) {
	proxy := "http://127.0.0.1:7890"
	local := "Codex 123 user 14u IPv4 TCP 127.0.0.1:50000->127.0.0.1:7890 (ESTABLISHED)"
	remote := "Codex 123 user 14u IPv4 TCP 127.0.0.1:50000->198.51.100.10:7890 (ESTABLISHED)"
	if !proxyConnectionIn(local, proxy) {
		t.Fatal("configured local proxy connection was not detected")
	}
	if proxyConnectionIn(remote, proxy) {
		t.Fatal("remote connection with the same port was mistaken for the proxy")
	}
}

func TestLocalhostConnectionAcceptsIPv6AndRejectsOtherPorts(t *testing.T) {
	output := "Codex 123 user 14u IPv6 TCP [::1]:50000->[::1]:7890 (ESTABLISHED)"
	if !proxyConnectionIn(output, "http://localhost:7890") {
		t.Fatal("localhost IPv6 connection was not detected")
	}
	if proxyConnectionIn(output, "http://localhost:7891") {
		t.Fatal("a different proxy port was accepted")
	}
}

func TestProxyHTTPResponseIsHealthyWithoutFollowingRedirect(t *testing.T) {
	var requests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		if request.URL.Host == "probe.invalid" {
			writer.Header().Set("Location", "http://127.0.0.1:1/unreachable")
			writer.WriteHeader(http.StatusFound)
			return
		}
		// 模拟代理访问重定向目标失败：原 302 已证明代理可用，此处不应再请求。
		connection, _, err := writer.(http.Hijacker).Hijack()
		if err == nil {
			_ = connection.Close()
		}
	}))
	defer proxy.Close()
	if !probeProxyAt(proxy.URL, "http://probe.invalid/favicon.ico") {
		t.Fatal("proxy delivered HTTP 302 but was marked unavailable after redirect")
	}
	if count := requests.Load(); count != 1 {
		t.Fatalf("proxy probe followed a redirect: %d requests", count)
	}
}

func TestWatchSourceDoesNotCloseOrRestartCodex(t *testing.T) {
	source, err := os.ReadFile("watcher.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"gracefulRestart", "restartChoice", " to quit", `"/bin/sh"`, "重启 Codex"} {
		if strings.Contains(string(source), forbidden) {
			t.Fatalf("watcher still contains application restart/quit logic: %q", forbidden)
		}
	}
}
