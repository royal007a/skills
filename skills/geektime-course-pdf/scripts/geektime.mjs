#!/usr/bin/env node
// 极客时间专栏导出 PDF（正文 + 评论区）
// 防封策略：纯页面导航 + 被动监听网站自己的 API 响应抓取正文（不发主动批量请求），
//           每篇之间随机休眠 30-60s；登录态丢失自动重登。
// 用法: node geektime.mjs --cid <column_id> [--out DIR] [--delay-min 30] [--delay-max 60]

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------- args ----------------
function parseArgs(argv) {
  const a = {
    out: path.join(homedir(), "Downloads"),
    workdir: path.join(homedir(), ".geektime-export"),
    delayMin: 30, delayMax: 60, commentPages: 5, port: 9333,
    noComments: false, refresh: false, keepChrome: false,
    forceLogin: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--cid") a.cid = argv[++i];
    else if (t === "--url") a.url = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--workdir") a.workdir = argv[++i];
    else if (t === "--phone") a.phone = argv[++i];
    else if (t === "--password") a.password = argv[++i];
    else if (t === "--delay-min") a.delayMin = +argv[++i];
    else if (t === "--delay-max") a.delayMax = +argv[++i];
    else if (t === "--comment-pages") a.commentPages = +argv[++i];
    else if (t === "--port") a.port = +argv[++i];
    else if (t === "--no-comments") a.noComments = true;
    else if (t === "--refresh") a.refresh = true;
    else if (t === "--force-login") a.forceLogin = true;
    else if (t === "--keep-chrome") a.keepChrome = true;
    else if (t === "--only-fetch") a.onlyFetch = true;
    else if (t === "--only-render") a.onlyRender = true;
    else if (t === "--help") a.help = true;
    else throw new Error(`未知参数：${t}`);
  }
  if (a.help) return a;
  if (Boolean(a.cid) === Boolean(a.url)) throw new Error("请指定 --cid 或 --url，二选一");
  if (a.cid && !/^\d+$/.test(a.cid)) throw new Error("cid 必须为课程商品编号");
  if (a.url) Object.assign(a, parseCourseUrl(a.url));
  if (a.onlyRender && !a.cid) throw new Error("--only-render 请使用 --cid 或课程介绍页 URL");
  if (a.onlyRender && (a.onlyFetch || a.refresh)) throw new Error("--only-render 不能与 --only-fetch/--refresh 同用");
  if (!Number.isFinite(a.delayMin) || !Number.isFinite(a.delayMax) || a.delayMin < 30 || a.delayMax < a.delayMin) throw new Error("间隔必须满足 30 <= delay-min <= delay-max");
  if (!Number.isInteger(a.commentPages) || a.commentPages < 1) throw new Error("comment-pages 必须为正整数");
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) throw new Error("port 必须为 1024–65535");
  a.out = path.resolve(a.out); a.workdir = path.resolve(a.workdir);
  return a;
}

function parseCourseUrl(value) {
  const u = new URL(value);
  const m = u.pathname.match(/^\/(column|opencourse)\/(intro|article)\/(\d+)\/?$/);
  if (u.origin !== "https://time.geekbang.org" || !m) throw new Error("需要极客时间的课程介绍页或文章 URL");
  return { kind: m[1], ...(m[2] === "intro" ? { cid: m[3] } : { articleId: m[3] }) };
}
const USAGE = `geektime.mjs — 极客时间专栏导出 PDF（正文+评论区）
必选: --cid <课程商品id> 或 --url <课程介绍页/文章URL>
可选: --out DIR(默认 ~/Downloads) --delay-min 30 --delay-max 60
      --phone X --password Y (或环境变量 GT_PHONE/GT_PASSWORD，或 ~/.geektime-export/credentials.json)
      --comment-pages 5  --no-comments  --refresh(忽略缓存重抓)  --only-fetch/--only-render
      --workdir DIR --port 9333 --force-login --keep-chrome
优先使用环境变量传递凭据，避免密码出现在命令历史中。`;

// ---------------- credentials ----------------
function loadCredentials(args) {
  const credFile = path.join(args.workdir, "credentials.json");
  let saved = {};
  try { saved = JSON.parse(readFileSync(credFile)); } catch {}
  const phone = args.phone || process.env.GT_PHONE || saved.phone;
  const password = args.password || process.env.GT_PASSWORD || saved.password;
  return { phone, password, credFile };
}
function saveCredentials(credFile, phone, password) {
  mkdirSync(path.dirname(credFile), { recursive: true });
  writeFileSync(credFile, JSON.stringify({ phone, password }, null, 1), { mode: 0o600 });
  try { chmodSync(credFile, 0o600); } catch {}
}

