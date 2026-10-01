package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func vpnBool(value bool) *bool { return &value }

func vpnSafeSnapshot() vpnSnapshot {
	return vpnSnapshot{
		Config: vpnConfig{Port: 7890, Mode: "rule"},
		Rules: []vpnRule{
			{Type: "DomainSuffix", Payload: "chatgpt.com", Proxy: "AI-private"},
			{Type: "DomainSuffix", Payload: "openai.com", Proxy: "AI-private"},
			{Type: "DomainSuffix", Payload: "oaistatic.com", Proxy: "AI-private"},
			{Type: "DomainSuffix", Payload: "oaiusercontent.com", Proxy: "AI-private"},
			{Type: "Match", Proxy: "default"},
		},
		Proxies: map[string]vpnProxy{
			"AI-private": {Type: "Selector", Now: "node-a", All: []string{"node-a", "automatic", "speed"}},
			"automatic":  {Type: "Fallback", Now: "node-a", All: []string{"node-a", "node-b"}, Fixed: vpnBool(false)},
			"speed":      {Type: "URLTest", Now: "node-b", All: []string{"node-a", "node-b"}, Fixed: vpnBool(false)},
			"node-a":     {Type: "Shadowsocks", Alive: vpnBool(true)},
			"node-b":     {Type: "Shadowsocks", History: []vpnDelay{{Delay: 30}}},
			"default":    {Type: "Selector", Now: "node-a", All: []string{"node-a", "node-b"}},
		},
	}
}

type vpnControllerFixture struct {
	t                *testing.T
	server           *httptest.Server
	snapshot         vpnSnapshot
	puts             int
	gets             map[string]int
	selected         string
	failPath         string
	failStatus       int
	beforeRecheck    func(*vpnSnapshot)
	disagreeAfterPut bool
	secret           string
	stringFixedWire  bool
	afterPut         func()
}

func newVPNController(t *testing.T) *vpnControllerFixture {
	f := &vpnControllerFixture{t: t, snapshot: vpnSafeSnapshot(), gets: map[string]int{}, secret: "PRIVATE-CONTROLLER-SECRET"}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}

func (f *vpnControllerFixture) endpoint() vpnEndpoint {
	return vpnEndpoint{Client: "Mihomo", Address: f.server.URL, Secret: f.secret}
}

func (f *vpnControllerFixture) deps() vpnAssistDeps {
	return vpnAssistDeps{
		Discover: func(string) ([]vpnEndpoint, error) { return []vpnEndpoint{f.endpoint()}, nil },
		HTTP: func(endpoint vpnEndpoint) (*http.Client, string, error) {
			return f.server.Client(), endpoint.Address, nil
		},
		Connect: func(context.Context, string) error { return nil },
	}
}

