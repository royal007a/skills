import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, parseCourseUrl, loginState, buildArticleHtml, buildCatalogHtml, main } from './geektime.mjs';
const args = (...a) => ['node', 'geektime.mjs', ...a];

test('URLs distinguish course product IDs from article IDs and reject other hosts', () => {
  assert.deepEqual(parseCourseUrl('https://time.geekbang.org/opencourse/intro/123?tab=catalog'), { kind: 'opencourse', cid: '123' });
  assert.deepEqual(parseCourseUrl('https://time.geekbang.org/column/article/456'), { kind: 'column', articleId: '456' });
  assert.throws(() => parseCourseUrl('https://example.org/column/intro/123'));
  assert.throws(() => parseCourseUrl('https://time.geekbang.org.evil.test/column/intro/123'));
});

test('CLI rejects conflicting modes, short delays and unresolved offline article URLs', () => {
  for (const a of [[], ['--cid', '123', '--delay-min', '1'], ['--cid', '123', '--only-fetch', '--only-render'],
    ['--cid', '123', '--only-render', '--refresh'], ['--url', 'https://time.geekbang.org/column/article/456', '--only-render'],
    ['--cid', '123', '--comment-pages', 'NaN'], ['--cid', '../profile']]) assert.throws(() => parseArgs(args(...a)));
  assert.equal(parseArgs(args('--cid', '123', '--only-fetch')).onlyFetch, true);
});

test('loading screens and the opencourse login button are not treated as logged in', () => {
  assert.equal(loginState('\n加载中...'), 'unknown');
  assert.equal(loginState('课程介绍\n登录\nDeepSeek Harness 极简入门'), 'logged-out');
  assert.equal(loginState('课程介绍\n登录 | 注册\n课程目录'), 'logged-out');
  assert.equal(loginState('课程介绍\n我的学习\n已购买课程\n这里是完整目录'), 'likely-logged-in');
});

test('PDF HTML keeps video poster and transcript, escapes titles and distinguishes partial exports', () => {
  const html = buildArticleHtml(1, 2, '示例课程', '章节', { title: '<标题>', content:
    '<video src="private-stream" poster="https://example.org/poster.png"></video><p>文字稿</p><script>alert(1)</script>' });
  assert.ok(html.includes('&lt;标题&gt;'));
  assert.ok(html.includes('<img src="https://example.org/poster.png"'));
  assert.ok(html.includes('文字稿'));
  assert.ok(!html.includes('private-stream') && !html.includes('<script>'));
  const entries = [{ idx: 1, title: '第一讲', chapter: '章节' }];
  assert.ok(!buildCatalogHtml('课程', entries).includes('课程已完结'));
  assert.ok(buildCatalogHtml('课程', entries, true, 2).includes('本次导出 1 / 已发布 2 讲'));
});

// Minimal fake Chrome: all requests stay in memory, and the only fixture article is synthetic.
function fakeChrome() {
  const calls = [], bodies = new Map(); let sequence = 0;
  class Socket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    response(url, body, request = {}) {
      const requestId = String(++sequence); bodies.set(requestId, JSON.stringify(body));
      this.emit({ method: 'Network.requestWillBeSent', params: { requestId, request: { url, postData: JSON.stringify(request) } } });
      this.emit({ method: 'Network.responseReceived', params: { requestId, response: { status: 200 } } });
      this.emit({ method: 'Network.loadingFinished', params: { requestId } });
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw); calls.push({ method, params });
      queueMicrotask(() => {
        let result = {};
        if (method === 'Page.navigate' && params.url.includes('?tab=catalog')) {
          this.response('https://time.geekbang.org/serv/v1/column/articles', { data: { list: [{ id: 456, chapter_id: 1 }] } });
          this.response('https://time.geekbang.org/serv/v1/chapters', { data: [{ id: 1, title: '合成章节' }] });
          this.response('https://time.geekbang.org/serv/v3/column/info', { data: { id: 123, title: '合成课程', is_finish: false, article: { count_pub: 1 } } });
        } else if (method === 'Page.navigate' && params.url.includes('/article/456')) {
          this.response('https://time.geekbang.org/serv/v1/article', { data: { article_title: '合成标题', article_content: '<p>合成正文</p>', column_had_sub: true } }, { id: '456' });
        } else if (method === 'Runtime.evaluate') result = { result: { value: '我的学习 这是已登录的合成课程目录页面' } };
        else if (method === 'Network.getResponseBody') result = { body: bodies.get(params.requestId) };
        this.emit({ id, result });
      });
    }
    close() { this.onclose?.(); }
  }
  return { calls, WebSocket: Socket, fetch: async url => {
    assert.ok(String(url).startsWith('http://127.0.0.1:'));
    return { json: async () => String(url).includes('/json/version') ? { Browser: 'mock' } : { id: 'mock-page', webSocketDebuggerUrl: 'ws://mock' } };
  } };
}

test('only-fetch actually caches the article; only-render never fetches missing articles', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'geektime-test-'));
  const fake = fakeChrome(), previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket, previousExit = process.exitCode;
  globalThis.fetch = fake.fetch; globalThis.WebSocket = fake.WebSocket;
  try {
    const report = await main(args('--cid', '123', '--workdir', dir, '--out', path.join(dir, 'output'), '--only-fetch', '--no-comments'));
    assert.deepEqual(report.fetched, ['456']);
    assert.ok(readFileSync(path.join(dir, 'courses/123/articles/456.json'), 'utf8').includes('合成正文'));
    assert.ok(!existsSync(path.join(dir, 'output')));
    assert.ok(!fake.calls.some(c => c.method === 'Page.printToPDF'));
    rmSync(path.join(dir, 'courses/123/articles/456.json'));
    fake.calls.length = 0;
    const missing = await main(args('--cid', '123', '--workdir', dir, '--out', path.join(dir, 'output'), '--only-render'));
    assert.equal(missing.failed.length, 1); assert.equal(process.exitCode, 2);
    assert.ok(!fake.calls.some(c => c.method === 'Page.navigate'));
  } finally { globalThis.fetch = previousFetch; globalThis.WebSocket = previousSocket; process.exitCode = previousExit; rmSync(dir, { recursive: true, force: true }); }
});