// ---------------- CDP ----------------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 200))) : p.resolve(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Chrome 连接已关闭")); }
      this.pending.clear();
    };
  }
  static async connect(port) {
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) })).json();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect fail")); });
    const cdp = new CDP(ws); cdp.targetId = page.id; return cdp;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch {} }
}

async function evalPage(cdp, expression, awaitPromise = true) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面脚本执行失败；请检查页面状态（异常参数不输出以保护凭据）");
  return r.result.value;
}

// 网络监听器：只被动记录网站自己发出的请求
class NetMon {
  constructor(cdp) {
    this.reqs = new Map();
    cdp.on(m => {
      if (m.method === "Network.requestWillBeSent") {
        this.reqs.set(m.params.requestId, { url: m.params.request.url, body: m.params.request.postData || "", status: 0, done: false });
      } else if (m.method === "Network.responseReceived") {
        const rec = this.reqs.get(m.params.requestId);
        if (rec) rec.status = m.params.response.status;
      } else if (m.method === "Network.loadingFinished") {
        const rec = this.reqs.get(m.params.requestId);
        if (rec) rec.done = true;
      }
    });
  }
  clear() { this.reqs.clear(); }
  // 等待并取回匹配的响应体
  async capture(cdp, urlPattern, bodyPattern, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const [rid, rec] of this.reqs) {
        if (rec.done && rec.status === 200 && urlPattern.test(rec.url) && (!bodyPattern || bodyPattern.test(rec.body))) {
          try {
            const b = await cdp.send("Network.getResponseBody", { requestId: rid });
            this.reqs.delete(rid);
            return b.body;
          } catch {}
        }
      }
      await sleep(800);
    }
    return null;
  }
}

// ---------------- chrome ----------------
async function ensureChrome(args) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    console.log(`[chrome] 复用已运行实例 ${v.Browser}`);
    return;
  } catch {}
  const profileDir = path.join(args.workdir, "profile");
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(CHROME_BIN, [
    "--headless=new", `--remote-debugging-port=${args.port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "about:blank",
  ], { detached: true, stdio: "ignore" });
  let launchError; child.on("error", e => { launchError = e; }); child.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (launchError) throw new Error(`Chrome 启动失败：${launchError.code}`);
    try { await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json(); console.log(`[chrome] 已启动 (headless, profile=${profileDir})`); return child; } catch {}
  }
  child.kill();
  throw new Error("Chrome 启动失败");
}

// ---------------- 登录 ----------------
function loginState(text) {
  if (/登录后，你可以任选|登录\s*\|\s*注册|^\s*登录\s*$/m.test(text)) return "logged-out";
  if (text.replace(/[\s\uE000-\uF8FF]/g, "").length < 12 || /^\s*加载中/.test(text)) return "unknown";
  return "likely-logged-in";
}

async function isLoggedIn(cdp) {
  for (let i = 0; i < 12; i++) {
    const text = await evalPage(cdp, "document.body?.innerText || ''", false);
    const state = loginState(text);
    if (state !== "unknown") return state === "likely-logged-in";
    await sleep(1000);
  }
  throw new Error("页面仍在加载，无法确认登录状态；稍后重试");
}

async function doLogin(cdp, phone, password) {
  console.log("[login] 打开登录页…");
  await cdp.send("Page.navigate", { url: "https://account.geekbang.org/login?redirect=https%3A%2F%2Ftime.geekbang.org%2F" });
  await sleep(6000);
  const fill = await evalPage(cdp, `(() => {
    const setVal = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const phone = document.querySelector('input[name="cellphone"]');
    const pwd = document.querySelector('input[name="password"]');
    if (!phone || !pwd) return 'NO_FORM';
    setVal(phone, ${JSON.stringify(phone)});
    setVal(pwd, ${JSON.stringify(password)});
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) (cb.closest('label') || cb.parentElement).click();
    if (cb && !cb.checked) cb.click();
    return cb ? 'OK_cb=' + cb.checked : 'OK_nocb';
  })()`);
  if (fill.startsWith("NO_FORM")) throw new Error("登录表单未找到（页面异常）");
  await sleep(1500);
  const click = await evalPage(cdp, `(() => {
    const btn = [...document.querySelectorAll('div, button')].find(e => e.offsetParent && (e.innerText || '').trim() === '登录' && e.children.length === 0);
    if (btn) { btn.click(); return 'CLICKED'; }
    return 'NO_BTN';
  })()`);
  if (click !== "CLICKED") throw new Error("未找到登录按钮");
  // 等待跨域同步跳转链完成 (account.geekbang.org -> account.infoq.cn -> time.geekbang.org)
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    try {
      const url = await evalPage(cdp, "location.href", false);
      if (new URL(url).hostname === "time.geekbang.org") { console.log("[login] 登录成功"); return true; }
    } catch {}
  }
  throw new Error("登录超时（30s 内未跳转到 time.geekbang.org）");
}

async function ensureLogin(cdp, creds, cid, forceLogin = false, kind = "column") {
  await cdp.send("Page.enable");
  if (forceLogin) {
    if (!creds.phone || !creds.password) throw new Error("--force-login 需要登录凭据");
    await doLogin(cdp, creds.phone, creds.password);
    if (creds.credFile) saveCredentials(creds.credFile, creds.phone, creds.password);
    return;
  }
  await cdp.send("Page.navigate", { url: `https://time.geekbang.org/${kind}/intro/${cid}` });
  await sleep(8000);
  if (await isLoggedIn(cdp)) { console.log("[login] 会话有效（复用持久化 profile）"); return; }
  if (!creds.phone || !creds.password) {
    throw new Error("需要登录但无凭据。请提供 --phone/--password 或设置 GT_PHONE/GT_PASSWORD 环境变量，或写入 ~/.geektime-export/credentials.json");
  }
  await doLogin(cdp, creds.phone, creds.password);
  if (creds.credFile) saveCredentials(creds.credFile, creds.phone, creds.password);
}

