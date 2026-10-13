# Codex 连接监测器 · 轻量版

让 Codex 通过本机代理启动，显示运行环境准备进度，并在后台监视连接状态。轻量版只需 PowerShell 7，不需要单独安装 Node.js。

**[下载轻量版 2026.10.13-lite](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.13-lite/Codex-Connection-Monitor-Lite-Windows-20261013.zip)** · [面板版](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/tag/2026.10.13-panel) · [旧版下载](https://github.com/SuiSuiNian721/codex-connection-monitor/releases)

## 这次修复了什么

- **后台有进程，却没有窗口**：再次点击启动器，会请求显示 Codex 的已有窗口。
- **没有窗口也提示启动成功**：现在等到窗口可用才显示“窗口已打开”；等待时显示进度，超过 90 秒会明确提示启动未完成。
- **已经准备好的缓存被清掉**：启动器的 CLI 缓存改放独立目录，同一版本校验通过后继续复用。
- **启动太慢导致连接监测没建立**：窗口等待超时后，仍为核实属于本次启动的主进程保留连接监视。

已有进程和会话会保留。使用独立配置目录的窗口，请从该会话原来的入口打开。[完整更新说明](docs/2026.10.13-更新说明.md)

## 怎么用

1. 安装 PowerShell 7，确认能运行 `pwsh.exe`；安装并登录 Windows 版 Codex。
2. 打开自己的代理客户端，启用系统代理，确认本机 HTTP/HTTPS 或 mixed 端口可用。
3. 将 ZIP 完整解压到可写目录，双击「启动 Codex（代理）.cmd」。
4. 等待窗口打开。连接监视器在后台跟随运行，Codex 退出后结束。

从旧版更新时，可将新版完整解压到新目录。需要启用新版代理设置时，保存工作并正常退出 Codex，再从新版目录打开。两版继续共用原来的登录和聊天数据。

## 轻量版包含什么

代理检查与启动、运行环境准备进度、缓存复用、后台连接监视，以及符合条件时的线路恢复辅助。轻量版没有网页面板、文字测速或用量采集；需要这些功能可以选择面板版。

同版本的本地缓存可以复用；Codex 自身升级下载仍由应用处理。网络恢复后，请在 Codex 中确认任务是否继续；连接监视器不会自动重发任务。

[晓伊介绍视频](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.02/introduction-xiaoyi.mp4) · [恢复辅助说明](docs/恢复辅助说明.md) · [许可证](licenses)

运行日志写在解压目录的 `launcher.log` 和 `connection-watchdog.log`。发布包提供 `package-manifest.json` 和 `CHECKSUMS.sha256`，便于核对下载文件。
