# 文档地图

README 负责「要不要用」，这里负责「怎么用、怎么改、为什么这么设计」。

## 按你想做的事找

| 我想… | 读这篇 |
| --- | --- |
| 装上、跑起来 | [README](../README.md) 的「下载即用」/「从源码安装」 |
| 出了问题 | **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** —— 症状 → 原因 → 处理 |
| 改代码 / 看懂分层 | **[ARCHITECTURE.md](ARCHITECTURE.md)** —— 三层职责、数据形状、service 契约、性能预算 |
| 知道这些结论怎么来的 | **[REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md)** —— 一个写死的 `false` 引出的整条链路 |
| 查协议字段、宿主通道 | **[PROTOCOL.md](PROTOCOL.md)** —— 扩展加载、guest-ready、ACP、深链、`wb:*` 通道 |
| 看每个版本改了什么 | [../CHANGELOG.md](../CHANGELOG.md) |
| 参与开发 | [../CONTRIBUTING.md](../CONTRIBUTING.md) |

## 分工

```
README.md                 30 秒讲清价值，给下载链接
  └─ docs/
       TROUBLESHOOTING   按症状索引，面向使用者
       ARCHITECTURE      分层与契约，面向改代码的人
       REVERSE-ENGINEERING  故事与教训，面向好奇的人
       PROTOCOL          事实清单（字段、时序、坑），面向要对接的人
       releases/         每个版本的发布说明
```

**PROTOCOL.md 是「事实」，ARCHITECTURE.md 是「设计」，REVERSE-ENGINEERING.md 是「过程」。**
几篇会有重叠，但视角不同：查字段去 PROTOCOL，改结构去 ARCHITECTURE，想知道「为什么不是另一种做法」去 REVERSE-ENGINEERING。

## 维护约定

- 文档里的接口、字段、时序，必须能在代码里指出对应行；改了代码就顺手改文档
- 截图由 `node tools/demo-shots.js` 用内置示例数据生成，**不允许出现真实会话**
- 版本号五处一致：`package.json` / `extension.json` / `distribution.json` / `server/index.cjs` 的 `VERSION` / `ui/index.html` 的 `PAGE_VERSION`