func (f *vpnControllerFixture) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+f.secret {
		f.t.Errorf("controller authentication was not supplied")
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodGet {
		f.gets[r.URL.Path]++
	}
	if r.URL.Path == f.failPath {
		if f.failStatus < 0 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		w.WriteHeader(f.failStatus)
		_, _ = w.Write([]byte("PRIVATE-NODE PRIVATE-SERVER " + f.secret))
		return
	}
	if r.Method == http.MethodPut && r.URL.Path == "/proxies/AI-private" {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || body["name"] == "" {
			f.t.Error("invalid selection body")
		}
		f.puts++
		f.selected = body["name"]
		p := f.snapshot.Proxies["AI-private"]
		p.Now = body["name"]
		if f.disagreeAfterPut {
			p.Now = "node-b"
		}
		f.snapshot.Proxies["AI-private"] = p
		if f.afterPut != nil {
			f.afterPut()
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		f.t.Errorf("unexpected mutation: %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/version":
		_ = json.NewEncoder(w).Encode(map[string]any{"version": "v1.19.16", "meta": true})
	case "/configs":
		_ = json.NewEncoder(w).Encode(f.snapshot.Config)
	case "/rules":
		if f.gets[r.URL.Path] == 2 && f.beforeRecheck != nil {
			f.beforeRecheck(&f.snapshot)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"rules": f.snapshot.Rules})
	case "/proxies":
		if f.stringFixedWire {
			encoded, _ := json.Marshal(f.snapshot.Proxies)
			var proxies map[string]map[string]any
			_ = json.Unmarshal(encoded, &proxies)
			for name, proxy := range f.snapshot.Proxies {
				if proxy.Fixed == nil {
					delete(proxies[name], "fixed")
					continue
				}
				proxies[name]["fixed"] = ""
				if *proxy.Fixed {
					proxies[name]["fixed"] = "PRIVATE-MANUAL-NODE"
					if proxy.FixedChoice != "" {
						proxies[name]["fixed"] = proxy.FixedChoice
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"proxies": proxies})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]any{"proxies": f.snapshot.Proxies})
		}
	default:
		f.t.Errorf("unexpected controller request: %s", r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func TestVPNAssistRootAlreadyExitedStopsBeforeReadingOrWriting(t *testing.T) {
	f := newVPNController(t)
	deps := f.deps()
	calls := 0
	deps.Connect = func(context.Context, string) error { calls++; return nil }
	deps.Alive = func() bool { return false }
	if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", deps); got.Status != "RootExited" || got.Action != "None" || calls != 0 || f.puts != 0 {
		t.Fatalf("result=%+v calls=%d puts=%d", got, calls, f.puts)
	}
}

func TestVPNAssistRootExitDuringReadStopsBeforeSelection(t *testing.T) {
	f := newVPNController(t)
	deps := f.deps()
	var alive atomic.Bool
	alive.Store(true)
	deps.Alive = alive.Load
	f.beforeRecheck = func(*vpnSnapshot) { alive.Store(false) }
	if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", deps); got.Status != "RootExited" || got.Action != "None" || f.puts != 0 {
		t.Fatalf("result=%+v puts=%d", got, f.puts)
	}
}

type vpnRoundTripFunc func(*http.Request) (*http.Response, error)

func (trip vpnRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return trip(request)
}

func TestVPNAssistRootExitCancelsPendingControllerRead(t *testing.T) {
	f := newVPNController(t)
	deps := f.deps()
	var alive atomic.Bool
	alive.Store(true)
	deps.Alive = alive.Load
	deps.HTTP = func(endpoint vpnEndpoint) (*http.Client, string, error) {
		return &http.Client{Transport: vpnRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			alive.Store(false)
			<-request.Context().Done()
			return nil, request.Context().Err()
		})}, endpoint.Address, nil
	}
	started := time.Now()
	got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", deps)
	if got.Status != "RootExited" || got.Action != "None" || time.Since(started) > time.Second || f.puts != 0 {
		t.Fatalf("result=%+v elapsed=%s puts=%d", got, time.Since(started), f.puts)
	}
}

func TestVPNAssistRootExitAfterPutPreservesAttemptedAction(t *testing.T) {
	f := newVPNController(t)
	deps := f.deps()
	var alive atomic.Bool
	alive.Store(true)
	deps.Alive = alive.Load
	f.afterPut = func() { alive.Store(false) }
	if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", deps); got.Status != "RootExited" || got.Action != "SelectAutomatic" || f.puts != 1 {
		t.Fatalf("result=%+v puts=%d", got, f.puts)
	}
}

func TestVPNProxyDecodesRealMihomoFixedAndLegacyBoolean(t *testing.T) {
	for _, tc := range []struct {
		wire    string
		want    *bool
		invalid bool
	}{
		{wire: `{"type":"URLTest","fixed":""}`, want: vpnBool(false)},
		{wire: `{"type":"Fallback","fixed":"PRIVATE-MANUAL-NODE"}`, want: vpnBool(true)},
		{wire: `{"type":"Fallback","fixed":false}`, want: vpnBool(false)},
		{wire: `{"type":"URLTest","fixed":true}`, want: vpnBool(true)},
		{wire: `{"type":"Fallback"}`},
		{wire: `{"type":"Fallback","fixed":null}`},
		{wire: `{"type":"Fallback","fixed":1}`, invalid: true},
		{wire: `{"type":"Fallback","fixed":{}}`, invalid: true},
	} {
		var proxy vpnProxy
		err := json.Unmarshal([]byte(tc.wire), &proxy)
		if tc.invalid {
			if err == nil {
				t.Fatalf("invalid fixed accepted: %s", tc.wire)
			}
			continue
		}
		if err != nil || (tc.want == nil) != (proxy.Fixed == nil) || (tc.want != nil && *proxy.Fixed != *tc.want) {
			t.Fatalf("proxy=%+v error=%v for %s", proxy, err, tc.wire)
		}
	}
}

