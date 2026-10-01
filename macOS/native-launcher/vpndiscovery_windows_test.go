//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func TestVPNWindowsReadOnlyFlagScriptQuotedPathsAndNoSecret(t *testing.T) {
	end := strings.Index(vpnWindowsProcessScript, "\ntry {")
	if end < 0 {
		t.Fatal("fixture extraction failed")
	}
	prefix := strings.Replace(vpnWindowsProcessScript[:end], "__VPN_PORT__", "7890", 1)
	fixtures := []struct {
		line, dir, file, pipe string
		invalid               bool
	}{
		{line: `mihomo.exe -d "C:\Users\fixture\App Data" -f "C:\Users\fixture\runtime config.yaml" -ext-ctl 127.0.0.1:9090 -secret fixture-private`, dir: `C:\Users\fixture\App Data`, file: `C:\Users\fixture\runtime config.yaml`},
		{line: `mihomo.exe -ext-ctl-pipe \\.\pipe\MihomoParty\mihomo -secret fixture-private`, pipe: qingShanControllerPipe},
		{line: `mihomo.exe -ext-ctl http://user:fixture-private@127.0.0.1:9090`, invalid: true},
		{line: `mihomo.exe -ext-ctl 0.0.0.0:9090`, invalid: true},
		{line: `mihomo.exe -d first -d second`, invalid: true},
		{line: `mihomo.exe -ext-ctl`, invalid: true},
	}
	for index, fixture := range fixtures {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		script := prefix + "\nRead-CoreFlags '" + strings.ReplaceAll(fixture.line, "'", "''") + "' | ConvertTo-Json -Compress"
		command := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
		output, err := command.Output()
		cancel()
		if err != nil {
			t.Fatal("read-only flag fixture script failed")
		}
		if bytes.Contains(output, []byte("fixture-private")) {
			t.Fatal("secret escaped from flag extraction script")
		}
		var flags vpnCoreProcess
		if json.Unmarshal(output, &flags) != nil || flags.InvalidArgs != fixture.invalid || (!fixture.invalid && (flags.ConfigDir != fixture.dir || flags.ConfigFile != fixture.file || flags.Pipe != fixture.pipe)) {
			t.Fatalf("PowerShell flag fixture %d extraction mismatch: %s", index, output)
		}
	}
}

func TestVPNWindowsTransportUsesOnlyLocalFixturePipe(t *testing.T) {
	pipe := `\\.\pipe\codex-vpn-fixture-` + strconv.FormatInt(time.Now().UnixNano(), 10)
	listener, err := winio.ListenPipe(pipe, nil)
	if err != nil {
		t.Fatal("unable to create isolated fixture pipe")
	}
	defer listener.Close()
	requests := make(chan bool, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests <- request.Header.Get("Authorization") == "Bearer fixture-private"
		w.WriteHeader(http.StatusOK)
	})}
	defer server.Close()
	go server.Serve(listener)
	client, base, err := vpnHTTPClient(vpnEndpoint{Client: "QingShan", Pipe: pipe, Secret: "fixture-private"})
	if err != nil {
		t.Fatal("isolated local fixture pipe transport rejected")
	}
	request, err := http.NewRequest(http.MethodGet, base+"/configs", nil)
	if err != nil {
		t.Fatal("fixture request failed")
	}
	request.Header.Set("Authorization", "Bearer fixture-private")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("local fixture pipe request failed")
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !<-requests {
		t.Fatal("fixture pipe request/authentication mismatch")
	}
	for _, remote := range []string{`\\remote\pipe\fixture`, `\\.\pipe\..\fixture`, `\\.\pipe\`, "private-pipe"} {
		if _, _, err := vpnHTTPClient(vpnEndpoint{Pipe: remote}); err == nil {
			t.Fatal("unsafe named pipe namespace accepted")
		}
	}
}
