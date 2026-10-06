# Codex 连接监测器：轻量版与面板版

同一个仓库通过不同版本标签与 Release 提供两套 Windows 包。**轻量版继续保留，面板版独立发布。**

| 版本 | 环境 | 功能 | 下载 |
|---|---|---|---|
| 轻量版 2026.10.02 | PowerShell 7；无 Node.js 依赖 | 代理启动、运行环境缓存、后台连接监视 | [轻量版 Windows ZIP](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.02/Codex-Connection-Monitor-Windows-20261002.zip) |
| 面板版 2026.10.06-panel | PowerShell 7 + Node.js 20 或更新版本 | 保留连接监视，新增统一菜单、网络诊断、字速、耗时与用量、历史趋势、固定代理入口 | [面板版 Windows ZIP](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.06-panel/Codex-Connection-Monitor-Panel-Windows-20261006.zip) |

两版都需要自己的 Codex 账户、当前 Windows 账户下已注册的 OpenAI.Codex 应用，以及可用的本机 HTTP/HTTPS 或 mixed 系统代理。面板版没有额外 npm 运行依赖。

[![面板版介绍](media/poster.png)](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.06-panel/video2-panel-xiaoyi.mp4)

[视频 2：面板与测速](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/download/2026.10.06-panel/video2-panel-xiaoyi.mp4) · [中文字幕](media/subtitles.srt) · [面板版 Release](https://github.com/SuiSuiNian721/codex-connection-monitor/releases/tag/2026.10.06-panel)

## 面板版使用

1. 安装 PowerShell 7 和 Node.js 20+，确认 pwsh.exe 与 node.exe 在 PATH 中。
2. 安装并登录 Codex，打开自己的代理客户端并启用系统代理。
3. 将 ZIP 完整解压到可写的独立目录。
4. 双击「启动 Codex（代理）.cmd」，按 1 启动；后台连接监视与性能采集自动跟随。
5. 要看数据时再次双击同一入口并按 2；按 0 退出。关闭网页不影响采集。

「打开性能监测面板.cmd」也可直接进入面板。查看面板复用已有服务，不重启当前 Codex 或 VPN。顶部绿灯只表示网页连接到了本地采集器，外部网络由四项诊断分别显示。

固定本地代理入口使新连接跟随系统代理上游。显式上游保持固定；已建立的 TCP 流不能无损迁移，独立 WebSocket socket 路径也不保证遵从 HTTP 代理。详见 [代理行为与边界](README-ProxyRouting.md)。

## 两版如何隔离

两个 ZIP 的包名、解压目录、版本标签不同，下载新版不覆盖旧版。切回轻量版时，先保存工作并正常退出 Codex，再从轻量版目录启动。

**两版默认共享既有 Codex 登录与聊天数据，不是两个独立 Codex 环境，也不应同时启动两套应用。** 已运行应用保留原启动参数，另一版入口不会替换参数或关闭它。面板服务按 Codex 数据目录复用已有服务，连接入口与状态留在各自目录。分享包不复制用户数据。

实时采集在下一次通过面板版入口正常启动时接入；旧会话可继续聊天和查看已完成历史，无需立即退出。-NoPerformanceMonitor 仅跳过本次自动采集接入，不停止已运行服务，也不取消固定入口的 Node.js 依赖。

## 数据与隐私

- 四步诊断显示本地网络、本地代理、VPN / 出口和 OpenAI 路径。403、429、5xx 是收到的 HTTP 响应，不直接等于断网或模型健康。
- 首 token 与用量采用本机已有记录。整轮 token/s 含思考、工具和等待，不是纯生成速度。
- 消息阶段均速按已完成消息生命周期计算；实时接收速度按最近 3 秒收到的 Unicode 码点计算，两项均为字符/s。缺失、过期、未接入时显示原因，不伪造 0。详见 [性能监测说明](README-PerformanceMonitor.md)。
- 面板只监听 127.0.0.1，无第三方资源，HTTP 只读。采集会解析本地日志和输出增量，仅保存时间、计数、模型与状态元数据，不复制或持久化聊天/工具正文，不额外调用模型。网络诊断会发送少量无账户认证的 HEAD 探测。

监视器等待客户端自身重连，不关闭/重启 Codex，不自动重发任务。长时间传输故障只在受支持本机控制器及已有专用自动策略满足条件时评估线路辅助；HTTP 限制和认证不触发换线。详见 [恢复辅助说明](docs/恢复辅助说明.md)。

运行后本目录生成日志与 runtime 状态。发布包不含发送者日志、会话、代理订阅、认证、缓存或诊断。固定入口状态保留端口租约，使用期间不要当普通缓存删除。

## 校验与验证范围

package-manifest.json 列出文件、大小、SHA-256；Release 提供 CHECKSUMS.sha256：

~~~powershell
Get-FileHash -LiteralPath '.\Codex-Connection-Monitor-Panel-Windows-20261006.zip' -Algorithm SHA256
~~~

功能在开发阶段已通过隔离日志、假 CLI、本地套接字和浏览器夹具验收；未额外调用模型。发布包另做语法、编码、清单、复制与 ZIP 读回校验。**未测试真实任务断网后的连续性；传输恢复不保证原任务恢复。**

ZIP 含编译后的 Windows helper 与实时转接器，无需 Go、C++、Python、Playwright。源码构建与验收见 [仓库开发验证说明](https://github.com/SuiSuiNian721/codex-connection-monitor/blob/2026.10.06-panel/docs/开发验证说明.md)。仅源码提供的旁路热恢复维护工具要求 Node.js 22+，不包含在日常 ZIP 中。原生转接器使用 GCC/MinGW-w64 构建，相关原文许可与 [GCC 运行时异常](https://www.gnu.org/licenses/gcc-exception-3.1.html)随包置于 licenses。

视频 2 使用 Q 版串场、真实面板和晓伊配音，动态数值标为示意；视频作为独立附件，ZIP 不含视频。
