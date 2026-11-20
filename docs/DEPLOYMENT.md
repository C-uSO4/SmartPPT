# 运行环境与部署说明

## 默认静态生成与可选 AI

访问者不需要 Python、Node 服务、数据库、对象存储或生成队列。静态服务器只提供网页、JavaScript、示例和 PPTX 基础包；默认情况下，访问者的文件在当前浏览器标签页内解析、生成和下载，不会上传到服务器。

用户主动勾选“AI 辅助识别标题与正文”后，浏览器才会把待分类的 `id/kind/level/text` 文字块发送到本站 `/api/analyze`，再由服务端转发给 DeepSeek。图片、DOCX/PPTX 文件本体、生成后的 PPTX 和原文对账数据不进入该请求。模型只返回标题／正文角色与标题层级，浏览器不改写文字；AI 未配置、超时、限流或响应结构不合法时自动回退本地规则，生成流程继续。

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

### Vercel 生产部署与 AI 代理

生产入口：**https://smart-ppt-ten.vercel.app/**。Vercel 项目连接 GitHub 仓库 `C-uSO4/SmartPPT` 的 `main` 分支；推送后自动执行 `vercel.json` 中的 `node scripts/build-online.cjs`，静态输出为 `dist/`，同时把 `api/analyze.js` 部署为 Function。该配置固定为无框架 Node 静态构建，避免误用 Python preset。

在 Vercel 项目 **Settings → Environment Variables** 中配置：

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 使用 AI 时必需 | 仅保存在服务端 Secret，不进入网页、构建产物或仓库 |
| `DEEPSEEK_MODEL` | 否 | 覆盖模型名，默认 `deepseek-flash` |
| `ALLOWED_ORIGIN` | 否 | 额外允许的 Origin，多个值用英文逗号分隔；默认同源 |

API Key 由项目所有者亲自在 Vercel 中填写，不要写入源码、GitHub、网页或聊天。环境变量只对后续部署生效，新增或修改后必须 **Redeploy**。可通过 `GET /api/analyze` 检查：`ok: true` 表示 Function 已部署，`configured: true` 才表示已读取 Secret；该健康检查不会返回 Key，也不代表真实付费模型请求已经成功。

代理限制单请求 400 块、60,000 字符、100 KB，上游超时 45 秒，浏览器超时 50 秒。跨站请求会被拒绝；当前每转发 IP 每分钟 6 次的限流只保存在单个 Function 实例内存中，是 best-effort 防护，不是分布式强限流或完整公网防滥用方案。公开使用仍需结合 Vercel Firewall、平台额度和 DeepSeek 费用控制。代理不记录正文日志，仅记录上游 HTTP 状态或响应结构校验错误。

本地静态服务器不提供 `/api/analyze`；勾选 AI 后会显示错误并回退本地规则，这是预期行为。完整 AI 链路验收必须在 Vercel 地址进行：健康检查通过后，在网页勾选 AI、生成并检查角色调整数、原文对账与 `AI 结构分析` 实测耗时。未配置 Secret 或未完成真实模型请求时，不得宣称线上 AI 已验证可用。

### GitHub Pages 纯静态交付（2026-11-19）

公开入口：**https://c-uso4.github.io/SmartPPT/**。仓库 `C-uSO4/SmartPPT` 为 Public，Pages 使用 `gh-pages` 分支的 `/ (root)`，无需账号即可访问。`main` 保存源码，`gh-pages` 只保存 `dist/` 的构建结果；更新公开网页时先重新构建，再分别提交并推送两个分支。GitHub Pages 不运行 `api/analyze.js`，因此只支持默认本地规则，不能提供云端 AI。

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
node --test tests/web.test.cjs tests/online-static.test.cjs tests/imported-pptx.test.cjs tests/ai-proxy.test.cjs
```

本轮 19 项 JavaScript 测试全部通过，静态站点已重新构建。其中 AI 代理测试使用模拟上游，不读取 Secret、不发起真实模型计费请求。真实模板链路另在浏览器中完成页面克隆、原生图片与表格、原文对账及 OOXML 回读，并在本机 WPS 成功打开和导出 3 页纯文字稿与 2 页媒体稿；这些结果只代表当前测试文件，不等于所有模板或连续动画均已验收。发布后还应检查生产首页与 `GET /api/analyze`，在公开地址实际生成并下载 PPTX，再用 Python `zipfile` 独立回读，并在目标 WPS 版本中打开、导出和播放检查。配置 Secret 后，需重新部署并实际勾选 AI 完成一次生成，核对模型角色调整、100% 原文对账与 AI 实测耗时。静态构建、模拟测试或健康检查成功不等于真实 DeepSeek 请求、公开访问或 WPS 动画已经验收。