func TestVPNAssistRealMihomoFixedWireFormat(t *testing.T) {
	for _, tc := range []struct {
		name, want    string
		native, fixed bool
		puts          int
	}{
		{name: "select existing automatic", want: "SelectedAutomatic", puts: 1},
		{name: "already automatic", want: "NativeAutomatic", native: true},
		{name: "manual pin", want: "ManualOverride", native: true, fixed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVPNController(t)
			f.stringFixedWire = true
			if tc.native {
				p := f.snapshot.Proxies["AI-private"]
				p.Now = "automatic"
				f.snapshot.Proxies["AI-private"] = p
			}
			if tc.fixed {
				p := f.snapshot.Proxies["automatic"]
				p.Fixed = vpnBool(true)
				f.snapshot.Proxies["automatic"] = p
			}
			if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps()); got.Status != tc.want || f.puts != tc.puts {
				t.Fatalf("result=%+v puts=%d", got, f.puts)
			}
		})
	}
}

func TestVPNAssistPerformsOneSelectionAndVerifies(t *testing.T) {
	f := newVPNController(t)
	got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps())
	if got.Status != "SelectedAutomatic" || got.Action != "SelectAutomatic" || got.Client != "Mihomo" || f.puts != 1 || f.selected != "automatic" {
		t.Fatalf("result=%+v puts=%d target=%q", got, f.puts, f.selected)
	}
	if f.gets["/rules"] < 2 || f.gets["/proxies"] < 3 {
		t.Fatalf("missing before/after readback: %v", f.gets)
	}
	encoded, _ := json.Marshal(got)
	for _, private := range []string{"AI-private", "node-a", "node-b", "automatic", "PRIVATE", f.secret} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("private controller detail leaked into output: %s", encoded)
		}
	}
}

func TestVPNAssistDoesNotTouchControllersForInvalidProbeOrProxy(t *testing.T) {
	for _, tc := range []struct{ proxy, kind, want string }{
		{"http://127.0.0.1:7890", "HttpResponse", "BlockedProbe"},
		{"http://127.0.0.1:7890", "ProxyAuthenticationRequired", "BlockedProbe"},
		{"http://127.0.0.1:7890", "403", "BlockedProbe"},
		{"http://127.0.0.1:7890", "429", "BlockedProbe"},
		{"http://127.0.0.1:7890", "503", "BlockedProbe"},
		{"http://127.0.0.1:7890", "ProxyTunnelFailure", "BlockedProbe"},
		{"http://127.0.0.1:7890", "ProxyTunnelRejected", "BlockedProbe"},
		{"http://127.0.0.1:7890", "ProxyHttpRestricted", "BlockedProbe"},
		{"http://127.0.0.1:7890", "ProxyRateLimited", "BlockedProbe"},
		{"http://127.0.0.1:7890", "ProxyServerError", "BlockedProbe"},
		{"http://127.0.0.1:7890", "", "BlockedProbe"},
		{"http://remote.example:7890", "Timeout", "InvalidProxy"},
		{"socks5://127.0.0.1:7890", "Timeout", "InvalidProxy"},
		{"https://127.0.0.1:7890", "Timeout", "InvalidProxy"},
		{"http://user:secret@127.0.0.1:7890", "Timeout", "InvalidProxy"},
		{"http://127.0.0.1:7890/opaque", "Timeout", "InvalidProxy"},
		{"http://127.0.0.1:7890/?token=private", "Timeout", "InvalidProxy"},
		{"http://127.0.0.1:0", "Timeout", "InvalidProxy"},
		{"http://127.0.0.1", "Timeout", "InvalidProxy"},
	} {
		t.Run(tc.proxy+tc.kind, func(t *testing.T) {
			calls := 0
			deps := vpnAssistDeps{Discover: func(string) ([]vpnEndpoint, error) { calls++; return nil, nil }, Connect: func(context.Context, string) error { calls++; return nil }}
			if got := assistVPNWithDeps(tc.proxy, tc.kind, deps); got.Status != tc.want || got.Action != "None" || calls != 0 {
				t.Fatalf("result=%+v calls=%d", got, calls)
			}
		})
	}
}

