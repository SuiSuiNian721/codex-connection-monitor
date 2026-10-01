package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type vpnAssistResult struct {
	Status  string `json:"Status"`
	Action  string `json:"Action"`
	Client  string `json:"Client"`
	Message string `json:"Message"`
}

type vpnRule struct {
	Type    string `json:"type"`
	Payload string `json:"payload"`
	Proxy   string `json:"proxy"`
}

type vpnDelay struct {
	Delay int `json:"delay"`
}

type vpnProxy struct {
	Type  string   `json:"type"`
	Now   string   `json:"now"`
	All   []string `json:"all"`
	Fixed *bool    `json:"fixed"`
	// Mihomo 的 fixed 是节点名；内部保留以检测竞争，绝不进入辅助结果。
	FixedChoice string     `json:"-"`
	Alive       *bool      `json:"alive"`
	History     []vpnDelay `json:"history"`
}

func (proxy *vpnProxy) UnmarshalJSON(data []byte) error {
	type wireProxy vpnProxy
	var decoded struct {
		*wireProxy
		Fixed json.RawMessage `json:"fixed"`
	}
	value := vpnProxy{}
	decoded.wireProxy = (*wireProxy)(&value)
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	if len(decoded.Fixed) != 0 && string(decoded.Fixed) != "null" {
		var fixed bool
		if decoded.Fixed[0] == '"' {
			if err := json.Unmarshal(decoded.Fixed, &value.FixedChoice); err != nil {
				return err
			}
			fixed = value.FixedChoice != ""
		} else if err := json.Unmarshal(decoded.Fixed, &fixed); err != nil {
			return errors.New("invalid controller fixed state")
		}
		value.Fixed = &fixed
	}
	*proxy = value
	return nil
}

type vpnConfig struct {
	Port           int    `json:"port"`
	MixedPort      int    `json:"mixed-port"`
	MixedPortCamel int    `json:"mixedPort"`
	Mode           string `json:"mode"`
}

type vpnSnapshot struct {
	Config  vpnConfig
	Rules   []vpnRule
	Proxies map[string]vpnProxy
}

type vpnAnalysis struct {
	Status   string
	Selector string
	Current  string
	Target   string
}

