package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func showError(message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "Codex 未能启动。请检查代理客户端和 Codex 安装状态。"
	}
	if len([]rune(message)) > 1800 {
		message = string([]rune(message)[:1800]) + "…"
	}
	alert := exec.Command("/usr/bin/osascript",
		"-e", "on run argv",
		"-e", `display dialog (item 1 of argv) with title "Codex 代理启动器" buttons {"好"} default button "好" with icon stop`,
		"-e", "end run",
		message)
	_ = alert.Run()
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--vpn-assist" {
		if len(os.Args) != 4 && len(os.Args) != 6 {
			os.Exit(2)
		}
		var alive func() bool
		if len(os.Args) == 6 {
			pid, pidError := strconv.Atoi(os.Args[4])
			birth, birthError := strconv.ParseInt(os.Args[5], 10, 64)
			if pidError != nil || birthError != nil || pid <= 0 || birth <= 0 {
				os.Exit(2)
			}
			alive = func() bool { return vpnProcessAlive(pid, birth) }
		}
		if err := json.NewEncoder(os.Stdout).Encode(assistVPNForProcess(os.Args[2], os.Args[3], alive)); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--watch" {
		os.Exit(runWatch(os.Args[2:]))
	}
	executable, err := os.Executable()
	if err != nil {
		showError("无法定位启动器应用包。")
		os.Exit(1)
	}
	script := filepath.Clean(filepath.Join(filepath.Dir(executable), "..", "Resources", "Start-CodexWithProxy.command"))
	if _, err := os.Stat(script); err != nil {
		showError("应用包不完整：找不到代理启动脚本。请重新解压分享包。")
		os.Exit(1)
	}
	command := exec.Command("/bin/sh", script)
	output, err := command.CombinedOutput()
	if err != nil {
		showError(string(bytes.TrimSpace(output)))
		os.Exit(1)
	}
}