func TestVPNAssistClosedLocalPortStopsBeforeDiscovery(t *testing.T) {
	calls := 0
	deps := vpnAssistDeps{Discover: func(string) ([]vpnEndpoint, error) { calls++; return nil, nil }, Connect: func(context.Context, string) error { return errors.New("PRIVATE-CONNECTION-ERROR") }}
	got := assistVPNWithDeps("http://127.0.0.1:7890", "ConnectionFailure", deps)
	if got.Status != "LocalProxyUnavailable" || got.Action != "None" || calls != 0 || strings.Contains(got.Message, "PRIVATE") {
		t.Fatalf("result=%+v calls=%d", got, calls)
	}
}

func TestVPNAssistNativeAutomaticAndManualCasesNeverWrite(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		edit       func(*vpnSnapshot)
	}{
		{"native", "NativeAutomatic", func(s *vpnSnapshot) { p := s.Proxies["AI-private"]; p.Now = "automatic"; s.Proxies["AI-private"] = p }},
		{"fixed", "ManualOverride", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.Now = "automatic"
			s.Proxies["AI-private"] = p
			p = s.Proxies["automatic"]
			p.Fixed = vpnBool(true)
			s.Proxies["automatic"] = p
		}},
		{"manual", "ManualOnly", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.All = []string{"node-a", "node-b"}
			s.Proxies["AI-private"] = p
		}},
		{"shared", "UnsafeSharedPolicy", func(s *vpnSnapshot) { s.Rules = append(s.Rules, vpnRule{Type: "Match", Proxy: "AI-private"}) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVPNController(t)
			tc.edit(&f.snapshot)
			if got := assistVPNWithDeps("http://127.0.0.1:7890", "TlsFailure", f.deps()); got.Status != tc.want || got.Action != "None" || f.puts != 0 {
				t.Fatalf("result=%+v puts=%d", got, f.puts)
			}
		})
	}
}

func TestVPNAssistControllerHTTPFailureDoesNotLeakOrWrite(t *testing.T) {
	for _, path := range []string{"/version", "/configs", "/rules", "/proxies"} {
		for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests, http.StatusServiceUnavailable, -1} {
			t.Run(path+http.StatusText(status), func(t *testing.T) {
				f := newVPNController(t)
				f.failPath, f.failStatus = path, status
				got := assistVPNWithDeps("http://127.0.0.1:7890", "ResponseFailure", f.deps())
				if got.Status != "ControllerUnavailable" || got.Action != "None" || f.puts != 0 || strings.Contains(got.Message, "PRIVATE") {
					t.Fatalf("result=%+v puts=%d", got, f.puts)
				}
			})
		}
	}
}

func TestVPNAssistProxyPortMustMatchRuntimeConfig(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config vpnConfig
		want   string
	}{
		{"unmatched", vpnConfig{Port: 7900, Mode: "rule"}, "PortMismatch"},
		{"mixed kebab", vpnConfig{MixedPort: 7890, Mode: "rule"}, "SelectedAutomatic"},
		{"mixed camel", vpnConfig{MixedPortCamel: 7890, Mode: "rule"}, "SelectedAutomatic"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVPNController(t)
			f.snapshot.Config = tc.config
			got := assistVPNWithDeps("http://127.0.0.1:7890", "ConnectionFailure", f.deps())
			if got.Status != tc.want || (tc.want == "PortMismatch" && f.puts != 0) {
				t.Fatalf("result=%+v puts=%d", got, f.puts)
			}
		})
	}
}