func analyzeVPNSnapshot(snapshot vpnSnapshot) vpnAnalysis {
	if !strings.EqualFold(snapshot.Config.Mode, "rule") {
		return vpnAnalysis{Status: "UnknownRoute"}
	}
	domains := append([]string(nil), vpnOpenAIDomains...)
	for _, rule := range snapshot.Rules {
		payload := strings.ToLower(strings.TrimSuffix(rule.Payload, "."))
		if vpnRuleIsOpenAIOnly(rule) && !vpnContains(domains, payload) {
			domains = append(domains, payload)
		}
	}
	routes := make([]string, 0, len(domains))
	rootRoutes := map[string]string{}
	allAutomatic := true
	rootSuffixCoverage := true
	for _, domain := range domains {
		route := ""
		for _, rule := range snapshot.Rules {
			if rule.Type != "DomainSuffix" && rule.Type != "Domain" {
				// 无法离线证明 RuleSet、IP 和逻辑规则不会先匹配实际请求。
				return vpnAnalysis{Status: "UnknownRoute"}
			}
			if vpnDomainRuleMatches(rule, domain) {
				route = rule.Proxy
				if vpnContains(vpnOpenAIDomains, domain) && rule.Type != "DomainSuffix" {
					rootSuffixCoverage = false
				}
				break
			}
		}
		if route == "" {
			return vpnAnalysis{Status: "UnknownRoute"}
		}
		if vpnContains(vpnOpenAIDomains, domain) {
			rootRoutes[domain] = route
		} else {
			for _, root := range vpnOpenAIDomains {
				if strings.HasSuffix(domain, "."+root) && rootRoutes[root] != route {
					// 显式子域分流不能当作四个根域共同覆盖所有 OpenAI 流量。
					return vpnAnalysis{Status: "UnknownRoute"}
				}
			}
		}
		status := vpnCurrentRoute(snapshot.Proxies, route)
		if status == "UnknownRoute" || status == "FixedSelection" || status == "NeedsSetup" {
			return vpnAnalysis{Status: status}
		}
		if status != "NativeAutomatic" {
			allAutomatic = false
		}
		routes = append(routes, route)
	}
	if allAutomatic {
		if !rootSuffixCoverage {
			return vpnAnalysis{Status: "UnknownRoute"}
		}
		return vpnAnalysis{Status: "NativeAutomatic"}
	}
	selector := routes[0]
	for _, route := range routes {
		if route != selector {
			return vpnAnalysis{Status: "SharedSelector"}
		}
	}
	// 精确根域规则不能证明 api/auth 等未列出的子域属于同一安全链路。
	if !rootSuffixCoverage {
		return vpnAnalysis{Status: "UnknownRoute"}
	}
	if selector == "GLOBAL" || selector == "MATCH" {
		return vpnAnalysis{Status: "SharedSelector"}
	}
	parent := snapshot.Proxies[selector]
	if parent.Type != "Selector" {
		return vpnAnalysis{Status: "ManualOnly"}
	}
	for _, rule := range snapshot.Rules {
		if rule.Proxy == selector && !vpnRuleIsOpenAIOnly(rule) {
			return vpnAnalysis{Status: "SharedSelector"}
		}
	}
	for name, proxy := range snapshot.Proxies {
		if name == selector || !vpnContains(proxy.All, selector) {
			continue
		}
		if name != "GLOBAL" || !vpnUnusedGlobal(snapshot) {
			return vpnAnalysis{Status: "SharedSelector"}
		}
	}
	hasAutomatic := false
	// 保留客户端已有成员顺序；Fallback 优先，不自行测速或猜测地域。
	for _, kind := range []string{"Fallback", "URLTest"} {
		for _, name := range parent.All {
			candidate, exists := snapshot.Proxies[name]
			if !exists || candidate.Type != kind {
				continue
			}
			hasAutomatic = true
			if vpnUsableAutomatic(snapshot.Proxies, name) {
				return vpnAnalysis{Status: "Ready", Selector: selector, Current: parent.Now, Target: name}
			}
		}
	}
	if hasAutomatic {
		return vpnAnalysis{Status: "NeedsSetup"}
	}
	return vpnAnalysis{Status: "ManualOnly"}
}

var vpnOpenAIDomains = []string{"chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"}

func vpnDomainRuleMatches(rule vpnRule, domain string) bool {
	payload := strings.ToLower(strings.TrimSuffix(rule.Payload, "."))
	return payload == domain || (rule.Type == "DomainSuffix" && strings.HasSuffix(domain, "."+payload))
}

func vpnRuleIsOpenAIOnly(rule vpnRule) bool {
	if rule.Type != "Domain" && rule.Type != "DomainSuffix" {
		return false
	}
	payload := strings.ToLower(strings.TrimSuffix(rule.Payload, "."))
	for _, domain := range vpnOpenAIDomains {
		if payload == domain || strings.HasSuffix(payload, "."+domain) {
			return true
		}
	}
	return false
}

func vpnContains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

func vpnUnusedGlobal(snapshot vpnSnapshot) bool {
	for _, rule := range snapshot.Rules {
		if rule.Proxy == "GLOBAL" && !vpnRuleIsOpenAIOnly(rule) {
			return false
		}
	}
	for name, proxy := range snapshot.Proxies {
		if name != "GLOBAL" && vpnContains(proxy.All, "GLOBAL") {
			return false
		}
	}
	return true
}

func vpnCurrentRoute(proxies map[string]vpnProxy, name string) string {
	seen := map[string]bool{}
	automatic := false
	for {
		proxy, exists := proxies[name]
		if !exists || seen[name] {
			return "UnknownRoute"
		}
		seen[name] = true
		if proxy.Fixed != nil && *proxy.Fixed {
			return "FixedSelection"
		}
		switch proxy.Type {
		case "Fallback", "URLTest":
			if proxy.Fixed == nil {
				return "NeedsSetup"
			}
			automatic = true
		case "Selector":
		default:
			if len(proxy.All) != 0 || proxy.Type == "" {
				return "UnknownRoute"
			}
			if automatic {
				return "NativeAutomatic"
			}
			return "ManualOnly"
		}
		if proxy.Now == "" || !vpnContains(proxy.All, proxy.Now) {
			return "UnknownRoute"
		}
		name = proxy.Now
	}
}

