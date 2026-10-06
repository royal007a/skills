---
name: geektime-course-pdf
description: 将极客时间已获访问权限的专栏或公开课导出为 PDF，保留正文、图片、代码和评论。用于下载、导出或保存整门课程；支持从课程介绍页或文章链接定位课程。
---

# 极客时间课程导出 PDF

使用本目录的 `scripts/geektime.mjs`。默认输出到 `~/Downloads/<课程名>/`，每讲一个 PDF，并生成 `00 - 目录.pdf` 和 `export-report.json`。

## 依赖与权限

- macOS、Google Chrome、Node.js 22+，无需 npm 安装。其他环境可用 `CHROME_BIN` 指定 Chromium 可执行文件，但需自行验证字体和打印效果。
- 用户账号应已购买、领取或拥有课程访问权益。无法访问时报告原因，不购买课程、不绕过付费限制。
- 优先复用 `~/.geektime-export/profile` 登录会话。需要重新登录时使用环境变量 `GT_PHONE` / `GT_PASSWORD`，或本地 `~/.geektime-export/credentials.json`。
- 凭据文件格式为含 `phone` 和 `password` 的 JSON；密码登录成功后以权限 `600` 保存。不要读取并输出密码，也不要将凭据、浏览器配置、课程正文或运行缓存提交到 skill 仓库。命令行凭据参数兼容旧用法，但不推荐。

## 执行

相对路径以此 skill 的目录为基准；安装目录变化不影响脚本运行。

```bash
node scripts/geektime.mjs --url 'https://time.geekbang.org/column/intro/<课程商品编号>'
node scripts/geektime.mjs --url 'https://time.geekbang.org/opencourse/intro/<课程商品编号>'
node scripts/geektime.mjs --url 'https://time.geekbang.org/column/article/<文章编号>'
```

**文章 URL 会导出所属整门课程**，适用于用户用文章链接指代课程的情况。若用户只要单篇，不运行整课导出。`--cid` 接受介绍页中的课程商品编号；文章编号和接口里的旧 `column_id` 不能作为它使用。

多门课逐门串行执行，不并发复用同一个 Chrome profile 或调试端口。25 讲通常需 20–30 分钟，后台运行并查看日志，不把任务“已启动”当成“已完成”。

| 参数 | 默认值 / 作用 |
|---|---|
| `--cid` / `--url` | 二选一，课程商品编号或链接 |
| `--out DIR` | `~/Downloads`，输出根目录 |
| `--workdir DIR` | `~/.geektime-export`，凭据、profile 和缓存目录 |
| `--delay-min` / `--delay-max` | 30 / 60 秒，正文请求之间的随机间隔，脚本不接受低于 30 秒 |
| `--comment-pages N` | 5，评论最多抓取页数，后续页间隔至少 3 秒 |
| `--no-comments` | 新抓取文章不读取评论 |
| `--refresh` | 重新抓取目录内的文章及评论 |
| `--only-fetch` | 抓取正文与评论到缓存，不生成 PDF |
| `--only-render` | 仅用缓存生成 PDF；缺缓存则报缺口，图片仍可能联网加载 |
| `--force-login` | 用本地凭据重新登录 |
| `--port` | 9333，独立 Chrome 调试端口 |
| `--keep-chrome` | 保留本次启动的 Chrome；默认退出时只关闭自己启动的进程 |

`--only-render` 使用 `--cid` 或介绍页 URL。路径建议使用绝对路径；shell 引号内的 `~` 不会展开。

## 增量与完成判断

1. 每次正常运行重新读取最新目录，以本次已发布讲数为准，连载课不标为完结。
2. 正文通过页面导航和被动监听网站 API 响应获取。文章缓存在 `<workdir>/courses/<cid>/articles/`；重跑同一命令复用有效缓存并补新增章节。
3. 已缓存文章的正文和评论不会自动刷新，改变评论选项也不会重抓缓存。需要最新内容或补评论时使用 `--refresh`。
4. 失败最多自动重试两次。未登录/未购买可能源于会话过期，有凭据时强制重登一次；仍受限则停止该课程后续抓取。
5. 查看 `<workdir>/courses/<cid>/report.json`：`available`、`fetched`、`cached`、`failed`、`files`。退出码 `0` 表示本次处理成功，`2` 表示有缺失或渲染失败，`1` 表示初始化/运行异常。失败文章不会在刷新时用旧缓存冒充本次成功。
6. 评论有页数上限。日志提示还有更多评论或未捕获首页时，如实说明范围，不宣称评论完整。

已有同名 PDF 会被更新；旧目录内因标题改名或下架而遗留的文件不会自动删除。以报告的 `files` 为本次生成清单。

## PDF 检查与失败处理

- 打印前等待图片加载，加载失败不写入该 PDF；报告会列出失败，即使目录中留有以前的同名文件也不能算本次成功。
- 视频不能直接变成 PDF：保留页面已有文字稿和静态封面。脚本为长图设置单页最大高度，避免图示跨页裁切。
- 完成后核对报告与实际文件数，并用可用的 PDF 工具抽查目录、代码表格、评论、直播封面和长图。没有文本的图片页不等于空白页。
- `no_response`、目录不全或页面一直加载：先查看实际页面/日志，不提高请求频率；可把间隔调到 90–120 秒，最多补跑两次，仍失败则汇报缺口。
- 登录失败或验证码：让用户恢复本地登录或凭据，避免要求在聊天中发送密码。
- 汇报课程名、讲数、PDF 数、输出位置、连载状态及未完成项，不输出凭据或接口中的个人信息。

## 维护验证

```bash
node --check scripts/geektime.mjs
node --test scripts/geektime.test.mjs
```

测试使用合成数据和模拟浏览器响应；不登录真实账号、不下载课程、不读取用户凭据。修改 PDF 样式后，额外用合成缓存执行 `--only-render` 并查看生成页面。