func TestVPNAssistRejectsMultipleMatchingControllers(t *testing.T) {
	f, second := newVPNController(t), newVPNController(t)
	deps := f.deps()
	deps.Discover = func(string) ([]vpnEndpoint, error) { return []vpnEndpoint{f.endpoint(), second.endpoint()}, nil }
	got := assistVPNWithDeps("http://127.0.0.1:7890", "NameResolutionFailure", deps)
	if got.Status != "AmbiguousController" || got.Action != "None" || f.puts+second.puts != 0 {
		t.Fatalf("result=%+v puts=%d", got, f.puts+second.puts)
	}
}

func TestVPNAssistRecheckPreventsOverwritingConcurrentChoice(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*vpnSnapshot)
	}{
		{"user changed selection", func(s *vpnSnapshot) { p := s.Proxies["AI-private"]; p.Now = "node-b"; s.Proxies["AI-private"] = p }},
		{"rule changed", func(s *vpnSnapshot) {
			s.Rules = append(s.Rules, vpnRule{Type: "DomainSuffix", Payload: "example.com", Proxy: "AI-private"})
		}},
		{"candidate fixed", func(s *vpnSnapshot) { p := s.Proxies["automatic"]; p.Fixed = vpnBool(true); s.Proxies["automatic"] = p }},
		{"mode changed", func(s *vpnSnapshot) { s.Config.Mode = "global" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVPNController(t)
			f.beforeRecheck = tc.edit
			got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps())
			if got.Status != "ChangedDuringCheck" || got.Action != "None" || f.puts != 0 {
				t.Fatalf("result=%+v puts=%d", got, f.puts)
			}
		})
	}
}

func TestVPNAssistRecheckDetectsStructuralChangesEvenWhenAnalysisStaysReady(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*vpnSnapshot)
	}{
		{"unrelated rule added", func(s *vpnSnapshot) {
			s.Rules = append(s.Rules, vpnRule{Type: "Domain", Payload: "example.org", Proxy: "default"})
		}},
		{"inactive group current changed", func(s *vpnSnapshot) { p := s.Proxies["default"]; p.Now = "node-b"; s.Proxies["default"] = p }},
		{"fallback member order changed", func(s *vpnSnapshot) {
			p := s.Proxies["automatic"]
			p.All = []string{"node-b", "node-a"}
			s.Proxies["automatic"] = p
		}},
		{"inactive proxy type changed", func(s *vpnSnapshot) { p := s.Proxies["node-b"]; p.Type = "Trojan"; s.Proxies["node-b"] = p }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVPNController(t)
			f.beforeRecheck = tc.edit
			before := analyzeVPNSnapshot(f.snapshot)
			edited := vpnSafeSnapshot()
			tc.edit(&edited)
			if after := analyzeVPNSnapshot(edited); after != before {
				t.Fatalf("fixture must preserve Ready summary: before=%+v after=%+v", before, after)
			}
			got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps())
			if got.Status != "ChangedDuringCheck" || got.Action != "None" || f.puts != 0 {
				t.Fatalf("result=%+v puts=%d", got, f.puts)
			}
		})
	}
}

func TestVPNAssistRecheckIgnoresPureHealthHistoryChanges(t *testing.T) {
	f := newVPNController(t)
	f.beforeRecheck = func(s *vpnSnapshot) {
		p := s.Proxies["node-a"]
		p.History = append(p.History, vpnDelay{Delay: 80})
		p.Alive = vpnBool(false)
		s.Proxies["node-a"] = p
		p = s.Proxies["node-b"]
		p.History = append(p.History, vpnDelay{Delay: 32})
		s.Proxies["node-b"] = p
	}
	if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps()); got.Status != "SelectedAutomatic" || f.puts != 1 {
		t.Fatalf("result=%+v puts=%d", got, f.puts)
	}
}

func TestVPNAssistRecheckDetectsInactiveFixedNodeChange(t *testing.T) {
	f := newVPNController(t)
	f.stringFixedWire = true
	f.snapshot.Proxies["other"] = vpnProxy{Type: "URLTest", Now: "node-a", All: []string{"node-a", "node-b"}, Fixed: vpnBool(true), FixedChoice: "PRIVATE-PIN-A"}
	f.beforeRecheck = func(s *vpnSnapshot) { p := s.Proxies["other"]; p.FixedChoice = "PRIVATE-PIN-B"; s.Proxies["other"] = p }
	if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps()); got.Status != "ChangedDuringCheck" || f.puts != 0 {
		t.Fatalf("result=%+v puts=%d", got, f.puts)
	}
}