func vpnProxyHasHealth(proxy vpnProxy) bool {
	if proxy.Alive != nil && *proxy.Alive {
		return true
	}
	for _, history := range proxy.History {
		if history.Delay > 0 {
			return true
		}
	}
	return false
}

func vpnUsableAutomatic(proxies map[string]vpnProxy, name string) bool {
	proxy := proxies[name]
	if proxy.Fixed == nil || *proxy.Fixed {
		return false
	}
	members := map[string]bool{}
	healthy := vpnProxyHasHealth(proxy)
	for _, member := range proxy.All {
		child, exists := proxies[member]
		if !exists || member == name {
			return false
		}
		members[member] = true
		healthy = healthy || vpnProxyHasHealth(child)
	}
	return len(members) >= 2 && healthy
}

type vpnAssistDeps struct {
	Discover func(string) ([]vpnEndpoint, error)
	HTTP     func(vpnEndpoint) (*http.Client, string, error)
	Connect  func(context.Context, string) error
	Alive    func() bool
}

func assistVPNWithDeps(proxyURI, probeKind string, deps vpnAssistDeps) vpnAssistResult {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var rootExited atomic.Bool
	action := "None"
	rootAlive := func() bool {
		if deps.Alive != nil && !deps.Alive() {
			rootExited.Store(true)
			cancel()
		}
		return !rootExited.Load()
	}
	finish := func(status, client string) vpnAssistResult {
		if !rootAlive() {
			status = "RootExited"
		}
		return vpnResult(status, action, client)
	}
	if !rootAlive() {
		return finish("RootExited", "")
	}
	if deps.Alive != nil {
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			ticker := time.NewTicker(200 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ctx.Done():
					return
				case <-ticker.C:
					if !rootAlive() {
						return
					}
				}
			}
		}()
	}
	switch probeKind {
	case "Timeout", "TlsFailure", "ConnectionFailure", "NameResolutionFailure", "ResponseFailure":
	default:
		return finish("NotApplicable", "")
	}
	parsed, port, ok := vpnLocalProxy(proxyURI)
	if !ok {
		return finish("UnsupportedProxy", "")
	}
	if deps.Connect == nil || deps.Connect(ctx, parsed.Host) != nil {
		return finish("LocalProxyUnavailable", "")
	}
	if deps.Discover == nil || deps.HTTP == nil {
		return finish("UnknownController", "")
	}
	endpoints, err := deps.Discover(proxyURI)
	if err != nil || len(endpoints) == 0 {
		return finish("UnknownController", "")
	}
	type matchedController struct {
		endpoint vpnEndpoint
		client   *http.Client
		base     string
		config   vpnConfig
	}
	matches := []matchedController{}
	for _, endpoint := range endpoints {
		if vpnClientLabel(endpoint.Client) == "" {
			return finish("UnknownController", "")
		}
		client, base, err := deps.HTTP(endpoint)
		if err != nil || client == nil || !vpnLocalControllerURL(base, endpoint) {
			return finish("ControllerUnavailable", endpoint.Client)
		}
		var version struct {
			Version string `json:"version"`
		}
		if !vpnControllerJSON(ctx, client, base, endpoint.Secret, http.MethodGet, "/version", nil, &version) {
			return finish("ControllerUnavailable", endpoint.Client)
		}
		if version.Version == "" || len(version.Version) > 128 {
			return finish("UnknownController", endpoint.Client)
		}
		var config vpnConfig
		if !vpnControllerJSON(ctx, client, base, endpoint.Secret, http.MethodGet, "/configs", nil, &config) {
			return finish("ControllerUnavailable", endpoint.Client)
		}
		if vpnConfigMatchesPort(config, port) {
			matches = append(matches, matchedController{endpoint: endpoint, client: client, base: base, config: config})
		}
	}
	if len(matches) == 0 {
		return finish("PortMismatch", "")
	}
	if len(matches) != 1 {
		return finish("AmbiguousController", "")
	}
	controller := matches[0]
	snapshot := vpnSnapshot{Config: controller.config}
	readRoutes := func(snapshot *vpnSnapshot) bool {
		var rules struct {
			Rules []vpnRule `json:"rules"`
		}
		var proxies struct {
			Proxies map[string]vpnProxy `json:"proxies"`
		}
		if !vpnControllerJSON(ctx, controller.client, controller.base, controller.endpoint.Secret, http.MethodGet, "/rules", nil, &rules) ||
			!vpnControllerJSON(ctx, controller.client, controller.base, controller.endpoint.Secret, http.MethodGet, "/proxies", nil, &proxies) {
			return false
		}
		snapshot.Rules, snapshot.Proxies = rules.Rules, proxies.Proxies
		return true
	}
	if !readRoutes(&snapshot) {
		return finish("ControllerUnavailable", controller.endpoint.Client)
	}
	analysis := analyzeVPNSnapshot(snapshot)
	if analysis.Status != "Ready" {
		return finish(analysis.Status, controller.endpoint.Client)
	}
	// 重读实际规则、选择和模式；用户操作或订阅变化后不覆盖原选择。
	recheck := vpnSnapshot{}
	if !readRoutes(&recheck) || !vpnControllerJSON(ctx, controller.client, controller.base, controller.endpoint.Secret, http.MethodGet, "/configs", nil, &recheck.Config) {
		return finish("ControllerUnavailable", controller.endpoint.Client)
	}
	if !vpnConfigMatchesPort(recheck.Config, port) || vpnStructureFingerprint(snapshot) != vpnStructureFingerprint(recheck) || analyzeVPNSnapshot(recheck) != analysis {
		return finish("ConcurrentChange", controller.endpoint.Client)
	}
	if !rootAlive() {
		return finish("RootExited", controller.endpoint.Client)
	}
	if ctx.Err() != nil {
		return finish("ControllerUnavailable", controller.endpoint.Client)
	}
	path := "/proxies/" + url.PathEscape(analysis.Selector)
	action = "SelectAutomatic"
	if !vpnControllerJSON(ctx, controller.client, controller.base, controller.endpoint.Secret, http.MethodPut, path, map[string]string{"name": analysis.Target}, nil) {
		// 传输失败也可能已被控制器处理；不重试、不自动反向写入。
		return finish("SelectionUnverified", controller.endpoint.Client)
	}
	if !rootAlive() {
		return finish("RootExited", controller.endpoint.Client)
	}
	var verified struct {
		Proxies map[string]vpnProxy `json:"proxies"`
	}
	if !vpnControllerJSON(ctx, controller.client, controller.base, controller.endpoint.Secret, http.MethodGet, "/proxies", nil, &verified) || verified.Proxies[analysis.Selector].Now != analysis.Target {
		return finish("SelectionUnverified", controller.endpoint.Client)
	}
	return finish("SelectedAutomatic", controller.endpoint.Client)
}

