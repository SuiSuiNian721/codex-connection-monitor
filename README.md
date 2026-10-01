# Codex 代理启动器与连接监测器

让等待有进度，让连接可诊断。

这套 Windows 启动器把启动前的代理检查、运行环境缓存准备和启动后的连接监测接在一起，减少看不见进度的等待和反复重启。

[![介绍视频封面](media/poster.png)](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.02/introduction-xiaoyi.mp4)

**[下载完整 Windows 分享包](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.02/Codex-Connection-Monitor-Windows-20261002.zip)** · [观看晓伊介绍视频](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.02/introduction-xiaoyi.mp4) · [中文字幕](media/subtitles.srt)

## 它改善哪些体验

- 更新后迟迟没有窗口：在 Codex 打开前显示运行环境准备进度、文件数量和耗时。
- 每次启动都重复准备：核对本地缓存；运行环境内容一致且缓存有效时直接复用。
- 代理开启了，应用却没有接入：读取可用的本机 HTTP/HTTPS 或 mixed 系统代理，将设置传给 Codex 和内置 CLI，无需开启 TUN。
- 双击多次或应用已经打开：避免重复启动，保留已有进程；更新后动态寻找当前安装路径。
- 网络短暂波动：持续探测本机代理和传输状态，保留 Codex 进程，等待客户端自然重连，恢复稳定后检查连接。
- 长时间传输故障：约 180 秒后，有条件评估兼容客户端中已存在的 OpenAI 专用自动策略；持续故障最多每 600 秒再次评估。
- 不知道故障出在哪里：日志区分本机代理不可用、超时、TLS、HTTP 限流及服务端响应，提供排查线索。

## 使用方法

1. 安装 PowerShell 7，并确认终端可以运行 `pwsh.exe`。
2. 安装并登录 Codex；自动查找适用于当前 Windows 账户下已注册的 `OpenAI.Codex` 应用包，不要求一定从 Microsoft Store 下载。未注册的安装版或便携版还需确认路径和运行环境兼容性。
3. 打开自己的代理客户端，启用系统代理，确认本机 HTTP/HTTPS 或 mixed 端口可用。
4. 解压分享包到自己可写的目录，双击 `启动 Codex（代理）.cmd`。
5. 等待终端显示准备进度。Codex 启动后，连接监测器在后台运行；Codex 退出后监测器结束。

首次使用时，若 Codex 已经打开，启动器会保留现有进程。需要应用这次代理设置时，先保存工作并正常退出 Codex，再使用此入口启动。

本包已包含自包含的 Windows `VpnRecoveryHelper.exe`，使用分享包无需安装 Go、Node 或 Python。Codex 应用、账户、代理线路与 PowerShell 7 需要自行准备。新版介绍视频在结尾前演示首次准备、完整解压并双击、日常启动这三段操作，片尾感谢观看与使用。视频单独提供，ZIP 不包含视频素材。

## 连接恢复的实际边界

监测器观察传输可达性，不读取任务内容，也不等同于模型任务健康检查。它等待 Codex 自身重连，不会关闭或重启 Codex，也不会自动重发任务。**连接恢复不等于原任务已经恢复；已失败任务能否继续，以客户端实际响应为准。**

线路辅助仅在受支持的本机控制接口、明确专用的 OpenAI 路由与已有自动策略满足条件时执行。共享组、人工固定节点、未知路由或缺少自动策略时只记录原因。403、429、5xx 和认证要求不会当作换线触发条件。详见 [恢复辅助说明](docs/恢复辅助说明.md)。

缓存复用对应 Windows 启动器的本地运行环境准备，不替代 Codex 更新下载。视频中的 14.5 秒与 1.5 秒是本机历史准备样本，不代表所有设备的完整启动耗时。视频界面和连接过程为示意动画，旁白使用微软在线中文女声晓伊 `zh-CN-XiaoyiNeural`。

## 日志与校验

运行后会在启动器目录产生 `launcher.log` 和 `connection-watchdog.log`。发布包不包含发送者的日志、状态、代理配置、订阅、登录凭据或运行环境缓存。

`package-manifest.json` 列出包内文件、大小与 SHA-256；Release 提供 `CHECKSUMS.sha256`。在 PowerShell 7 中可以核对下载文件：

```powershell
Get-FileHash -LiteralPath '.\Codex-Connection-Monitor-Windows-20261002.zip' -Algorithm SHA256
```

## 源码与验证

仓库保留 Windows 脚本、第三方许可及恢复 helper 对应 Go 源码。源码目录为 `macOS/native-launcher`，该目录沿用原工程命名，包含 Windows `--vpn-assist` 分支及测试。

从源码构建 Windows helper 需要 Go 1.24 或更新版本，在该源码目录运行：

```powershell
go test ./...
go build -trimpath -ldflags '-s -w' -o '..\..\VpnRecoveryHelper.exe' .
```

PowerShell 检查位于 `tests`，验证入口接线、缓存接线、监测状态、恢复门控和自然重连生命周期。这些检查使用静态解析或模拟状态，不会启动、关闭真实 Codex 或更改代理线路。

第三方许可位于 `licenses`。当前发布聚焦 Windows；尚未通过这一轮验证在真实任务断网条件下保证任务不中断。
