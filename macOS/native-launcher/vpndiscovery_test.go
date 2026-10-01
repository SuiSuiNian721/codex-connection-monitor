package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVPNControllerYAMLReadsOnlyLocalControllerAndSecret(t *testing.T) {
	config := []byte("external-controller: '127.0.0.1:9090'\nsecret: \"fixture:quoted#token\"\nproxies:\n  - {name: private, password: ignored}\n")
	endpoint, err := parseVPNControllerYAML(config)
	if err != nil || endpoint.Address != "http://127.0.0.1:9090" || endpoint.Secret != "fixture:quoted#token" {
		t.Fatalf("expected quoted local controller and exact secret, got safe parse failure: %v", err)
	}
}

func TestVPNControllerYAMLRejectsUnsafeControllerWithoutLeaking(t *testing.T) {
	for _, address := range []string{"0.0.0.0:9090", "192.168.0.1:9090", "example.com:9090", "127.0.0.1.evil:9090", "http://user:fixture-private@127.0.0.1:9090", "http://127.0.0.1:9090/private", "https://127.0.0.1:9090", "127.0.0.1:0", "127.0.0.1:65536"} {
		t.Run(address, func(t *testing.T) {
			_, err := parseVPNControllerYAML([]byte("external-controller: '" + address + "'\nsecret: fixture-private\n"))
			if err == nil || strings.Contains(err.Error(), "fixture-private") || strings.Contains(err.Error(), address) {
				t.Fatal("unsafe controller accepted or error contains private configuration")
			}
		})
	}
	for _, config := range []string{"external-controller: [127.0.0.1:9090]\nsecret: fixture-private", "external-controller: 127.0.0.1:9090\nsecret: [fixture-private]", "external-controller: 127.0.0.1:9090\nexternal-controller: 127.0.0.1:9091", "[fixture-private", "external-controller: 127.0.0.1:9090\n---\nsecret: fixture-private"} {
		if _, err := parseVPNControllerYAML([]byte(config)); err == nil || strings.Contains(err.Error(), "fixture-private") {
			t.Fatal("invalid or ambiguous YAML accepted, or private YAML escaped into error")
		}
	}
	if _, err := parseVPNControllerYAML([]byte("external-controller: 127.0.0.1:9090\nsecret: |\n  first\n  second\n")); err == nil {
		t.Fatal("multiline secret must not become an HTTP header")
	}
}

func TestVPNDiscoveryCFWMatchesActiveCoreAndExactRuntimeConfig(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	path := filepath.Join(home, ".config", "clash", "config.yaml")
	reads := 0
	loader := func(got string) ([]byte, error) {
		reads++
		if got != path {
			t.Fatal("discovery read unrelated file")
		}
		return []byte("external-controller: '127.0.0.1:9090'\nsecret: fixture-only\n"), nil
	}
	core := vpnCoreProcess{PID: 42, Name: "clash-win64.exe", Client: "CFW", ConfigDir: filepath.Dir(path)}
	endpoints, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, home, "windows", loader)
	if err != nil || len(endpoints) != 1 || endpoints[0].Client != "CFW" || endpoints[0].Address != "http://127.0.0.1:9090" || reads != 1 {
		t.Fatal("running CFW core was not matched to its runtime config")
	}
	core.ConfigDir = filepath.Join(home, "unrelated")
	reads = 0
	if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, home, "windows", loader); err == nil || reads != 0 {
		t.Fatal("core runtime config mismatch must not read a stale CFW config")
	}
}

func TestVPNDiscoveryRejectsInactiveUnknownAndAmbiguousOwners(t *testing.T) {
	loader := func(string) ([]byte, error) {
		t.Fatal("must not read config without a uniquely supported active core")
		return nil, errors.New("unreachable")
	}
	for _, owners := range [][]vpnCoreProcess{
		nil,
		{{PID: 1, Name: "chrome.exe", Client: "CFW"}},
		{{PID: 1, Name: "clash-win64.exe", Client: "ArbitraryPrivateName"}},
		{{PID: 1, Name: "clash-win64.exe", Client: "CFW"}, {PID: 2, Name: "mihomo.exe", Client: "QingShan"}},
	} {
		if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: owners}, t.TempDir(), "windows", loader); err == nil {
			t.Fatal("inactive, unknown or ambiguous owner accepted")
		}
	}
}