// ---------------- 抓取 ----------------
// 目录：被动捕获页面自己请求的 /serv/v1/column/articles（顺序）+ /serv/v1/chapters（章节名）
async function fetchCatalog(cdp, netmon, cid, kind = "column") {
  netmon.clear();
  await cdp.send("Page.navigate", { url: `https://time.geekbang.org/${kind}/intro/${cid}?tab=catalog` });
  const artsBody = await netmon.capture(cdp, /\/serv\/v1\/column\/articles/, null, 30000);
  let list = [];
  try { list = (JSON.parse(artsBody).data.list) || []; } catch {}
  if (!list.length) throw new Error("未捕获到文章列表（页面加载异常或未登录）");
  const chapBody = await netmon.capture(cdp, /\/serv\/v1\/chapters/, null, 10000);
  const chapNames = {};
  try { for (const c of JSON.parse(chapBody).data || []) chapNames[String(c.id)] = c.title; } catch {}
  const infoBody = await netmon.capture(cdp, /\/serv\/v3\/column\/info/, null, 10000);
  let info; try { info = JSON.parse(infoBody).data; } catch {}
  if (!info || String(info.id) !== String(cid)) throw new Error("课程元数据缺失或商品编号不匹配");
  if (info.article?.count_pub && list.length < info.article.count_pub) throw new Error("目录不完整；停止导出，避免漏讲");
  const order = list.map(a => ({
    id: String(a.id), chapter: chapNames[String(a.chapter_id)] || "",
    audio_time: a.audio_time || "", reading_time: a.reading_time || 0,
  }));
  return { courseName: info.title, order, isFinish: info.is_finish === true, kind, fetchedAt: Date.now() };
}

async function resolveArticleCourse(cdp, netmon, args) {
  netmon.clear();
  await cdp.send("Page.navigate", { url: args.url });
  const body = await netmon.capture(cdp, /\/serv\/v1\/article$/, null, 30000);
  let data; try { data = JSON.parse(body).data; } catch {}
  const cid = data?.sku || data?.column_sku;
  if (!cid || !/^\d+$/.test(String(cid))) throw new Error("无法从文章响应解析课程商品编号；请改用课程介绍页 URL");
  return String(cid);
}