func vpnStructureFingerprint(snapshot vpnSnapshot) [32]byte {
	type proxyStructure struct {
		Type        string
		Now         string
		All         []string
		Fixed       *bool
		FixedChoice string
	}
	proxies := make(map[string]proxyStructure, len(snapshot.Proxies))
	for name, proxy := range snapshot.Proxies {
		proxies[name] = proxyStructure{Type: proxy.Type, Now: proxy.Now, All: proxy.All, Fixed: proxy.Fixed, FixedChoice: proxy.FixedChoice}
	}
	// JSON 确定性排列 map 键；节点名只参加进程内哈希，不进入日志或结果。
	encoded, _ := json.Marshal(struct {
		Config  vpnConfig
		Rules   []vpnRule
		Proxies map[string]proxyStructure
	}{Config: snapshot.Config, Rules: snapshot.Rules, Proxies: proxies})
	return sha256.Sum256(encoded)
}

func assistVPN(proxyURI, probeKind string) vpnAssistResult {
	return assistVPNForProcess(proxyURI, probeKind, nil)
}

func assistVPNForProcess(proxyURI, probeKind string, alive func() bool) vpnAssistResult {
	return assistVPNWithDeps(proxyURI, probeKind, vpnAssistDeps{
		Discover: discoverVPNControllers,
		HTTP:     vpnHTTPClient,
		Alive:    alive,
		Connect: func(ctx context.Context, address string) error {
			connection, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "tcp", address)
			if err == nil {
				_ = connection.Close()
			}
			return err
		},
	})
}

