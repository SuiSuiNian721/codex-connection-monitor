package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type vpnEndpoint struct {
	Client, Address, Secret, Pipe, Socket string
}

type vpnCoreProcess struct {
	PID                                                                                   int
	Name, Client, Executable, AppExecutable, ConfigDir, ConfigFile, Address, Pipe, Socket string
	InvalidArgs                                                                           bool
}

type vpnProcessSnapshot struct {
	Owners []vpnCoreProcess
}

func vpnClientFromMacExecutable(path string) string {
	path = strings.ToLower(strings.ReplaceAll(filepath.Clean(path), `\`, "/"))
	for _, app := range []string{"/clash for windows.app/contents/"} {
		if strings.Contains(path, app) {
			return "CFW"
		}
	}
	for _, app := range []string{"/clash verge.app/contents/", "/clash verge rev.app/contents/"} {
		if strings.Contains(path, app) {
			return "ClashVerge"
		}
	}
	for _, app := range []string{"/mihomo party.app/contents/", "/mihomoparty.app/contents/", "/mihomo.app/contents/"} {
		if strings.Contains(path, app) {
			return "Mihomo"
		}
	}
	return ""
}

var errVPNUnsupported = errors.New("VPN controller unsupported")
var errVPNDiscovery = errors.New("VPN discovery unavailable")
var errVPNConfig = errors.New("VPN controller configuration invalid")
var errVPNTransport = errors.New("VPN local controller unavailable")

const vpnDiscoveryTimeout = 5 * time.Second
const vpnMaxConfigBytes = 4 * 1024 * 1024
const qingShanControllerPipe = `\\.\pipe\MihomoParty\mihomo`

func discoverVPNControllers(proxyURI string) ([]vpnEndpoint, error) {
	port, err := vpnProxyPort(proxyURI)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), vpnDiscoveryTimeout)
	defer cancel()
	snapshot, err := collectVPNProcesses(ctx, port)
	if err != nil {
		return nil, errVPNDiscovery
	}
	home, err := os.UserHomeDir()
	if err != nil || ctx.Err() != nil {
		return nil, errVPNDiscovery
	}
	return chooseVPNEndpoints(snapshot, home, runtime.GOOS, readVPNConfiguration)
}

func parseVPNControllerYAML(data []byte) (vpnEndpoint, error) {
	if len(data) == 0 || len(data) > vpnMaxConfigBytes {
		return vpnEndpoint{}, errVPNConfig
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var document yaml.Node
	if decoder.Decode(&document) != nil || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return vpnEndpoint{}, errVPNConfig
	}
	var trailing yaml.Node
	if decoder.Decode(&trailing) != io.EOF {
		return vpnEndpoint{}, errVPNConfig
	}
	endpoint := vpnEndpoint{}
	seen := make(map[string]bool)
	root := document.Content[0]
	for index := 0; index+1 < len(root.Content); index += 2 {
		key, value := root.Content[index], root.Content[index+1]
		if key.Kind != yaml.ScalarNode || (key.Value != "external-controller" && key.Value != "secret") {
			continue
		}
		if seen[key.Value] || value.Kind != yaml.ScalarNode {
			return vpnEndpoint{}, errVPNConfig
		}
		seen[key.Value] = true
		if value.Tag == "!!null" {
			continue
		}
		if key.Value == "secret" {
			if len(value.Value) > 4096 || strings.ContainsAny(value.Value, "\r\n\x00") {
				return vpnEndpoint{}, errVPNConfig
			}
			endpoint.Secret = value.Value
		} else if strings.TrimSpace(value.Value) != "" {
			address, err := normalizeVPNController(value.Value)
			if err != nil {
				return vpnEndpoint{}, errVPNConfig
			}
			endpoint.Address = address
		}
	}
	return endpoint, nil
}

func chooseVPNEndpoints(snapshot vpnProcessSnapshot, home, platform string, readFile func(string) ([]byte, error)) ([]vpnEndpoint, error) {
	owners := make(map[int]vpnCoreProcess)
	for _, owner := range snapshot.Owners {
		if owner.PID <= 0 || owner.InvalidArgs {
			return nil, errVPNUnsupported
		}
		if previous, exists := owners[owner.PID]; exists && previous != owner {
			return nil, errVPNUnsupported
		}
		owners[owner.PID] = owner
	}
	if len(owners) != 1 {
		return nil, errVPNUnsupported
	}
	var core vpnCoreProcess
	for _, owner := range owners {
		core = owner
	}
	if !isVPNCoreName(core.Name) {
		return nil, errVPNUnsupported
	}
	if platform == "windows" && core.Client == "QingShan" {
		if !isMihomoCoreName(core.Name) || core.Pipe != qingShanControllerPipe || core.Address != "" || core.Socket != "" || !qingShanSidecarMatches(core) {
			return nil, errVPNUnsupported
		}
		return []vpnEndpoint{{Client: "QingShan", Pipe: qingShanControllerPipe}}, nil
	}
	if core.Pipe != "" || (platform != "windows" && platform != "darwin") {
		return nil, errVPNUnsupported
	}
	configPath, ok := trustedVPNConfigPath(core, home, platform)
	if !ok || readFile == nil {
		return nil, errVPNUnsupported
	}
	data, err := readFile(configPath)
	if err != nil {
		return nil, errVPNConfig
	}
	endpoint, err := parseVPNControllerYAML(data)
	if err != nil {
		return nil, err
	}
	if core.Address != "" {
		address, err := normalizeVPNController(core.Address)
		if err != nil || (endpoint.Address != "" && endpoint.Address != address) {
			return nil, errVPNUnsupported
		}
		endpoint.Address = address
	}
	if core.Socket != "" {
		if platform != "darwin" || !filepath.IsAbs(core.Socket) || strings.ContainsAny(core.Socket, "\r\n\x00") {
			return nil, errVPNUnsupported
		}
		// The explicitly bound Unix endpoint takes precedence over an unused HTTP field.
		endpoint.Address = ""
		endpoint.Socket = filepath.Clean(core.Socket)
	}
	if endpoint.Address == "" && endpoint.Socket == "" {
		return nil, errVPNUnsupported
	}
	endpoint.Client = core.Client
	return []vpnEndpoint{endpoint}, nil
}

func vpnHTTPClient(endpoint vpnEndpoint) (*http.Client, string, error) {
	transports := 0
	for _, value := range []string{endpoint.Address, endpoint.Pipe, endpoint.Socket} {
		if value != "" {
			transports++
		}
	}
	if transports != 1 || len(endpoint.Secret) > 4096 || strings.ContainsAny(endpoint.Secret, "\r\n\x00") {
		return nil, "", errVPNUnsupported
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		ResponseHeaderTimeout:  5 * time.Second,
		MaxResponseHeaderBytes: 64 * 1024,
	}
	base := "http://localhost"
	if endpoint.Address != "" {
		var err error
		base, err = normalizeVPNController(endpoint.Address)
		if err != nil {
			return nil, "", errVPNUnsupported
		}
		parsed, _ := url.Parse(base)
		dialer := &net.Dialer{Timeout: 2 * time.Second}
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != parsed.Host {
				return nil, errVPNTransport
			}
			connection, err := dialer.DialContext(ctx, network, address)
			if err != nil {
				return nil, errVPNTransport
			}
			return connection, nil
		}
	} else {
		dial, err := vpnLocalDialer(endpoint)
		if err != nil {
			return nil, "", errVPNUnsupported
		}
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != "localhost:80" {
				return nil, errVPNTransport
			}
			return dial(ctx)
		}
	}
	return &http.Client{
		Transport:     transport,
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, base, nil
}

func vpnProxyPort(proxyURI string) (int, error) {
	parsed, err := url.Parse(proxyURI)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "socks5" && parsed.Scheme != "socks5h") || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || !vpnLoopbackHost(parsed.Hostname()) {
		return 0, errVPNUnsupported
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port <= 0 || port > 65535 {
		return 0, errVPNUnsupported
	}
	return port, nil
}

func parseVPNCoreArguments(commandLine string) (vpnCoreProcess, error) {
	tokens, err := splitVPNCommandLine(commandLine)
	if err != nil {
		return vpnCoreProcess{}, errVPNUnsupported
	}
	flags := vpnCoreProcess{}
	seen := make(map[string]bool)
	for index := 1; index < len(tokens); index++ {
		flag, value, inline := strings.Cut(tokens[index], "=")
		var destination *string
		switch flag {
		case "-d":
			destination = &flags.ConfigDir
		case "-f":
			destination = &flags.ConfigFile
		case "-ext-ctl":
			destination = &flags.Address
		case "-ext-ctl-pipe":
			destination = &flags.Pipe
		case "-ext-ctl-unix":
			destination = &flags.Socket
		default:
			continue
		}
		if seen[flag] {
			return vpnCoreProcess{}, errVPNUnsupported
		}
		seen[flag] = true
		if !inline {
			index++
			if index >= len(tokens) || strings.HasPrefix(tokens[index], "-") {
				return vpnCoreProcess{}, errVPNUnsupported
			}
			value = tokens[index]
		}
		*destination = value
	}
	return flags, nil
}

func splitVPNCommandLine(commandLine string) ([]string, error) {
	if len(commandLine) > 64*1024 || strings.ContainsAny(commandLine, "\r\n\x00") {
		return nil, errVPNUnsupported
	}
	var tokens []string
	var token strings.Builder
	var quote rune
	inToken := false
	runes := []rune(commandLine)
	for index := 0; index < len(runes); index++ {
		character := runes[index]
		if quote == 0 && (character == ' ' || character == '\t') {
			if inToken {
				tokens = append(tokens, token.String())
				token.Reset()
				inToken = false
			}
			continue
		}
		if character == '\'' || character == '"' {
			if quote == 0 {
				quote = character
				inToken = true
				continue
			}
			if quote == character {
				quote = 0
				continue
			}
		}
		if character == '\\' && index+1 < len(runes) && (runes[index+1] == quote || (quote == 0 && (runes[index+1] == ' ' || runes[index+1] == '"' || runes[index+1] == '\''))) {
			index++
			character = runes[index]
		}
		inToken = true
		token.WriteRune(character)
	}
	if quote != 0 {
		return nil, errVPNUnsupported
	}
	if inToken {
		tokens = append(tokens, token.String())
	}
	if len(tokens) == 0 {
		return nil, errVPNUnsupported
	}
	return tokens, nil
}

func normalizeVPNController(address string) (string, error) {
	if address == "" || strings.TrimSpace(address) != address || strings.ContainsAny(address, "\r\n\x00") {
		return "", errVPNUnsupported
	}
	if !strings.Contains(address, "://") {
		address = "http://" + address
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || !vpnLoopbackHost(parsed.Hostname()) {
		return "", errVPNUnsupported
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port <= 0 || port > 65535 {
		return "", errVPNUnsupported
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)), nil
}

func vpnLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func vpnExecutableName(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	index := strings.LastIndex(path, "/")
	return strings.ToLower(path[index+1:])
}

func isMihomoCoreName(name string) bool {
	name = strings.TrimSuffix(vpnExecutableName(name), ".exe")
	return name == "mihomo" || name == "verge-mihomo" || name == "verge-mihomo-alpha" || strings.HasPrefix(name, "mihomo-windows-") || strings.HasPrefix(name, "mihomo-darwin-") || name == "clash-meta" || strings.HasPrefix(name, "clash-meta-")
}

func isVPNCoreName(name string) bool {
	name = strings.TrimSuffix(vpnExecutableName(name), ".exe")
	return isMihomoCoreName(name) || name == "clash" || name == "clash-core" || name == "clash-win64" || name == "clash-darwin" || strings.HasPrefix(name, "clash-win64-") || strings.HasPrefix(name, "clash-darwin-")
}

func qingShanSidecarMatches(core vpnCoreProcess) bool {
	appName := vpnExecutableName(core.AppExecutable)
	if (appName != "青山.exe" && appName != "qingshan.exe") || core.Executable == "" || !filepath.IsAbs(core.AppExecutable) || !filepath.IsAbs(core.Executable) || strings.HasPrefix(core.AppExecutable, `\\`) || strings.HasPrefix(core.Executable, `\\`) {
		return false
	}
	expected := filepath.Join(filepath.Dir(core.AppExecutable), "resources", "sidecar", filepath.Base(core.Executable))
	return strings.EqualFold(filepath.Clean(expected), filepath.Clean(core.Executable)) && isMihomoCoreName(core.Executable)
}

func trustedVPNConfigPath(core vpnCoreProcess, home, platform string) (string, bool) {
	if home == "" || !filepath.IsAbs(home) || (platform == "windows" && strings.HasPrefix(home, `\\`)) {
		return "", false
	}
	var roots []string
	files := []string{"config.yaml"}
	switch core.Client {
	case "CFW":
		roots = []string{filepath.Join(home, ".config", "clash")}
	case "ClashVerge":
		if platform != "darwin" {
			return "", false
		}
		roots = []string{filepath.Join(home, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev"), filepath.Join(home, "Library", "Application Support", "io.github.clash-verge.clash-verge")}
		files = []string{"config.yaml", "clash-verge.yaml"}
	case "Mihomo":
		if platform != "darwin" {
			return "", false
		}
		roots = []string{filepath.Join(home, "Library", "Application Support", "mihomo-party"), filepath.Join(home, "Library", "Application Support", "mihomo"), filepath.Join(home, ".config", "mihomo")}
		files = []string{"config.yaml", "mihomo.yaml"}
	default:
		return "", false
	}
	if core.ConfigDir == "" && core.ConfigFile == "" && core.Client != "CFW" {
		return "", false
	}
	for _, root := range roots {
		if core.ConfigDir != "" && !vpnSamePath(core.ConfigDir, root, platform) {
			continue
		}
		candidate := core.ConfigFile
		if candidate == "" {
			candidate = filepath.Join(root, "config.yaml")
		}
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(root, candidate)
		}
		for _, file := range files {
			expected := filepath.Join(root, file)
			if vpnSamePath(candidate, expected, platform) {
				return expected, true
			}
		}
	}
	return "", false
}

func vpnSamePath(left, right, platform string) bool {
	left, right = filepath.Clean(left), filepath.Clean(right)
	if platform == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func readVPNConfiguration(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > vpnMaxConfigBytes {
		return nil, errVPNConfig
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errVPNConfig
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, vpnMaxConfigBytes+1))
	if err != nil || len(data) > vpnMaxConfigBytes {
		return nil, errVPNConfig
	}
	return data, nil
}

// A hostile process cannot force discovery to retain unbounded command output.
type vpnCommandBuffer struct{ bytes.Buffer }

func (buffer *vpnCommandBuffer) Write(data []byte) (int, error) {
	if buffer.Len()+len(data) > 128*1024 {
		return 0, errVPNDiscovery
	}
	return buffer.Buffer.Write(data)
}