async function fetchArticle(cdp, netmon, artId) {
  netmon.clear();
  await cdp.send("Page.navigate", { url: `https://time.geekbang.org/column/article/${artId}` });
  const body = await netmon.capture(cdp, /\/serv\/v1\/article$/, new RegExp(`"id":"?${artId}"?`), 30000);
  if (!body) return { err: "no_response" };
  let j;
  try { j = JSON.parse(body); } catch { return { err: "bad_json" }; }
  const d = j.data || {};
  if (j.error && j.error.msg) return { err: j.error.msg, code: j.error.code };
  if (!d.article_content) return { err: "empty_content" };
  if (d.column_had_sub === false && !d.article_could_preview) return { err: "用户未购买此专栏" };
  return { data: d };
}

async function fetchComments(cdp, netmon, artId, maxPages) {
  // 第 1 页随页面加载被动捕获
  const body = await netmon.capture(cdp, /\/serv\/v4\/comment\/list/, new RegExp(`"aid":${artId}`), 12000);
  let comments = [], more = false;
  if (body) {
    try {
      const j = JSON.parse(body);
      comments = (j.data && j.data.list) || [];
      more = !!(j.data && j.data.page && j.data.page.more);
    } catch {}
  }
  if (!body) console.log("  [comments] 未捕获首页评论，无法确认是否为空");
  let pages = 1;
  // 后续页主动翻页（每篇仅少量请求，间隔 3s，风险可控）
  while (more && comments.length > 0 && pages < maxPages) {
    await sleep(3000);
    try {
      const r = await evalPage(cdp, `(async () => {
        const r = await fetch('/serv/v4/comment/list', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aid: ${artId}, prev: ${comments[comments.length - 1].id}, sort: 0 })
        });
        const t = await r.text();
        return t.slice(0, 300000);
      })()`);
      const j = JSON.parse(r);
      const lst = (j.data && j.data.list) || [];
      if (lst.length === 0) break;
      comments = comments.concat(lst);
      more = !!(j.data && j.data.page && j.data.page.more);
      pages++;
    } catch (e) {
      console.log(`  [comments] 翻页失败，保留已获取 ${comments.length} 条: ${String(e).slice(0, 60)}`);
      break;
    }
  }
  if (more) console.log(`  [comments] 已保留 ${comments.length} 条，尚有更多评论未获取`);
  return comments;
}