func vpnLocalProxy(uri string) (*url.URL, int, bool) {
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") || !vpnAssistLoopbackHost(parsed.Hostname()) {
		return nil, 0, false
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, 0, false
	}
	return parsed, port, true
}

func vpnAssistLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func vpnLocalControllerURL(base string, endpoint vpnEndpoint) bool {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") || !vpnAssistLoopbackHost(parsed.Hostname()) {
		return false
	}
	if endpoint.Pipe != "" || endpoint.Socket != "" {
		return parsed.Port() == ""
	}
	port, err := strconv.Atoi(parsed.Port())
	return err == nil && port > 0 && port <= 65535
}

func vpnConfigMatchesPort(config vpnConfig, port int) bool {
	return config.Port == port || config.MixedPort == port || config.MixedPortCamel == port
}

func vpnControllerJSON(ctx context.Context, original *http.Client, base, secret, method, path string, payload, output any) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(base, "/")+path, body)
	if err != nil {
		return false
	}
	if secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := *original
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	if client.Timeout <= 0 || client.Timeout > 5*time.Second {
		client.Timeout = 5 * time.Second
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	if output == nil {
		return true
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2<<20))
	if decoder.Decode(output) != nil {
		return false
	}
	var extra any
	return decoder.Decode(&extra) == io.EOF
}

func vpnClientLabel(client string) string {
	switch client {
	case "CFW", "QingShan", "ClashVerge", "Mihomo":
		return client
	default:
		return ""
	}
}

func vpnResult(status, action, client string) vpnAssistResult {
	messages := map[string]string{
		"NotApplicable":         "当前故障类别不触发代理辅助。",
		"UnsupportedProxy":      "只支持无账号的本机 HTTP 代理。",
		"LocalProxyUnavailable": "本机代理端口不可用，未调整远端策略。",
		"UnknownController":     "未确认受支持的本机代理控制器。",
		"ControllerUnavailable": "控制接口读取失败，未调整代理选择。",
		"PortMismatch":          "控制器代理端口与当前代理不一致。",
		"AmbiguousController":   "存在多个匹配控制器，未调整代理选择。",
		"UnknownRoute":          "无法确认 OpenAI 实际路由，未调整代理选择。",
		"NativeAutomatic":       "OpenAI 已使用原生自动策略，由代理核心处理。",
		"FixedSelection":        "当前选择已人工固定，保持不变。",
		"SharedSelector":        "代理选择组被共享或不是专用组，保持不变。",
		"ManualOnly":            "当前只有手动策略，需要预先配置专用自动组。",
		"NeedsSetup":            "现有自动组缺少安全条件，需检查固定状态和健康记录。",
		"ConcurrentChange":      "复核期间配置或选择发生变化，未覆盖当前选择。",
		"SelectionUnverified":   "已尝试接入自动策略，但结果未确认；未再次写入。",
		"SelectedAutomatic":     "已接入现有 OpenAI 专用自动策略。",
		"RootExited":            "宿主应用已退出，停止代理辅助，不再发起选择。",
	}
	message, known := messages[status]
	if !known {
		status, message = "UnknownRoute", messages["UnknownRoute"]
	}
	switch status {
	case "NotApplicable":
		status = "BlockedProbe"
	case "UnsupportedProxy":
		status = "InvalidProxy"
	case "UnknownController":
		status = "NoController"
	case "SharedSelector":
		status = "UnsafeSharedPolicy"
	case "FixedSelection":
		status = "ManualOverride"
	case "ConcurrentChange":
		status = "ChangedDuringCheck"
	}
	return vpnAssistResult{Status: status, Action: action, Client: vpnClientLabel(client), Message: message}
}
