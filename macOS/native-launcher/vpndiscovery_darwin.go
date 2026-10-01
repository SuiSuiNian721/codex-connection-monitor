//go:build darwin

package main

import (
	"context"
	"net"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func collectVPNProcesses(ctx context.Context, port int) (vpnProcessSnapshot, error) {
	output, err := readVPNMacCommand(ctx, "/usr/sbin/lsof", "-nP", "-a", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-Fp")
	if err != nil {
		return vpnProcessSnapshot{}, errVPNDiscovery
	}
	ownerIDs := make(map[int]bool)
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, "p") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimPrefix(line, "p"))
		if err != nil || pid <= 0 {
			return vpnProcessSnapshot{}, errVPNDiscovery
		}
		ownerIDs[pid] = true
	}
	if len(ownerIDs) > 1 {
		return vpnProcessSnapshot{}, errVPNUnsupported
	}
	snapshot := vpnProcessSnapshot{}
	for pid := range ownerIDs {
		executable, err := readVPNMacCommand(ctx, "/bin/ps", "-ww", "-p", strconv.Itoa(pid), "-o", "comm=")
		if err != nil {
			return vpnProcessSnapshot{}, errVPNDiscovery
		}
		executable = strings.TrimSpace(executable)
		core := vpnCoreProcess{PID: pid, Name: filepath.Base(executable), Executable: executable}
		if !isVPNCoreName(core.Name) {
			snapshot.Owners = append(snapshot.Owners, core)
			continue
		}
		// The command line is inspected in memory only; it is never returned or logged.
		commandLine, err := readVPNMacCommand(ctx, "/bin/ps", "-ww", "-p", strconv.Itoa(pid), "-o", "args=")
		if err != nil {
			return vpnProcessSnapshot{}, errVPNDiscovery
		}
		flags, err := parseVPNCoreArguments(strings.TrimSpace(commandLine))
		if err != nil {
			return vpnProcessSnapshot{}, errVPNUnsupported
		}
		core.ConfigDir, core.ConfigFile = flags.ConfigDir, flags.ConfigFile
		core.Address, core.Pipe, core.Socket = flags.Address, flags.Pipe, flags.Socket
		ancestorID := pid
		visited := make(map[int]bool)
		for depth := 0; depth < 6; depth++ {
			parent, err := readVPNMacCommand(ctx, "/bin/ps", "-p", strconv.Itoa(ancestorID), "-o", "ppid=")
			if err != nil {
				break
			}
			ancestorID, err = strconv.Atoi(strings.TrimSpace(parent))
			if err != nil || ancestorID <= 1 || visited[ancestorID] {
				break
			}
			visited[ancestorID] = true
			app, err := readVPNMacCommand(ctx, "/bin/ps", "-ww", "-p", strconv.Itoa(ancestorID), "-o", "comm=")
			if err != nil {
				break
			}
			if client := vpnClientFromMacExecutable(strings.TrimSpace(app)); client != "" {
				core.Client, core.AppExecutable = client, strings.TrimSpace(app)
				break
			}
		}
		snapshot.Owners = append(snapshot.Owners, core)
	}
	if ctx.Err() != nil {
		return vpnProcessSnapshot{}, errVPNDiscovery
	}
	return snapshot, nil
}

func readVPNMacCommand(ctx context.Context, path string, arguments ...string) (string, error) {
	command := exec.CommandContext(ctx, path, arguments...)
	var output vpnCommandBuffer
	command.Stdout = &output
	if command.Run() != nil || ctx.Err() != nil {
		return "", errVPNDiscovery
	}
	return output.String(), nil
}

func vpnLocalDialer(endpoint vpnEndpoint) (func(context.Context) (net.Conn, error), error) {
	if endpoint.Pipe != "" || !filepath.IsAbs(endpoint.Socket) || strings.ContainsAny(endpoint.Socket, "\r\n\x00") {
		return nil, errVPNUnsupported
	}
	return func(ctx context.Context) (net.Conn, error) {
		dialer := &net.Dialer{Timeout: 2 * time.Second}
		connection, err := dialer.DialContext(ctx, "unix", endpoint.Socket)
		if err != nil {
			return nil, errVPNTransport
		}
		return connection, nil
	}, nil
}
