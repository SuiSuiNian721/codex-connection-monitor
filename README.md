# Codex 连接监测器

用一个本地网页查看 Codex 的网络状态、文字接收速度和每轮用量。启动器保留代理接入、缓存准备和后台连接监视。

## 新版能看什么

- **四项网络诊断**：分别查看本地网络、本地代理、VPN / 出口和 OpenAI 路径的检测结果、延迟与排查提示，也能回看最近的状态变化。
- **首 token 等待与每轮用量**：查看首 token 等了多久、整轮用了多久，以及输出和推理各用了多少 token。
- **正在接收的文字速度**：回答输出时，显示最近 3 秒收到文字的速度，单位为字符/s。
- **消息完成后的平均字速**：一条消息输出完后，查看它在输出阶段的平均字符/s。
- **并行任务独立查看**：按会话与轮次分别显示指标，选中后保持固定；列表默认最新优先，也可切换最早优先。
- **任务关键词检索**：按会话标题、子任务昵称、模型或编号查找当前采集记录；子任务会标明所属会话。
- **同模型趋势和历史记录**：按模型筛选，比较同模型最近 12 轮的整轮平均 token/s，并回看每轮的耗时、用量和消息均速。
- **关掉网页也继续采集**：启动 Codex 后在后台记录统计，需要看数据时再打开面板。
- **跟随系统代理变化**：系统代理地址改变后，经过启动器固定入口的新连接会使用新地址。

[![面板版介绍](https://raw.githubusercontent.com/SuiSuiNian721/codex-connection-monitor/2026.10.06-panel/media/poster.png)](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.06-panel/video2-panel-xiaoyi.mp4)

[视频 2：面板与测速](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.06-panel/video2-panel-xiaoyi.mp4) · [中文字幕](https://github.com/SuiSuiNian721/codex-connection-monitor/blob/2026.10.06-panel/media/subtitles.srt)

## 下载哪一版

需要网页面板和字速统计，下载面板版。只需要代理启动和后台连接监视，可以继续用轻量版。

| 版本 | 需要安装 | 下载 |
|---|---|---|
| 面板版 2026.10.06-panel | PowerShell 7、Node.js 20+ | [面板版 Windows ZIP](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.06-panel/Codex-Connection-Monitor-Panel-Windows-20261006.zip) |
| 轻量版 2026.10.02 | PowerShell 7 | [轻量版 Windows ZIP](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.02/Codex-Connection-Monitor-Windows-20261002.zip) |

两版都需要已安装并登录的 Windows 版 Codex，以及可用的本机系统代理。

## 面板版怎么用

1. 安装上表对应的软件，确认 `pwsh.exe` 和面板版需要的 `node.exe` 可用；打开自己的代理客户端并启用系统代理。
2. 将 ZIP 完整解压，双击「启动 Codex（代理）.cmd」，按 **1** 启动 Codex。
3. 想看数据时，再打开同一入口，按 **2** 查看面板；按 **0** 退出菜单。也可以直接双击「打开性能监测面板.cmd」。

实时字速从下一次通过面板版入口正常启动 Codex 开始记录。已有会话可以先查看历史数据；关闭网页不会停止后台采集。

更新已有面板版时，可将新版文件完整覆盖到原面板目录，再按 **2**；启动器会核对并更新独立监测后台。实时采集旁路的修复在下次正常启动 Codex 时生效。

两版分别解压到不同目录，仍共用原来的登录和聊天。换目录或版本时，先保存工作，正常退出 Codex 并结束旧面板服务，再从所选目录启动。

## 使用提示

- 面板顶部的状态表示网页与本地采集器是否连接；外部网络要看四项诊断结果。
- 两种字速都按本机收到的文字计算。实时卡按 3 秒窗口平滑，约每 250 毫秒读取；等待、完成、过期和来源未提供会分别说明，不用 0 冒充缺失值。
- 系统代理变化会影响新连接，已有连接仍可能需要重连。网络恢复后，请在 Codex 中确认任务是否继续。
- 统计在本机完成。监测器使用统计信息和已有会话标题，不另存聊天正文，也不额外调用模型。

[面板与统计说明](README-PerformanceMonitor.md) · [代理说明](README-ProxyRouting.md) · [恢复辅助说明](docs/恢复辅助说明.md) · [源码构建与验证](docs/开发验证说明.md) · [许可证](licenses)