func TestVPNAnalysisRejectsEarlierExplicitOpenAISubdomainSplit(t *testing.T) {
	for _, domain := range []string{"api.openai.com", "chat.chatgpt.com", "auth.openai.com"} {
		t.Run(domain, func(t *testing.T) {
			s := vpnSafeSnapshot()
			s.Rules = append([]vpnRule{{Type: "Domain", Payload: domain, Proxy: "default"}}, s.Rules...)
			if got := analyzeVPNSnapshot(s); got.Status != "UnknownRoute" {
				t.Fatalf("split subdomain analysis = %+v", got)
			}
			f := newVPNController(t)
			f.snapshot = s
			if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps()); got.Status != "UnknownRoute" || f.puts != 0 {
				t.Fatalf("result=%+v puts=%d", got, f.puts)
			}
		})
	}
}

func TestVPNAnalysisIgnoresLaterUnreachableSubdomainRule(t *testing.T) {
	s := vpnSafeSnapshot()
	s.Rules = append(s.Rules, vpnRule{Type: "Domain", Payload: "api.openai.com", Proxy: "default"})
	if got := analyzeVPNSnapshot(s); got.Status != "Ready" {
		t.Fatalf("later unreachable exact rule must not override first suffix: %+v", got)
	}
}

func TestVPNAnalysisExactRootsDoNotProveOpenAISubdomainCoverage(t *testing.T) {
	for _, native := range []bool{false, true} {
		s := vpnSafeSnapshot()
		for i := range s.Rules[:4] {
			s.Rules[i].Type = "Domain"
		}
		if native {
			p := s.Proxies["AI-private"]
			p.Now = "automatic"
			s.Proxies["AI-private"] = p
		}
		if got := analyzeVPNSnapshot(s); got.Status != "UnknownRoute" {
			t.Fatalf("exact roots do not cover api/auth/chat subdomains: %+v", got)
		}
		f := newVPNController(t)
		f.snapshot = s
		if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps()); got.Status != "UnknownRoute" || got.Action != "None" || f.puts != 0 {
			t.Fatalf("result=%+v puts=%d", got, f.puts)
		}
	}
}

func TestVPNResultProtocolUsesFixedSafeValues(t *testing.T) {
	for internal, external := range map[string]string{
		"NotApplicable": "BlockedProbe", "UnsupportedProxy": "InvalidProxy", "UnknownController": "NoController",
		"SharedSelector": "UnsafeSharedPolicy", "FixedSelection": "ManualOverride", "ConcurrentChange": "ChangedDuringCheck",
	} {
		result := vpnResult(internal, "None", "PRIVATE-client-label")
		if result.Status != external || result.Client != "" || len([]rune(result.Message)) > 100 {
			t.Fatalf("unsafe or incompatible result: %+v", result)
		}
	}
}

func TestVPNAssistDoesNotRollbackUnverifiedSelection(t *testing.T) {
	f := newVPNController(t)
	f.disagreeAfterPut = true
	got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", f.deps())
	if got.Status != "SelectionUnverified" || got.Action != "SelectAutomatic" || f.puts != 1 {
		t.Fatalf("result=%+v puts=%d", got, f.puts)
	}
}

func TestVPNAssistHasOverallDeadline(t *testing.T) {
	f := newVPNController(t)
	deps := f.deps()
	deps.Connect = func(ctx context.Context, address string) error {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 20*time.Second || time.Until(deadline) < 15*time.Second {
			t.Fatal("missing bounded overall deadline")
		}
		return nil
	}
	if got := assistVPNWithDeps("http://127.0.0.1:7890", "Timeout", deps); got.Status != "SelectedAutomatic" {
		t.Fatalf("result=%+v", got)
	}
}