// ---------------- HTML 构建 ----------------
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sanitizeTitle = t => String(t).replace(/[\\/:*?"<>|]/g, "／").replace(/\s+/g, " ").trim().replace(/\.+$/, "").slice(0, 70);

function sanitizeContent(c) {
  c = String(c).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  c = c.replace(/<\/?audio[^>]*>/gi, "");
  c = c.replace(/<video\b([^>]*)>[\s\S]*?<\/video>/gi, (_, attrs) => {
    const poster = attrs.match(/poster="([^"]+)"/i);
    return poster ? `<img src="${poster[1]}" alt="直播回放封面">` : "";
  });
  c = c.replace(/\s+on\w+="[^"]*"/g, "").replace(/\s+loading="[^"]*"/g, "");
  c = c.replace(/data-src=/g, "src=").replace(/ target="_blank"/g, "");
  return c;
}
const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-") : "";

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 10.5pt; line-height: 1.9; color: #212529; }
.kicker { font-size: 8.5pt; color: #868e96; letter-spacing: .5px; margin: 0 0 6px; }
h1.title { font-size: 17pt; line-height: 1.5; margin: 0 0 10px; color: #111; }
.meta { font-size: 9pt; color: #6c757d; margin: 0 0 4px; }
hr.rule { border: none; border-top: 2px solid #343a40; margin: 14px 0 22px; }
.article { word-break: break-word; }
.article p { margin: 0 0 12px; text-align: justify; }
.article h1, .article h2, .article h3, .article h4 { line-height: 1.6; margin: 22px 0 10px; page-break-after: avoid; }
.article h2 { font-size: 13.5pt; } .article h3 { font-size: 12pt; }
.article img { max-width: 100%; max-height: 240mm; width: auto; height: auto; object-fit: contain; break-inside: avoid; display: block; margin: 14px auto; }
.article pre { background: #f6f8fa; border: 1px solid #e3e7ec; border-radius: 6px; padding: 10px 14px;
  overflow: hidden; white-space: pre-wrap; word-break: break-word; font-size: 8.3pt; line-height: 1.65; margin: 12px 0; }
.article code, .article pre code { font-family: "SF Mono", Menlo, Consolas, "Courier New", monospace; }
.article code { background: #f1f3f5; padding: 1px 4px; border-radius: 3px; font-size: 9pt; }
.article pre code { background: none; padding: 0; }
.article blockquote { border-left: 3px solid #adb5bd; margin: 12px 0; padding: 2px 14px; color: #495057; background: #f8f9fa; }
.article table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 9.5pt; }
.article th, .article td { border: 1px solid #ced4da; padding: 6px 10px; text-align: left; }
.article th { background: #f1f3f5; }
.article ul, .article ol { padding-left: 22px; margin: 0 0 12px; }
.foot { display: none; margin-top: 28px; padding-top: 10px; border-top: 1px solid #dee2e6; font-size: 8.5pt; color: #adb5bd; text-align: center; }
.cmt-head { font-size: 13pt; margin: 30px 0 6px; padding-top: 14px; border-top: 1.5px solid #343a40; }
.cmt { margin: 0 0 14px; padding: 10px 12px; background: #fafbfc; border: 1px solid #eef1f4; border-radius: 6px; page-break-inside: avoid; }
.cmeta { font-size: 8.5pt; color: #868e96; margin-bottom: 4px; }
.cname { font-weight: 700; color: #343a40; }
.ctext { font-size: 9.8pt; }
.reply { margin: 8px 0 0 14px; padding: 8px 10px; border-left: 2px solid #ced4da; }
.reply.author { border-left: 2px solid #c92a2a; background: #fff5f5; }
.reply.author .cname { color: #c92a2a; }
.cover { text-align: center; padding: 70px 0 20px; }
.cover h1 { font-size: 24pt; margin: 0 0 8px; }
.cover .sub { font-size: 12pt; color: #495057; margin: 0 0 14px; }
.cover .facts { font-size: 10pt; color: #6c757d; }
.chap { margin: 26px 0 6px; font-size: 12pt; font-weight: 700; color: #343a40; border-left: 4px solid #343a40; padding-left: 10px; page-break-after: avoid; }
table.cat { border-collapse: collapse; width: 100%; font-size: 10pt; }
table.cat td { border-bottom: 1px solid #e9ecef; padding: 7px 6px; vertical-align: top; }
td.no { color: #868e96; width: 34px; } td.dur { color: #868e96; white-space: nowrap; width: 90px; text-align: right; }
`;

function buildArticleHtml(idx, total, courseName, chapter, art) {
  const meta = [`作者：${art.author || "—"}`];
  if (art.ctime) meta.push(`发布：${fmtDate(art.ctime)}`);
  if (art.audio_time) meta.push(`音频 ${art.audio_time}`);
  if (art.reading_time) meta.push(`约 ${Math.round(art.reading_time / 60)} 分钟`);
  let cmtHtml = "";
  const cmts = art.comments || [];
  if (cmts.length) {
    const items = cmts.map(c => {
      const replies = (c.replies || []).map(r => {
        const isAuthor = r.utype === 1 || /作者/.test(r.user_name || "");
        return `<div class="reply${isAuthor ? " author" : ""}">
  <div class="cmeta"><span class="cname">${esc(r.user_name || r.user_name_real || "读者")}</span>${isAuthor ? " · 📌" : ""} · ${fmtDate(r.ctime)}</div>
  <div class="ctext">${esc(r.content || "")}</div></div>`;
      }).join("");
      return `<div class="cmt">
  <div class="cmeta"><span class="cname">${esc(c.user_name || "匿名")}</span> · ${esc(c.ip_address || "")} · ${fmtDate(c.comment_ctime)} · 👍 ${c.like_count || 0}</div>
  <div class="ctext">${esc(c.comment_content || "")}</div>${replies}</div>`;
    }).join("");
    cmtHtml = `<h2 class="cmt-head">评论区（${cmts.length} 条）</h2>${items}`;
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(art.title)}</title><style>${CSS}</style></head>
<body><div class="doc">
<p class="kicker">极客时间 · ${esc(courseName)}${chapter ? " · " + esc(chapter) : ""}</p>
<h1 class="title">${esc(art.title)}</h1>
<p class="meta">${meta.join(" · ")} · 第 ${idx} 讲 / 共 ${total} 讲</p>
<hr class="rule">
<div class="article">${sanitizeContent(art.content)}</div>
${cmtHtml}
<p class="foot">— 完 —<br>来源：极客时间《${esc(courseName)}》· 仅供个人学习</p>
</div></body></html>`;
}

function buildCatalogHtml(courseName, entries, isFinish = false, available = entries.length) {
  const rows = [];
  let lastCh = null;
  for (const e of entries) {
    if (e.chapter && e.chapter !== lastCh) { rows.push(`<tr><td colspan="3"><div class="chap">${esc(e.chapter)}</div></td></tr>`); lastCh = e.chapter; }
    rows.push(`<tr><td class="no">${String(e.idx).padStart(2, "0")}</td><td>${esc(e.title)}</td><td class="dur">${esc(e.audio_time || "")}</td></tr>`);
  }
  const total = entries.length;
  const chapCount = new Set(entries.map(e => e.chapter).filter(Boolean)).size;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>目录</title><style>${CSS}</style></head>
<body><div class="doc">
<div class="cover">
<h1>${esc(courseName)}</h1>
<p class="facts">本次导出 ${total} / 已发布 ${available} 讲 · ${chapCount} 个章节 · ${isFinish ? "课程已完结" : "截至导出时已更新"}</p>
</div>
<hr class="rule">
<table class="cat">${rows.join("")}</table>
<p class="foot">目录 · 生成于 ${new Date().toISOString().slice(0, 10)} · 来源：极客时间</p>
</div></body></html>`;
}

// ---------------- PDF 打印 ----------------
async function waitImages(cdp, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await evalPage(cdp, `(() => { const im = [...document.images]; return im.length + ':' + im.filter(i => i.complete).length + ':' + document.readyState; })()`, false);
      const [total, done, ready] = v.split(":");
      if (ready === "complete" && total === done) return true;
    } catch {}
    await sleep(700);
  }
  return false;
}

async function printPdf(cdp, htmlPath, outPath) {
  await cdp.send("Page.navigate", { url: pathToFileURL(htmlPath).href });
  if (!await waitImages(cdp, 30000)) throw new Error("图片加载超时，未写入 PDF");
  const broken = await evalPage(cdp, "[...document.images].filter(i => !i.naturalWidth).length", false);
  if (broken) throw new Error(`${broken} 张图片加载失败，未写入 PDF`);
  const pdf = await cdp.send("Page.printToPDF", {
    landscape: false, printBackground: true, scale: 1,
    paperWidth: 8.27, paperHeight: 11.69,
    marginTop: 0.72, marginBottom: 0.65, marginLeft: 0.62, marginRight: 0.62,
  });
  writeFileSync(outPath, Buffer.from(pdf.data, "base64"));
  return Math.round(pdf.data.length * 3 / 4 / 1024);
}

// ---------------- main ----------------
async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return; }
  const creds = loadCredentials(args);
  const chrome = await ensureChrome(args);
  let cdp;
  try {
    cdp = await CDP.connect(args.port);
    const netmon = new NetMon(cdp);
    await cdp.send("Network.enable"); await cdp.send("Page.enable");
    if (args.articleId) args.cid = await resolveArticleCourse(cdp, netmon, args);
    const courseDir = path.join(args.workdir, "courses", args.cid);
    const artDir = path.join(courseDir, "articles"), htmlDir = path.join(courseDir, "html");
    mkdirSync(artDir, { recursive: true }); mkdirSync(htmlDir, { recursive: true });
    const metaPath = path.join(courseDir, "meta.json");
    let meta;
    if (args.onlyRender) {
      meta = JSON.parse(readFileSync(metaPath));
    } else {
      await ensureLogin(cdp, creds, args.cid, args.forceLogin, args.kind);
      meta = await fetchCatalog(cdp, netmon, args.cid, args.kind);
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }
    const { courseName, order } = meta;
    if (!courseName || !Array.isArray(order) || !order.length) throw new Error("课程缓存缺少名称或目录");
    console.log(`[catalog] ${courseName} · 已发布 ${order.length} 讲`);
    const report = { cid: args.cid, courseName, available: order.length, isFinish: meta.isFinish === true,
      generatedAt: new Date().toISOString(), fetched: [], cached: [], failed: [], files: [] };
    const saveReport = () => writeFileSync(path.join(courseDir, "report.json"), JSON.stringify(report, null, 2));
    const entries = [];
    let lastNavigation = 0, accessDenied = false;
    for (let i = 0; i < order.length; i++) {
      const o = order[i], file = path.join(artDir, `${o.id}.json`);
      let art;
      if (!args.refresh && existsSync(file)) {
        try { const cached = JSON.parse(readFileSync(file)); if (cached.content && cached.title) art = cached; } catch {}
      }
      if (art) report.cached.push(o.id);
      else if (args.onlyRender) report.failed.push({ id: o.id, error: "缺少有效文章缓存" });
      else if (accessDenied) report.failed.push({ id: o.id, error: "课程访问受限，已停止后续抓取" });
      else {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (lastNavigation) {
            const wait = rand(args.delayMin, args.delayMax) * 1000;
            if (wait) { console.log(`  休眠 ${Math.ceil(wait / 1000)}s（请求间隔）`); await sleep(wait); }
          }
          console.log(`[${i + 1}/${order.length}] 抓取 ${o.id}${attempt ? `，重试 ${attempt}/2` : ""}`);
          lastNavigation = Date.now();
          result = await fetchArticle(cdp, netmon, o.id);
          if (result.data) break;
          console.log(`  失败: ${result.err}`);
          if (/未登录|未购买/.test(result.err || "")) {
            // An expired session can look like a missing purchase. Authenticate once, then stop on repeated denial.
            if (attempt === 0 && creds.phone && creds.password) {
              await ensureLogin(cdp, creds, args.cid, true, args.kind);
            } else { accessDenied = true; break; }
          }
        }
        if (!result?.data) report.failed.push({ id: o.id, error: result?.err || "抓取失败" });
        else {
          const d = result.data;
          const comments = args.noComments ? [] : await fetchComments(cdp, netmon, o.id, args.commentPages);
          art = { id: o.id, title: d.article_title, author: d.author_name, ctime: d.article_ctime,
            content: d.article_content, chapter: o.chapter || "", audio_time: o.audio_time || "",
            reading_time: o.reading_time || 0, comments, commentsFetched: !args.noComments, fetchedAt: Date.now() };
          writeFileSync(file, JSON.stringify(art, null, 1)); report.fetched.push(o.id);
          console.log(`  ok: ${art.title}（评论 ${comments.length} 条）`);
        }
      }
      if (art) entries.push({ idx: i + 1, art: { ...art, chapter: o.chapter || art.chapter || "" } });
      saveReport();
    }
    if (!args.onlyFetch && entries.length) {
      const outDir = path.join(args.out, sanitizeTitle(courseName)); mkdirSync(outDir, { recursive: true });
      const render = async (html, stem, filename, id) => {
        const hp = path.join(htmlDir, `${stem}.html`), out = path.join(outDir, filename);
        writeFileSync(hp, html);
        try { const kb = await printPdf(cdp, hp, out); report.files.push(out); console.log(`  ${filename} (${kb} KB)`); }
        catch (e) { report.failed.push({ id, error: String(e.message), phase: "render" }); console.log(`[render] ${id}: ${e.message}`); }
        saveReport();
      };
      for (const { idx, art } of entries) {
        const stem = String(idx).padStart(2, "0");
        await render(buildArticleHtml(idx, order.length, courseName, art.chapter, art), stem,
          `${stem} - ${sanitizeTitle(art.title)}.pdf`, art.id);
      }
      const rendered = entries.filter(({ art }) => !report.failed.some(f => f.id === art.id));
      await render(buildCatalogHtml(courseName, rendered.map(({ idx, art }) => ({ idx, title: art.title,
        chapter: art.chapter, audio_time: art.audio_time })), meta.isFinish === true, order.length), "00", "00 - 目录.pdf", "catalog");
      writeFileSync(path.join(outDir, "export-report.json"), JSON.stringify(report, null, 2));
      console.log(`[done] 本次生成 ${report.files.length} 个 PDF → ${outDir}`);
    } else if (args.onlyFetch) console.log(`[done] 缓存 ${entries.length}/${order.length} 讲 → ${artDir}`);
    saveReport();
    if (report.failed.length) { console.error(`[incomplete] ${report.failed.length} 项失败，详见 ${courseDir}/report.json`); process.exitCode = 2; }
    return report;
  } finally {
    if (cdp) { try { await cdp.send("Target.closeTarget", { targetId: cdp.targetId }); } catch {} cdp.close(); }
    if (chrome && !args.keepChrome) chrome.kill();
  }
}

export { parseArgs, parseCourseUrl, loginState, buildArticleHtml, buildCatalogHtml, sanitizeContent, main };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error("[fatal]", e.message); process.exitCode = 1; });
}