func TestVPNDiscoveryQingShanPipeRequiresActiveAppAndMatchingSidecar(t *testing.T) {
	app := filepath.Join(t.TempDir(), "QingShan", "青山.exe")
	core := vpnCoreProcess{PID: 9, Name: "mihomo.exe", Client: "QingShan", AppExecutable: app, Executable: filepath.Join(filepath.Dir(app), "resources", "sidecar", "mihomo.exe"), Pipe: `\\.\pipe\MihomoParty\mihomo`}
	loader := func(string) ([]byte, error) {
		t.Fatal("QingShan pipe must not read encoded or private node config")
		return nil, errors.New("unreachable")
	}
	endpoints, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, "", "windows", loader)
	if err != nil || len(endpoints) != 1 || endpoints[0].Client != "QingShan" || endpoints[0].Pipe != core.Pipe {
		t.Fatal("active QingShan sidecar pipe not identified")
	}
	for _, mutate := range []func(*vpnCoreProcess){
		func(c *vpnCoreProcess) { c.Client = "Mihomo" },
		func(c *vpnCoreProcess) { c.AppExecutable = "" },
		func(c *vpnCoreProcess) { c.Executable = filepath.Join(filepath.Dir(app), "another", "mihomo.exe") },
		func(c *vpnCoreProcess) { c.Pipe = `\\.\pipe\another\mihomo` },
		func(c *vpnCoreProcess) { c.Name = "other.exe" },
		func(c *vpnCoreProcess) {
			c.AppExecutable = `\\remote\VPN\青山.exe`
			c.Executable = filepath.Join(filepath.Dir(c.AppExecutable), "resources", "sidecar", "mihomo.exe")
		},
	} {
		bad := core
		mutate(&bad)
		if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{bad}}, "", "windows", loader); err == nil {
			t.Fatal("pipe was accepted without matching active QingShan core/app ownership")
		}
	}
}

func TestVPNDiscoveryDeduplicatesSinglePIDListeners(t *testing.T) {
	app := filepath.Join(t.TempDir(), "青山.exe")
	core := vpnCoreProcess{PID: 9, Name: "mihomo.exe", Client: "QingShan", AppExecutable: app, Executable: filepath.Join(filepath.Dir(app), "resources", "sidecar", "mihomo.exe"), Pipe: `\\.\pipe\MihomoParty\mihomo`}
	endpoints, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core, core}}, "", "windows", nil)
	if err != nil || len(endpoints) != 1 {
		t.Fatal("IPv4/IPv6 listener records for the same core must not create ambiguity")
	}
}

func TestVPNHTTPClientRejectsRedirectAndDoesNotUseSystemProxy(t *testing.T) {
	var destinationRequests, proxyRequests int
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationRequests++; w.WriteHeader(http.StatusOK) }))
	defer destination.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxyRequests++; w.WriteHeader(http.StatusBadGateway) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer controller.Close()
	client, base, err := vpnHTTPClient(vpnEndpoint{Client: "CFW", Address: controller.URL, Secret: "fixture-private"})
	if err != nil || client.Timeout <= 0 || client.Timeout > 5*time.Second {
		t.Fatal("local controller client must have a bounded timeout")
	}
	response, err := client.Get(base + "/configs")
	if err != nil {
		t.Fatal("redirect response should remain available without following it")
	}
	response.Body.Close()
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil || response.StatusCode != http.StatusFound || destinationRequests != 0 || proxyRequests != 0 {
		t.Fatal("controller redirect followed or system proxy configured")
	}
}

func TestVPNHTTPClientRejectsUnsafeEndpointAndAmbiguousTransport(t *testing.T) {
	for _, endpoint := range []vpnEndpoint{
		{Address: "http://example.com:9090", Secret: "fixture-private"},
		{Address: "http://0.0.0.0:9090"},
		{Address: "http://127.0.0.1:9090/extra"},
		{Address: "http://127.0.0.1:9090", Pipe: `\\.\pipe\MihomoParty\mihomo`},
		{Pipe: `\\remote\pipe\MihomoParty\mihomo`},
		{Socket: "relative.sock"},
		{},
	} {
		if _, _, err := vpnHTTPClient(endpoint); err == nil || strings.Contains(err.Error(), "fixture-private") {
			t.Fatal("unsafe or ambiguous endpoint accepted, or secret exposed")
		}
	}
}

func TestVPNProxyURIValidation(t *testing.T) {
	for _, uri := range []string{"http://127.0.0.1:7890", "socks5://localhost:7890", "http://[::1]:7890"} {
		port, err := vpnProxyPort(uri)
		if err != nil || port != 7890 {
			t.Fatal("valid local proxy rejected")
		}
	}
	for _, uri := range []string{"http://example.com:7890", "http://127.0.0.1:0", "http://secret:token@127.0.0.1:7890", "http://127.0.0.1:7890/path", "http://127.0.0.1:7890?secret=fixture", "http://127.0.0.1", "file:///private"} {
		if _, err := vpnProxyPort(uri); err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private") {
			t.Fatal("invalid proxy accepted or private URI exposed")
		}
	}
}

func TestVPNConfigurationReadErrorDoesNotLeakPath(t *testing.T) {
	loader := func(path string) ([]byte, error) {
		return nil, &os.PathError{Op: "open", Path: path, Err: errors.New("fixture-private")}
	}
	_, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{{PID: 1, Name: "clash-win64.exe", Client: "CFW"}}}, filepath.Join(t.TempDir(), "fixture-private"), "windows", loader)
	if err == nil || strings.Contains(err.Error(), "fixture-private") {
		t.Fatal("private configuration path escaped into error")
	}
}

