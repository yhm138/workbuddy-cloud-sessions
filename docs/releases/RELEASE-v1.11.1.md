# v1.11.1 — 说清楚

这一版几乎全是文档，代码只改了一处措辞逻辑。

## 改了什么

**结束卡的条数说法按来源区分。**

之前不管正文是「云端回放」还是「本机快照」，末尾都写「到这里是全部 N 条」。可快照可能落后几轮，这句话会让用户把半截对话当成完整历史 —— 而这正是整个项目最在意的一条约束。

现在：

| 来源 | 结束卡标题 | 附注 |
| --- | --- | --- |
| 云端回放中 | 已到 N 条 · 后面还在补 | — |
| 云端最新 | 到这里是全部 N 条 | — |
| 本机快照 | **这是本机快照里的 N 条** | 要看全文，从右上 `⋯` 拉一次云端 |

**修掉了安装包的一个隐性问题。**

之前的 zip 用 Info-ZIP 的 `-UN=UTF8` 生成，它会把中央目录偏移写错 6 字节：`unzip` 能靠纠错解开，但 **Python、7-Zip、部分解压软件会直接报 `Bad magic number for central directory`**。不加这个参数，中文文件名又会变成 GBK 乱码。

现在打包脚本自带一个极简 zip 写入器（`tools/zip.cjs`）：文件名统一 UTF-8 并置 bit 11，偏移严格按字节累加。Windows 资源管理器、7-Zip、Python 解出来都是 `安装.bat / 使用说明.txt`。

**诊断区补了一个空值兜底。** 如果一次 `fetchBody` 比探活更早成功，诊断区会去读还没建立的 `info` 对象，抛 `Cannot read properties of null`。现在缺失字段都有兜底文案。

## 文档重写

README 从头写过：顶部一句话讲清「桌面端看不见的会话」，紧跟一张「原生桌面端 vs 装了这个扩展」的对照表，技术细节全部收进折叠块。原来那份更像工程日志，现在先讲价值、再讲实现。

新增四份文档，各自分工：

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| [ARCHITECTURE.md](https://github.com/yhm138/workbuddy-cloud-sessions/blob/main/docs/ARCHITECTURE.md) | 改代码的人 | 三层职责、数据形状、service 契约、降级矩阵、性能预算表 |
| [REVERSE-ENGINEERING.md](https://github.com/yhm138/workbuddy-cloud-sessions/blob/main/docs/REVERSE-ENGINEERING.md) | 好奇的人 | 一个写死的 `false` 引出的整条链路，包括那次把客户端搞闪退的尝试 |
| [TROUBLESHOOTING.md](https://github.com/yhm138/workbuddy-cloud-sessions/blob/main/docs/TROUBLESHOOTING.md) | 使用者 | 症状 → 原因 → 处理，附诊断区逐行解释 |
| [docs/README.md](https://github.com/yhm138/workbuddy-cloud-sessions/blob/main/docs/README.md) | 所有人 | 文档地图：想干什么 → 读哪篇 |

PROTOCOL.md 保留为协议事实清单，加了「你要找什么 → 去哪节」的索引；发布说明归档到 `docs/releases/`；新增 `CHANGELOG.md`、`CONTRIBUTING.md` 和 issue 模板。

## 截图

`node tools/demo-shots.js` 重新生成全部四张 —— 旧图里还带着 v1.11.0 已经删掉的底部输入框。

## 升级

覆盖安装后**托盘退出 WorkBuddy 再打开**（service 是启动时 fork 的），诊断区应显示 `service v1.11.1`。
