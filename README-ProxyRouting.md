# Codex 固定代理入口

面板版启动 Codex 前准备仅监听 127.0.0.1 的 relay，将 Chromium 参数、CLI 代理环境与监视器指向同一入口。

~~~text
Codex / CLI / 检测器 → 固定本地入口 → 当前 VPN 的本机 HTTP 代理 → 网络
~~~

## 行为与边界

- 系统模式约每 3 秒只读检查当前 Windows 用户代理；上游变化后新连接采用新上游，客户端入口不变。
- 已建立连接保留原上游，不主动拆断。关闭旧 VPN 时旧流仍可能中断，需要客户端重连，不能无损迁移 TCP。
- -ProxyServerOverride 保持指定上游，不跟随系统代理。
- 系统代理关闭、读取失败或不支持时拒绝新连接，无直连回退，不修改系统代理、DNS、TUN 或 VPN。
- relay 解析路由所需 HTTP 头，不解密 TLS，不解析或记录请求/响应正文；日志与状态只含入口、上游、错误类别。状态接口只读、本机访问并核对随机身份。
- 监视器固定探测客户端入口，线路辅助采用核对后的真实上游。HTTP 响应与 TCP 建立只证明传输，不证明模型任务成功。

## 启用与恢复

旧 Codex 保留原启动参数。需要接入时先保存工作并正常退出，再由面板版入口打开；启动器不会关闭当前任务。

本目录 runtime\proxy-*\service.json 保留端口租约，使用期间不要当普通缓存删除。是否存活必须实时核对身份，不仅看文件存在。

relay 意外退出后再次启动入口，会确认 Codex 确实绑定该入口，再尝试原端口恢复；不重启 Codex。未接入旧会话只提示下次正常重开。

固定入口独立于网页，要求 Node.js 20+。关闭网页或 -NoPerformanceMonitor 不取消 Node 依赖。轻量版不含此入口，不需要 Node。

## WebSocket

部分 Codex 版本的 durable 云端 WebSocket 使用独立 Node socket 路径，可能不遵守 HTTP 代理参数。普通 relay 不能迫使它走代理；NODE_USE_ENV_PROXY=1 也不能保证覆盖显式连接函数。

本版未提供该路径的额外适配，不宣称所有 socket 已修复，不修改官方安装目录或安装包。

## 文件与验证

proxy-relay\relay.mjs 负责字节转发、上游刷新与状态；CodexProxyRelay.psm1 负责身份、互斥与恢复；启动器负责接入，Watch-CodexConnection.ps1 分层观测入口与上游。

源码隔离测试不修改真实系统代理，不启停 VPN/Codex，命令见仓库 docs/开发验证说明.md。切回轻量版前先正常退出使用该入口的 Codex，再从旧版独立目录启动，保留数据与日志。