func TestVPNAnalysisSelectsExistingFallbackForPrivateOpenAIGroup(t *testing.T) {
	got := analyzeVPNSnapshot(vpnSafeSnapshot())
	if got.Status != "Ready" || got.Selector != "AI-private" || got.Current != "node-a" || got.Target != "automatic" {
		t.Fatalf("analysis = %+v, want safe existing fallback", got)
	}
}

func TestVPNAnalysisConservativeBoundaries(t *testing.T) {
	tests := []struct {
		name string
		edit func(*vpnSnapshot)
		want string
	}{
		{"current fallback", func(s *vpnSnapshot) { p := s.Proxies["AI-private"]; p.Now = "automatic"; s.Proxies["AI-private"] = p }, "NativeAutomatic"},
		{"nested current automatic", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.Now = "nested"
			p.All = append(p.All, "nested")
			s.Proxies["AI-private"] = p
			s.Proxies["nested"] = vpnProxy{Type: "Selector", Now: "automatic", All: []string{"automatic", "node-a"}}
		}, "NativeAutomatic"},
		{"fixed current automatic", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.Now = "automatic"
			s.Proxies["AI-private"] = p
			p = s.Proxies["automatic"]
			p.Fixed = vpnBool(true)
			s.Proxies["automatic"] = p
		}, "FixedSelection"},
		{"fixed parent selector", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.Fixed = vpnBool(true)
			s.Proxies["AI-private"] = p
		}, "FixedSelection"},
		{"missing current member", func(s *vpnSnapshot) { p := s.Proxies["AI-private"]; p.Now = "missing"; s.Proxies["AI-private"] = p }, "UnknownRoute"},
		{"selector selected an unlisted group", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.All = []string{"node-b", "speed"}
			s.Proxies["AI-private"] = p
		}, "UnknownRoute"},
		{"shared by unrelated rule", func(s *vpnSnapshot) {
			s.Rules = append(s.Rules, vpnRule{Type: "DomainSuffix", Payload: "example.com", Proxy: "AI-private"})
		}, "SharedSelector"},
		{"shared by another group", func(s *vpnSnapshot) {
			s.Proxies["other"] = vpnProxy{Type: "Selector", Now: "node-a", All: []string{"AI-private", "node-a"}}
		}, "SharedSelector"},
		{"unknown earlier rule set", func(s *vpnSnapshot) {
			s.Rules = append([]vpnRule{{Type: "RuleSet", Payload: "opaque", Proxy: "default"}}, s.Rules...)
		}, "UnknownRoute"},
		{"unknown earlier keyword", func(s *vpnSnapshot) {
			s.Rules = append([]vpnRule{{Type: "DomainKeyword", Payload: "open", Proxy: "default"}}, s.Rules...)
		}, "UnknownRoute"},
		{"match before explicit domains", func(s *vpnSnapshot) { s.Rules = append([]vpnRule{{Type: "Match", Proxy: "default"}}, s.Rules...) }, "UnknownRoute"},
		{"global mode", func(s *vpnSnapshot) { s.Config.Mode = "global" }, "UnknownRoute"},
		{"unrecognized mode", func(s *vpnSnapshot) { s.Config.Mode = "" }, "UnknownRoute"},
		{"different direct groups", func(s *vpnSnapshot) { s.Rules[3].Proxy = "default" }, "SharedSelector"},
		{"missing domain", func(s *vpnSnapshot) { s.Rules = s.Rules[:3] }, "UnknownRoute"},
		{"broad suffix is not dedicated", func(s *vpnSnapshot) { s.Rules = []vpnRule{{Type: "DomainSuffix", Payload: "com", Proxy: "AI-private"}} }, "SharedSelector"},
		{"global rule route", func(s *vpnSnapshot) {
			for i := range s.Rules[:4] {
				s.Rules[i].Proxy = "GLOBAL"
			}
			s.Proxies["GLOBAL"] = s.Proxies["AI-private"]
		}, "SharedSelector"},
		{"manual only", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.All = []string{"node-a", "node-b"}
			s.Proxies["AI-private"] = p
		}, "ManualOnly"},
		{"all candidates fixed", func(s *vpnSnapshot) {
			for _, n := range []string{"automatic", "speed"} {
				p := s.Proxies[n]
				p.Fixed = vpnBool(true)
				s.Proxies[n] = p
			}
		}, "NeedsSetup"},
		{"unknown fixed state", func(s *vpnSnapshot) {
			for _, n := range []string{"automatic", "speed"} {
				p := s.Proxies[n]
				p.Fixed = nil
				s.Proxies[n] = p
			}
		}, "NeedsSetup"},
		{"one member", func(s *vpnSnapshot) {
			for _, n := range []string{"automatic", "speed"} {
				p := s.Proxies[n]
				p.All = []string{"node-a"}
				s.Proxies[n] = p
			}
		}, "NeedsSetup"},
		{"no existing health", func(s *vpnSnapshot) {
			s.Proxies["node-a"] = vpnProxy{Type: "Shadowsocks", Alive: vpnBool(false)}
			s.Proxies["node-b"] = vpnProxy{Type: "Shadowsocks"}
		}, "NeedsSetup"},
		{"cycle", func(s *vpnSnapshot) {
			p := s.Proxies["AI-private"]
			p.Now = "AI-private"
			p.All = append(p.All, "AI-private")
			s.Proxies["AI-private"] = p
		}, "UnknownRoute"},
		{"non-selector route", func(s *vpnSnapshot) {
			for i := range s.Rules[:4] {
				s.Rules[i].Proxy = "node-a"
			}
		}, "ManualOnly"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := vpnSafeSnapshot()
			tc.edit(&snapshot)
			if got := analyzeVPNSnapshot(snapshot); got.Status != tc.want {
				t.Fatalf("analysis = %+v, want %s", got, tc.want)
			}
		})
	}
}

