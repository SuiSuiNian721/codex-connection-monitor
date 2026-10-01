package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestVPNProbeHTTPResponsesAreNotNodeFailures(t *testing.T) {
	for _, item := range []struct {
		code    int
		kind    string
		healthy bool
	}{{200, "HttpResponse", true}, {403, "HttpRestricted", true}, {429, "RateLimited", true}, {503, "ServerError", true}, {407, "ProxyAuthenticationRequired", false}} {
		t.Run(item.kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(item.code) }))
			defer server.Close()
			probe := probeProxyStatusAt(server.URL, "http://example.invalid/probe")
			if probe.Reachable != item.healthy || probe.Kind != item.kind || !probe.LocalHealthy {
				t.Fatalf("unexpected classification: %+v", probe)
			}
		})
	}
}

func TestVPNProbeTunnelRejectDoesNotSwitch(t *testing.T) {
	for _, item := range []struct {
		code int
		kind string
	}{{403, "ProxyHttpRestricted"}, {407, "ProxyAuthenticationRequired"}, {429, "ProxyRateLimited"}, {503, "ProxyServerError"}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(item.code) }))
		probe := probeProxyStatusAt(server.URL, "https://example.invalid/probe")
		server.Close()
		if probe.Reachable || !probe.LocalHealthy || probe.Kind != item.kind {
			t.Fatalf("CONNECT %d: %+v", item.code, probe)
		}
	}
}

func TestVPNProbeConnectionEOFIsHardFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for i := 0; i < 2; i++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_ = connection.Close()
		}
	}()
	probe := probeProxyStatusAt("http://"+listener.Addr().String(), "https://example.invalid/probe")
	if !probe.LocalHealthy || probe.Reachable || probe.Kind != "ConnectionFailure" {
		t.Fatalf("closed CONNECT: %+v", probe)
	}
}

func TestVPNWatchEligibility(t *testing.T) {
	now := time.Date(2026, 10, 1, 22, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	if !shouldAssistVPN(now, time.Time{}, now.Add(-180*time.Second), true, proxy, proxy, "Timeout", true) {
		t.Fatal("long transport outage should permit assistance")
	}
	for _, kind := range []string{"HttpResponse", "HttpRestricted", "RateLimited", "ServerError", "ProxyAuthenticationRequired", "RequestFailure", "NotProbed"} {
		if shouldAssistVPN(now, time.Time{}, now.Add(-180*time.Second), true, proxy, proxy, kind, true) {
			t.Fatalf("must not assist on %s", kind)
		}
	}
	for _, seconds := range []time.Duration{0, 30, 179} {
		if shouldAssistVPN(now, time.Time{}, now.Add(-seconds*time.Second), true, proxy, proxy, "Timeout", true) {
			t.Fatal("brief outage must not trigger")
		}
	}
	if shouldAssistVPN(now, now.Add(-599*time.Second), now.Add(-180*time.Second), true, proxy, proxy, "Timeout", true) {
		t.Fatal("cooldown must suppress repeated assistance")
	}
	if !shouldAssistVPN(now, now.Add(-600*time.Second), now.Add(-180*time.Second), true, proxy, proxy, "Timeout", true) {
		t.Fatal("cooldown boundary")
	}
	if shouldAssistVPN(now, time.Time{}, now.Add(-180*time.Second), true, proxy, proxy, "Timeout", false) {
		t.Fatal("closed local proxy cannot be repaired by node selection")
	}
	if shouldAssistVPN(now, time.Time{}, now.Add(-180*time.Second), true, "http://127.0.0.1:9674", proxy, "Timeout", true) {
		t.Fatal("do not modify proxy that Codex has not adopted")
	}
	if shouldAssistVPN(now, time.Time{}, time.Time{}, true, proxy, proxy, "Timeout", true) {
		t.Fatal("unknown failure origin")
	}
	if shouldAssistVPN(now, time.Time{}, now.Add(-180*time.Second), false, proxy, proxy, "Timeout", true) {
		t.Fatal("not in long outage")
	}
}

func TestVPNHardFailureClockResetsAfterResponse(t *testing.T) {
	now := time.Date(2026, 10, 1, 22, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	since := observeVPNHardFailure(time.Time{}, now, "Timeout", true, proxy, proxy)
	if since != now {
		t.Fatal("failure origin")
	}
	for _, kind := range []string{"HttpResponse", "HttpRestricted", "RateLimited", "ServerError", "ProxyAuthenticationRequired", "RequestFailure"} {
		if !observeVPNHardFailure(since, now.Add(200*time.Second), kind, true, proxy, proxy).IsZero() {
			t.Fatalf("%s must reset continuous hard failure", kind)
		}
	}
	later := now.Add(600 * time.Second)
	newSince := observeVPNHardFailure(time.Time{}, later, "Timeout", true, proxy, proxy)
	if shouldAssistVPN(later.Add(179*time.Second), time.Time{}, newSince, true, proxy, proxy, "Timeout", true) {
		t.Fatal("do not reuse natural-reconnection state's previous failure origin")
	}
	if observeVPNHardFailure(since, later, "Timeout", true, "http://127.0.0.1:9674", proxy) != later {
		t.Fatal("proxy change resets origin")
	}
}
