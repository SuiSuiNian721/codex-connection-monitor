//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Microsoft/go-winio"
)

// This script never emits command lines or credentials. Only the active listener,
// its runtime paths, and its running application's ancestor are returned.
const vpnWindowsProcessScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$port = __VPN_PORT__
function Read-CoreFlags([string]$line) {
    $result = @{ ConfigDir = ''; ConfigFile = ''; Address = ''; Pipe = ''; Socket = ''; InvalidArgs = $false }
    $known = @{ '-d' = 'ConfigDir'; '-f' = 'ConfigFile'; '-ext-ctl' = 'Address'; '-ext-ctl-pipe' = 'Pipe'; '-ext-ctl-unix' = 'Socket' }
    $seen = @{}
    $matches = [regex]::Matches($line, '(?:^|\s)(-d|-f|-ext-ctl-pipe|-ext-ctl-unix|-ext-ctl)(?:\s+|=)(?:"([^"]*)"|''([^'']*)''|([^\s]+))')
    foreach ($match in $matches) {
        $flag = $match.Groups[1].Value
        if ($seen.ContainsKey($flag)) { $result.InvalidArgs = $true; continue }
        $seen[$flag] = $true
        $value = if ($match.Groups[2].Success) { $match.Groups[2].Value } elseif ($match.Groups[3].Success) { $match.Groups[3].Value } else { $match.Groups[4].Value }
        if ($value -match '[\r\n\x00]' -or $value.StartsWith('-')) { $result.InvalidArgs = $true; continue }
        if ($flag -eq '-ext-ctl' -and $value -ne '' -and $value -notmatch '^(?:http://)?(?:localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|\[::1\]):[0-9]+$') { $result.InvalidArgs = $true; continue }
        if ($flag -eq '-ext-ctl-pipe' -and $value -ne '' -and $value -cne '\\.\pipe\MihomoParty\mihomo') { $result.InvalidArgs = $true; continue }
        $result[$known[$flag]] = $value
    }
    foreach ($flag in $known.Keys) {
        if ($line -match ('(?:^|\s)' + [regex]::Escape($flag) + '(?:\s|=|$)') -and -not $seen.ContainsKey($flag)) { $result.InvalidArgs = $true }
    }
    return $result
}
try {
    $listenerIds = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($listenerIds.Count -gt 16) { exit 1 }
    $owners = @()
    foreach ($ownerId in $listenerIds) {
        $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$ownerId)
        if ($null -eq $process) { exit 1 }
        $owner = @{ PID = [int]$ownerId; Name = [string]$process.Name; Executable = [string]$process.ExecutablePath; AppExecutable = ''; Client = ''; ConfigDir = ''; ConfigFile = ''; Address = ''; Pipe = ''; Socket = ''; InvalidArgs = $false }
        if ($process.Name -match '^(?:clash|clash-core|clash-win64(?:-[A-Za-z0-9_.-]+)?|mihomo(?:-windows-[A-Za-z0-9_.-]+)?|clash-meta(?:-[A-Za-z0-9_.-]+)?)\.exe$') {
            $flags = Read-CoreFlags ([string]$process.CommandLine)
            foreach ($key in $flags.Keys) { $owner[$key] = $flags[$key] }
            $ancestorId = [int]$process.ParentProcessId
            $visited = @{}
            for ($depth = 0; $depth -lt 6 -and $ancestorId -gt 0; $depth++) {
                if ($visited.ContainsKey($ancestorId)) { break }
                $visited[$ancestorId] = $true
                $ancestor = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $ancestorId)
                if ($null -eq $ancestor) { break }
                if ($ancestor.Name -ieq '青山.exe' -or $ancestor.Name -ieq 'QingShan.exe') { $owner.Client = 'QingShan'; $owner.AppExecutable = [string]$ancestor.ExecutablePath; break }
                if ($ancestor.Name -ieq 'Clash for Windows.exe') { $owner.Client = 'CFW'; $owner.AppExecutable = [string]$ancestor.ExecutablePath; break }
                $ancestorId = [int]$ancestor.ParentProcessId
            }
        }
        $owners += $owner
    }
    @{ Owners = @($owners) } | ConvertTo-Json -Depth 4 -Compress
} catch { exit 1 }
`

func collectVPNProcesses(ctx context.Context, port int) (vpnProcessSnapshot, error) {
	script := bytes.ReplaceAll([]byte(vpnWindowsProcessScript), []byte("__VPN_PORT__"), []byte(strconv.Itoa(port)))
	root := os.Getenv("SystemRoot")
	if root == "" || !filepath.IsAbs(root) {
		return vpnProcessSnapshot{}, errVPNDiscovery
	}
	command := exec.CommandContext(ctx, filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", string(script))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var output vpnCommandBuffer
	command.Stdout = &output
	if command.Run() != nil || ctx.Err() != nil {
		return vpnProcessSnapshot{}, errVPNDiscovery
	}
	var snapshot vpnProcessSnapshot
	decoder := json.NewDecoder(bytes.NewReader(output.Bytes()))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&snapshot) != nil {
		return vpnProcessSnapshot{}, errVPNDiscovery
	}
	return snapshot, nil
}

func vpnLocalDialer(endpoint vpnEndpoint) (func(context.Context) (net.Conn, error), error) {
	if !vpnLocalPipePath(endpoint.Pipe) || endpoint.Socket != "" {
		return nil, errVPNUnsupported
	}
	return func(ctx context.Context) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		connection, err := winio.DialPipeContext(ctx, endpoint.Pipe)
		if err != nil {
			return nil, errVPNTransport
		}
		return connection, nil
	}, nil
}

func vpnLocalPipePath(path string) bool {
	const prefix = `\\.\pipe\`
	if !strings.HasPrefix(path, prefix) || strings.ContainsAny(path, "/:\r\n\x00") {
		return false
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, prefix), `\`) {
		if component == "" || component == "." || component == ".." {
			return false
		}
	}
	return true
}