func TestVPNDiscoveryMacRequiresKnownClientRuntimeConfig(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev")
	configPath := filepath.Join(dir, "clash-verge.yaml")
	reads := 0
	loader := func(path string) ([]byte, error) {
		reads++
		if path != configPath {
			t.Fatal("unrelated Mac config read")
		}
		return []byte("external-controller: '[::1]:9090'\nsecret: fixture-only\n"), nil
	}
	core := vpnCoreProcess{PID: 42, Name: "verge-mihomo", Client: "ClashVerge", ConfigFile: configPath}
	endpoints, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, home, "darwin", loader)
	if err != nil || len(endpoints) != 1 || endpoints[0].Client != "ClashVerge" || endpoints[0].Address != "http://[::1]:9090" {
		t.Fatal("supported active Mac core config not discovered")
	}
	core.ConfigFile = filepath.Join(home, "private", "subscription.yaml")
	reads = 0
	if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, home, "darwin", loader); err == nil || reads != 0 {
		t.Fatal("unknown or subscription config path must not be read")
	}
}

func TestVPNCoreArgumentsPreserveQuotedLocalPathsAndDropSecrets(t *testing.T) {
	flags, err := parseVPNCoreArguments(`mihomo -d "/Users/fixture/Library/Application Support/mihomo-party" -f '/Users/fixture/runtime config.yaml' -ext-ctl "127.0.0.1:9090" -secret fixture-private`)
	if err != nil || flags.ConfigDir != "/Users/fixture/Library/Application Support/mihomo-party" || flags.ConfigFile != "/Users/fixture/runtime config.yaml" || flags.Address != "127.0.0.1:9090" {
		t.Fatal("quoted core runtime arguments were not parsed")
	}
	for _, args := range []string{`mihomo -d "unterminated`, `mihomo -d /one -d /two`, `mihomo -ext-ctl`, `mihomo -ext-ctl-pipe one -ext-ctl-pipe two`} {
		if _, err := parseVPNCoreArguments(args); err == nil || strings.Contains(err.Error(), args) {
			t.Fatal("ambiguous core argument list accepted or exposed")
		}
	}
}

func TestVPNDiscoveryRejectsInvalidOrInconsistentControllerOverride(t *testing.T) {
	core := vpnCoreProcess{PID: 42, Name: "clash-win64.exe", Client: "CFW", Address: "0.0.0.0:9090"}
	loader := func(string) ([]byte, error) { return []byte("external-controller: 127.0.0.1:9090\n"), nil }
	if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, t.TempDir(), "windows", loader); err == nil {
		t.Fatal("unsafe CLI controller override must not fall back to a stale YAML controller")
	}
	core.Address = "127.0.0.1:9091"
	if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, t.TempDir(), "windows", loader); err == nil {
		t.Fatal("controller address override mismatch must be refused")
	}
}

func TestVPNDiscoveryRejectsNetworkOrRelativeHomeWithoutReading(t *testing.T) {
	core := vpnCoreProcess{PID: 42, Name: "clash-win64.exe", Client: "CFW"}
	for _, home := range []string{`\\remote\private`, "relative-home"} {
		read := false
		loader := func(string) ([]byte, error) { read = true; return []byte("external-controller: 127.0.0.1:9090\n"), nil }
		if _, err := chooseVPNEndpoints(vpnProcessSnapshot{Owners: []vpnCoreProcess{core}}, home, "windows", loader); err == nil || read {
			t.Fatal("nonlocal or relative home must not trigger configuration reads")
		}
	}
}

func TestVPNCoreNamesIncludeFixedMacBinariesNotClientExecutables(t *testing.T) {
	for _, name := range []string{"clash", "clash-darwin", "clash-darwin-arm64", "mihomo", "verge-mihomo", "verge-mihomo-alpha"} {
		if !isVPNCoreName(name) {
			t.Fatal("supported fixed core binary name was not recognized")
		}
	}
	for _, name := range []string{"clash-verge", "mihomo-party", "Clash for Windows", "not-a-core"} {
		if isVPNCoreName(name) {
			t.Fatal("client application executable must not be treated as proxy core")
		}
	}
}

func TestVPNMacClientIdentityUsesFixedAppBundleNames(t *testing.T) {
	for path, expected := range map[string]string{
		"/Applications/Clash for Windows.app/Contents/MacOS/Clash for Windows": "CFW",
		"/Applications/Clash Verge.app/Contents/MacOS/clash-verge":             "ClashVerge",
		"/Applications/Mihomo Party.app/Contents/MacOS/Mihomo Party":           "Mihomo",
		"/Applications/ClashX.app/Contents/MacOS/ClashX":                       "",
		"/Applications/Unknown.app/Contents/MacOS/mihomo":                      "",
		"/Applications/Clash Verge.app.backup/Contents/MacOS/clash-verge":      "",
	} {
		if actual := vpnClientFromMacExecutable(path); actual != expected {
			t.Fatal("Mac app identity was misidentified")
		}
	}
}
