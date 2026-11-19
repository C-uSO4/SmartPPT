# 运行环境与部署说明

## 在线静态部署

在线版不需要 Python、Node 服务、数据库、对象存储或生成 API。静态服务器只提供网页、JavaScript、示例和 PPTX 基础包；访问者的文件在当前浏览器标签页内解析、生成和下载，不会上传到服务器。

开发机构建时使用已有 Node.js 18+：

```bash
node scripts/build-online.cjs
```

将 `dist/` 中的全部内容发布到同一网站根目录，保持以下路径不变：

- `/engine/`：解析、规划、ZIP 与 OOXML；
- `/assets/base.pptx`：最小 PPTX 包壳；
- `/examples/outline.md`：示例大纲；
- `/index.html`、`/app.js`、`/styles.css`。

建议启用 HTTPS。服务器需以 JavaScript MIME 类型返回 `.js`，并允许浏览器获取 `.pptx` 与 `.md` 静态资源；不需要目录列表、服务端重写或跨域上传规则。`DOMParser` 在部分浏览器的 Worker 中不可用，因此当前版本在标签页主线程执行，不应把引擎直接移入 Worker。网站可以从任何现代静态托管服务发布，不限定特定云厂商。

### GitHub Pages 公开交付（2026-11-19）

公开入口：**https://c-uso4.github.io/SmartPPT/**。仓库 `C-uSO4/SmartPPT` 为 Public，Pages 使用 `gh-pages` 分支的 `/ (root)`，无需账号即可访问。`main` 保存源码，`gh-pages` 只保存 `dist/` 的构建结果；更新公开网页时先重新构建，再分别提交并推送两个分支。

本次已在公开地址实际完成示例生成：6 页、18/18 条原文匹配，核心流程 66 ms，5 处平滑切换；页面无控制台错误，全部静态模块、示例和 PPTX 基础包均从 `/SmartPPT/` 子路径成功加载。下载 Blob 为 145,363 字节，独立 ZIP/XML 回读确认 31 个条目、6 页幻灯片、69 个原生文本块，CRC 与 XML 解析错误均为 0，并包含 5 页 Morph by Object 和 5 页非黑场 Fade。

匿名 HTTP 请求已确认首页返回 200。公开地址产物已完成浏览器生成与 ZIP/XML 验收；本机 WPS 打开、逐页导出和真实播放记录见使用说明，不把关键时刻抓帧解释为所有 WPS／PowerPoint 版本的兼容性保证。

### 历史 Qoder Sites 私有交付（2026-11-19）

`https://smart-ppt-studio-zbuekdpk36v.qoder.zone` 已发布，但当前访问策略为 `private`。平台本次返回的可用模式只有 `private`、`selected` 和 `organization`，没有免登录的 `public` 模式；未登录访客会被引导至 Qoder／阿里云登录。因此该地址目前只能作为私有部署结果，不能称为可公开分享的在线入口。

本地浏览器中的五种输入生成、Blob 下载及本机 WPS 检查已完成；由于部署地址需要账号登录，本次未在该私有地址上完成生成与下载验收。平台提供公开访问模式后，可直接发布同一 `dist/`，再按本文“验证”一节补做公开地址验收，无需改回本地生成服务。

## 浏览器要求与资源边界

- 使用最新版 Chrome、Edge 或 Safari；必须支持 ES modules、DOMParser、Blob 下载及 `DecompressionStream('deflate-raw')`。不满足时会显示中文提示，不会静默退回本地服务。
- 主文件不超过 25 MB，图片最多 12 张、单张不超过 8 MB、合计不超过 20 MB。
- Office ZIP 读取会限制条目数量、单条与总解压大小，拒绝加密、ZIP64、未知压缩和路径穿越条目，避免把压缩炸弹交给浏览器解压。
- 复杂文件处理期间页面可能短暂无响应。刷新页面会结束当前生成并清除未下载结果，应先下载再刷新。
- 公开静态站不产生服务器任务队列和文件清理成本，但仍应在目标设备检查大文件的内存占用与生成耗时。

## 可选本地开发兼容入口

旧本地 API 仅用于开发兼容与回归测试，不是在线页面的生成依赖。它需要已有 Node.js 18+ 与 Python 3.10+：

```bash
node src/web/server.js
```

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本地监听地址 |
| `PORT` | `4173` | 本地 HTTP 端口 |
| `PYTHON` | Windows：`py -3`；其他系统：`python3` | 旧 API 的 Python 解释器 |
| `RUNTIME_DIR` | 项目下 `web-runtime` | 旧 API 的任务保存目录 |

不要把旧 `/api` 直接暴露为公网多租户服务；它没有认证、正式任务权限、全局并发限额和自动清理。在线静态部署不需要这些接口。

## 验证

```bash
python -m unittest discover -s tests -p "test_*.py"
node --test tests/web.test.cjs tests/online-static.test.cjs
```

发布后还应在公开地址实际生成并下载 PPTX，再用 Python `zipfile` 独立回读，并在目标 WPS 版本中打开、导出和播放检查。静态构建成功不等于浏览器生成、公开访问或 WPS 动画已经验收。
