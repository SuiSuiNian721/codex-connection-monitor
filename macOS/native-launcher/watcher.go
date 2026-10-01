package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func watchLog(message string) {
	dir, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir = filepath.Join(dir, "Library", "Logs", "CodexProxyLauncher")
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	path := filepath.Join(dir, "watch.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 1024*1024 {
		_ = os.Rename(path, path+".1")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintf(file, "%s %s\n", time.Now().Format(time.RFC3339), message)
}

func processExists(pid int) bool {
	return exec.Command("/bin/kill", "-0", strconv.Itoa(pid)).Run() == nil
}

func appProcessExists(pid int, appPath, executableName string) bool {
	if !processExists(pid) {
		return false
	}
	output, err := exec.Command("/bin/ps", "-ww", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	return err == nil && filepath.Clean(strings.TrimSpace(string(output))) == filepath.Join(appPath, "Contents", "MacOS", executableName)
}

func systemProxy() string {
	output, err := exec.Command("/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return ""
	}
	return parseSystemProxy(string(output))
}

func parseSystemProxy(settings string) string {
	fields := make(map[string]string)
	for _, line := range strings.Split(settings, "\n") {
		parts := strings.Fields(line)
		if len(parts) == 3 && parts[1] == ":" {
			fields[parts[0]] = parts[2]
		}
	}
	for _, prefix := range []string{"HTTPS", "HTTP"} {
		if fields[prefix+"Enable"] != "1" {
			continue
		}
		host, port := fields[prefix+"Proxy"], fields[prefix+"Port"]
		if host == "127.0.0.1" || host == "localhost" {
			if parsed, err := strconv.Atoi(port); err == nil && parsed > 0 && parsed <= 65535 {
				return "http://" + host + ":" + port
			}
		}
	}
	return ""
}

func probeProxy(uri string) bool {
	return probeProxyAt(uri, "https://chatgpt.com/favicon.ico")
}

func probeProxyAt(uri, target string) bool {
	return probeProxyStatusAt(uri, target).Reachable
}

type proxyProbeStatus struct {
	Reachable    bool
	LocalHealthy bool
	Kind         string
}

func probeProxyStatusAt(uri, target string) proxyProbeStatus {
	result := proxyProbeStatus{Kind: "InvalidProxy"}
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return result
	}
	if host := parsed.Hostname(); host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return result
	}
	connection, err := net.DialTimeout("tcp", parsed.Host, 2*time.Second)
	if err != nil {
		result.Kind = "LocalProxyUnavailable"
		return result
	}
	_ = connection.Close()
	result.LocalHealthy = true
	connectStatus := 0
	transport := &http.Transport{
		Proxy:                 http.ProxyURL(parsed),
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 7 * time.Second,
		OnProxyConnectResponse: func(_ context.Context, _ *url.URL, _ *http.Request, response *http.Response) error {
			connectStatus = response.StatusCode
			return nil
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequest(http.MethodHead, target, nil)
	if err != nil {
		result.Kind = "InvalidTarget"
		return result
	}
	response, err := client.Do(request)
	if err != nil {
		if connectStatus != 0 && connectStatus != http.StatusOK {
			result.Kind = "ProxyHttpRestricted"
			switch {
			case connectStatus == http.StatusProxyAuthRequired:
				result.Kind = "ProxyAuthenticationRequired"
			case connectStatus == http.StatusTooManyRequests:
				result.Kind = "ProxyRateLimited"
			case connectStatus >= 500:
				result.Kind = "ProxyServerError"
			}
			return result
		}
		result.Kind = "RequestFailure"
		var netError net.Error
		var dnsError *net.DNSError
		var opError *net.OpError
		var certError *tls.CertificateVerificationError
		var unknownAuthority x509.UnknownAuthorityError
		var recordError tls.RecordHeaderError
		switch {
		case errors.As(err, &netError) && netError.Timeout():
			result.Kind = "Timeout"
		case errors.As(err, &dnsError):
			result.Kind = "NameResolutionFailure"
		case errors.As(err, &certError) || errors.As(err, &unknownAuthority) || errors.As(err, &recordError):
			result.Kind = "TlsFailure"
		case errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF):
			result.Kind = "ConnectionFailure"
		case errors.As(err, &opError):
			result.Kind = "ConnectionFailure"
		}
		return result
	}
	defer response.Body.Close()
	result.Reachable = true
	result.Kind = "HttpResponse"
	switch {
	case response.StatusCode == http.StatusProxyAuthRequired:
		result.Reachable = false
		result.Kind = "ProxyAuthenticationRequired"
	case response.StatusCode == http.StatusTooManyRequests:
		result.Kind = "RateLimited"
	case response.StatusCode >= 500:
		result.Kind = "ServerError"
	case response.StatusCode >= 400:
		result.Kind = "HttpRestricted"
	}
	return result
}

func appConnections(pid int, proxyURI string) bool {
	parsed, err := url.Parse(proxyURI)
	if err != nil {
		return false
	}
	port := parsed.Port()
	if port == "" {
		return false
	}
	output, err := exec.Command("/bin/ps", "-axo", "pid=,ppid=").Output()
	if err != nil {
		return false
	}
	all := map[int]int{}
	for _, line := range strings.Split(string(output), "\n") {
		var child, parent int
		if _, err := fmt.Sscan(line, &child, &parent); err == nil {
			all[child] = parent
		}
	}
	children := map[int]bool{pid: true}
	for changed := true; changed; {
		changed = false
		for child, parent := range all {
			if children[parent] && !children[child] {
				children[child] = true
				changed = true
			}
		}
	}
	ids := make([]string, 0, len(children))
	for child := range children {
		ids = append(ids, strconv.Itoa(child))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err = exec.CommandContext(ctx, "/usr/sbin/lsof", "-nP", "-a", "-p", strings.Join(ids, ","), "-iTCP:"+port, "-sTCP:ESTABLISHED").Output()
	if err != nil {
		return false
	}
	return proxyConnectionIn(string(output), proxyURI)
}

func proxyConnectionIn(output, proxyURI string) bool {
	parsed, err := url.Parse(proxyURI)
	if err != nil || parsed.Port() == "" {
		return false
	}
	for _, line := range strings.Split(output, "\n") {
		arrow := strings.LastIndex(line, "->")
		if arrow < 0 || !strings.HasSuffix(strings.TrimSpace(line), " (ESTABLISHED)") {
			continue
		}
		remote := strings.Fields(line[arrow+2:])
		if len(remote) == 0 {
			continue
		}
		host, port, err := net.SplitHostPort(remote[0])
		if err != nil || port != parsed.Port() {
			continue
		}
		if host == parsed.Hostname() || (parsed.Hostname() == "localhost" && (host == "127.0.0.1" || host == "::1")) {
			return true
		}
	}
	return false
}

func notifyConnectionRecovery() {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/osascript",
		"-e", "on run argv",
		"-e", `display dialog (item 1 of argv) with title "Codex 连接提醒" buttons {"好"} default button "好" giving up after 15 with icon note`,
		"-e", "end run",
		"代理已经稳定恢复，但尚未检测到 Codex 到代理的连接。启动器会继续检查，并等待 Codex 自然重连。此提醒仅提供连接状态。")
	if err := command.Run(); err != nil {
		watchLog("连接提醒未显示，继续等待自然重连")
	}
}

func runWatch(args []string) int {
	if len(args) != 5 {
		return 2
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil || pid <= 0 {
		return 2
	}
	proxyURI, mode, appPath, executableName := args[1], args[2], args[3], args[4]
	if mode != "manual" && mode != "system" {
		return 2
	}
	if _, err := url.ParseRequestURI(proxyURI); err != nil {
		return 2
	}
	state := newWatchState(proxyURI)
	lastNotification := time.Time{}
	nextProbe := time.Time{}
	lastHealthy := true
	lastVPNAttempt := time.Time{}
	vpnFailureSince := time.Time{}
	lastVPNFailureProxy := ""
	watchLog("监视器已启动，随 Codex 进程退出；不修改系统代理")
	watchLog("长期故障辅助：180 秒传输硬故障后检查现有自动策略，600 秒冷却；不改共享节点、不重载 VPN")
	for appProcessExists(pid, appPath, executableName) {
		now := time.Now()
		activeProxy := proxyURI
		if mode == "system" {
			activeProxy = systemProxy()
		}
		if now.Before(nextProbe) {
			time.Sleep(3 * time.Second)
			continue
		}
		probe := proxyProbeStatus{Kind: "SystemProxyUnavailable"}
		if activeProxy != "" {
			probe = probeProxyStatusAt(activeProxy, "https://chatgpt.com/favicon.ico")
		}
		healthy := probe.Reachable
		now = time.Now()
		if healthy != lastHealthy {
			watchLog(fmt.Sprintf("代理可用性变化: healthy=%t", healthy))
		}
		lastHealthy = healthy
		action := state.observe(now, healthy, activeProxy)
		switch action {
		case watchLongOutage:
			watchLog("代理连续约 180 秒不可用，等待稳定恢复；ProbeKind=" + probe.Kind)
			if !probe.LocalHealthy {
				watchLog("本地 VPN 代理端口未监听；不能通过切远端节点修复，未启动或重载 VPN")
			}
		case watchEvaluateRecovery:
			watchLog("代理已稳定恢复，检查 Codex 到代理的连接")
			if appConnections(pid, activeProxy) {
				watchLog("检测到 Codex 到代理的连接，继续运行")
				state.markRecovered(activeProxy)
			} else if notificationAllowed(lastNotification, now) {
				lastNotification = now
				watchLog("尚未检测到 Codex 连接，仅提醒并继续等待自然重连")
				notifyConnectionRecovery()
				state.deferRecovery(time.Now())
			} else {
				state.deferRecovery(now)
			}
		}
		vpnFailureSince = observeVPNHardFailure(vpnFailureSince, now, probe.Kind, probe.LocalHealthy, activeProxy, lastVPNFailureProxy)
		lastVPNFailureProxy = activeProxy
		if os.Getenv("CODEX_VPN_ASSIST_DISABLED") != "1" && !state.proxyChanged && shouldAssistVPN(now, lastVPNAttempt, vpnFailureSince, state.longOutage, activeProxy, state.proxy, probe.Kind, probe.LocalHealthy) {
			lastVPNAttempt = time.Now()
			result := assistVPNForProcess(activeProxy, probe.Kind, func() bool { return appProcessExists(pid, appPath, executableName) })
			watchLog("VPN 长故障辅助：Status=" + result.Status + " Action=" + result.Action + " Client=" + result.Client + "；" + result.Message)
		}
		if state.longOutage || (healthy && ((!state.proxyChanged) || !state.retryAfter.IsZero())) {
			nextProbe = time.Now().Add(30 * time.Second)
		} else {
			nextProbe = time.Now().Add(3 * time.Second)
		}
		time.Sleep(3 * time.Second)
	}
	watchLog("Codex 已退出，监视器结束")
	return 0
}
