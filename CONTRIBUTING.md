# 参与开发

欢迎 issue、PR、以及「我这里也复现了」的确认。这个项目是逆着客户端行为做出来的，**任何一个版本差异都可能有价值**，别怕报得太细。

---

## 先看这三份

| 你想改 | 先读 |
| --- | --- |
| 面板 UI / 交互 | [README](README.md) 的「只读边界」——这条不能破 |
| service / 抓取 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（分层与契约） |
| 协议 / 宿主通道 | [docs/PROTOCOL.md](docs/PROTOCOL.md)（字段与时序的事实清单） |

---

## 本地环境

- Node **18+**；跑 `fetch` / `build` 建议 **22+**（读库用的是内置 `node:sqlite`，18 没有）
- Windows 是主战场（已实测）；macOS / Linux 的扩展目录探测写了但没实测，欢迎回报
- 不需要全局装任何东西，`npm install` 后 `node bin/wbcs.js` 就是入口

```bash
git clone https://github.com/yhm138/workbuddy-cloud-sessions.git
cd workbuddy-cloud-sessions
npm install
node bin/wbcs.js --help
```

---

## 三条自测（提 PR 前请全绿）

```bash
npm test                 # guest-ready 握手自检（真实 Chrome/Edge）
npm run test:service     # service 端到端（假网关，不联网、不用登录）
npm run test:panel       # 面板 + service 联调（Playwright 假宿主）
NO_SERVICE=1 npm run test:panel   # 强制降级路径
```

前两条纯 Node；第三条需要一个能启动的 Chromium（`npx playwright install chromium`）。

**这两个测试替身很有用，改代码前先认识它们：**

- `test/mock-gateway.cjs` —— 假 ACP 网关：`/session` 发票据、SSE 回放固定事件流。**任意 id 都有正文**（只有 `nope` 走 404），这样可以测小程序来源、空会话等各种分支。
- `test/panel-service.js` + `test/host.html` —— 假宿主：把 `ui/index.html` 塞进 iframe，用 `postMessage` 模拟 `$resolveLocalRpc` / `$invokeLocalRpcFallback`。**注意它按真实约定传参**：`fn({callerId: undefined}, payload)`，第一个参数永远是 context。

---

## 代码约定

**1. 面板零依赖、无构建。**
`ui/index.html` 是单文件原生 JS。不要引入框架、不要加打包步骤 —— 它要能在客户端的 iframe 里直接跑。

**2. 面板永远不直接联网。**
CORS 决定了它连不上网关。需要网络能力，就在 `server/index.cjs` 加一个方法，再从面板调。

**3. `server/` 是唯一实现。**
`src/acp.js` / `src/parse.js` 只做转发，别在 `src/` 里改逻辑 —— v1.9 就是因为两份代码跑偏，修了一份另一份继续错。

**4. 只读。**
不改 `workbuddy.db`、不改 `app.asar`（改二进制会让客户端启动闪退，试过了）。唯一写入的目录是扩展目录。

**5. 消息字段用短键。**
`{r,t,k,n,s,i,o}` 是为了压 IPC 体积，不是随手写的。加字段前先想清楚会不会让单条会话过大。

**6. 降级必须可见。**
任何「这可能不是最新 / 不完整」的状态，都要在界面上明确标出来，不允许静默。

---

## 改完先自检

面板脚本是内联的，`node --check` 不认 HTML，用这条抽出来检查：

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('ui/index.html','utf8');
const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
fs.writeFileSync('.cache/ui-check.js', m[m.length-1][1]);" && node --check .cache/ui-check.js
```

清单一致性（CI 也会跑）：

```bash
node -e "const a=require('./extension.json'),b=require('./distribution.json'),p=require('./package.json');
if(a.version!==p.version||a.version!==b.version) throw new Error('版本不一致');
if(require('./server/index.cjs').VERSION!==p.version) throw new Error('server VERSION 不一致');
console.log('ok', p.version);"
```

---

## 版本与发布

1. 五处同步版本号：`package.json`、`extension.json`、`distribution.json`、`server/index.cjs` 的 `VERSION`、`ui/index.html` 的 `PAGE_VERSION`
2. 写发布说明到 `docs/releases/RELEASE-v<版本>.md`，并在 `CHANGELOG.md` 顶部加一节
3. 部署到本机验证：`node bin/wbcs.js deploy --force`，然后**托盘退出客户端**再打开
4. 打包：`npm run release`（内置 zip 写入器，产物在 `dist/`，校验 `.sha256`）
5. 打 tag、发 Release、上传 zip

> 打包前确认 `ui/data.js` 与 `ui/full/` 不在工作区 —— 脚本会直接拒绝打包，避免把真实会话带进公开仓库。

---

## 不要提交

- `.wbcs/`（登录态、正文快照）
- `ui/data.js`、`ui/full/`（构建产物，含真实会话）
- `export/`（导出的 Markdown）
- 任何 `docs/images/` 里非 `demo-shots.js` 生成的截图

`.gitignore` 已经覆盖，但 `git add -f` 能绕过 —— 别这么干。

---

## PR 检查清单

- [ ] 三条自测通过（含 `NO_SERVICE=1` 的降级路径）
- [ ] 面板脚本 `node --check` 通过
- [ ] 版本号五处一致（改了才需要）
- [ ] `CHANGELOG.md` 有新的一节
- [ ] 涉及界面改动的，附一张**示例数据**生成的截图
- [ ] 没有把真实会话 id、标题、正文带进代码或测试

提 issue 前先看 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)，并附上页脚「数据与诊断」的全文 —— 能省掉一轮来回。
