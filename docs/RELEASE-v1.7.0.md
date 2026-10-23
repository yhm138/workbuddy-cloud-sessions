# v1.7.0 — 双击就能装

> 解压 → 双击 `安装.bat` → 扫码一次 → 重启客户端。不用装 Node，不用开终端。

## 下载

| 文件 | 说明 |
| --- | --- |
| `workbuddy-cloud-sessions-1.7.0-win-x64.zip`（35.7 MB） | Windows 10/11 x64 便携版，自带 Node 运行时 |

macOS / Linux 走源码安装，见 README 的「从源码安装」。

## 安装（三步）

1. **完全退出 WorkBuddy**：右下角托盘图标右键 → 退出。只关窗口不算。
2. **双击 `install.bat`**（或中文名的 `安装.bat`），按窗口里的提示走：
   - 第一次会弹出浏览器，用微信扫码登录一次网页版，登录态长期复用
   - 会问抓多少条会话，默认「最近 30 条」
3. 打开 WorkBuddy → 左侧菜单「云端会话」

卸载双击 `uninstall.bat`，会问顺带删不删登录态与正文。

## 这个版本做了什么

**一键安装向导（新增 `wbcs install`）**

把原来五条命令收成一个向导：找扩展目录 → 检查客户端是否退出 → 复用/触发登录 →
抓正文 → 构建 → 部署。每一步都有中文提示，出错告诉你怎么修（需要管理员权限、
找不到客户端目录、登录失效……都是可执行的下一步，不是栈信息）。

**浏览器兜底，不再强制下载 Chromium**

`npx playwright install chromium` 这一步对小白来说等于装不上。现在按
系统 Chrome → 系统 Edge → 本机 `ms-playwright` 里已有的 Chromium → 自带 的顺序尝试，
第一次成功的选择会记下来，避免 Edge/Chrome 混用同一个 profile 导致 cookie 读不出。

**便携运行时**

安装包内置 `node.exe`（22.22.2，含 `node:sqlite`），解包 101 MB / 压缩 35.7 MB。
数据（登录态 + 正文）放在 `%LOCALAPPDATA%\wbcs`，换新版重装不会丢。

**发布流程可复现**

`npm run release` 一条命令打出 zip + sha256；打包脚本会拒绝把本地 `ui/data.js`、
`ui/full/`（真实会话）打进安装包。

## 校验

```text
sha256  见 .zip.sha256 附件
```

PowerShell：`Get-FileHash .\workbuddy-cloud-sessions-1.7.0-win-x64.zip -Algorithm SHA256`

## 系统要求

- Windows 10 / 11 x64
- WorkBuddy 桌面端（已登录过一次，用于生成本地 `workbuddy.db`）
- 系统里有 Chrome 或 Edge（Windows 自带 Edge）
- 客户端装在 `C:\Program Files` 下时，需要右键「以管理员身份运行」

## 已知限制

- 面板显示的是**抓取时的快照**，不是实时云端。要看最新，点「回到会话」让客户端自己回放
- 定时任务类会话通常只有任务定义、没有对话记录
- 只在 Windows 上实测；macOS / Linux 的扩展目录探测已实现但未实机验证
- 扩展装在客户端目录里，客户端升级后可能被覆盖，重跑一次 `install.bat` 即可