func TestVPNAnalysisUsesActualFirstDomainMatch(t *testing.T) {
	s := vpnSafeSnapshot()
	s.Rules = append([]vpnRule{{Type: "Domain", Payload: "chatgpt.com", Proxy: "default"}}, s.Rules...)
	if got := analyzeVPNSnapshot(s); got.Status != "SharedSelector" {
		t.Fatalf("analysis = %+v; exact first match must not be skipped", got)
	}
}

func TestVPNAnalysisAlreadyAutomaticNeedsNoCommonSelector(t *testing.T) {
	s := vpnSafeSnapshot()
	for i := range s.Rules[:4] {
		s.Rules[i].Proxy = "automatic"
	}
	s.Rules[3].Proxy = "speed"
	if got := analyzeVPNSnapshot(s); got.Status != "NativeAutomatic" {
		t.Fatalf("analysis = %+v; existing automatic routes need no rewrite", got)
	}
}

func TestVPNAnalysisUsesURLTestWhenFallbackNotUsable(t *testing.T) {
	snapshot := vpnSafeSnapshot()
	p := snapshot.Proxies["automatic"]
	p.Fixed = vpnBool(true)
	snapshot.Proxies["automatic"] = p
	if got := analyzeVPNSnapshot(snapshot); got.Status != "Ready" || got.Target != "speed" {
		t.Fatalf("analysis = %+v, want existing URLTest", got)
	}
}

func TestVPNAnalysisImplicitGlobalDependencyIsOnlyIgnoredWhenUnused(t *testing.T) {
	for _, tc := range []struct {
		name        string
		rule, group bool
		want        string
	}{
		{name: "unused generated GLOBAL", want: "Ready"},
		{name: "global used by website", rule: true, want: "SharedSelector"},
		{name: "global used by group", group: true, want: "SharedSelector"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := vpnSafeSnapshot()
			s.Proxies["GLOBAL"] = vpnProxy{Type: "Selector", Now: "node-a", All: []string{"AI-private", "node-a"}}
			if tc.rule {
				s.Rules = append(s.Rules, vpnRule{Type: "DomainSuffix", Payload: "example.org", Proxy: "GLOBAL"})
			}
			if tc.group {
				s.Proxies["other"] = vpnProxy{Type: "Selector", Now: "node-a", All: []string{"GLOBAL", "node-a"}}
			}
			if got := analyzeVPNSnapshot(s); got.Status != tc.want {
				t.Fatalf("analysis = %+v, want %s", got, tc.want)
			}
		})
	}
}
