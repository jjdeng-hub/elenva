---
name: web-research
description: 用 curl 做网页检索与抓取的可靠配方——搜索引擎选择、页面抓取、失败降级、省 token 的阅读方式。Use when you need to look something up online, fetch a web page, or a URL fetch fails (403/429/timeout).
---

# 网页检索与抓取（无浏览器时的配方）

原则：**先搜索拿到候选 URL，再抓单个页面；抓下来的内容落盘，只把需要的片段读进上下文。**

## 搜索

本机（中国大陆服务器）实测：

```bash
Q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('你的关键词'))")
curl -s -m 20 -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" \
  "https://cn.bing.com/search?q=$Q" -o /tmp/search.html
grep -oE 'href="https?://[^"]+"' /tmp/search.html | grep -v bing.com | head -20
```

- 可用：`cn.bing.com`、`www.baidu.com`；`api.github.com`（直连 OK）。
- 不可用（实测）：duckduckgo、r.jina.ai —— 别浪费轮次。

## 抓页面

```bash
curl -sL -m 30 -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" "<URL>" -o /tmp/page.html
# 去脚本/样式，转纯文本（前 4000 字）
python3 -c "import html,re; t=open('/tmp/page.html',encoding='utf-8',errors='ignore').read(); t=re.sub(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>','',t); t=re.sub(r'<[^>]+>',' ',t); print(html.unescape(re.sub(r'\s+',' ',t))[:4000])"
```

要精读时：先 `grep -n` 定位关键词行号，再读那一段——**别把整页塞进上下文**。

## 失败降级（按顺序试）

1. 403 → 换 UA、加 `-H "Referer: <站点首页>"`；稍后重试
2. 429 / 超时 → `-m` 加大、降频、换镜像站
3. JS 渲染的页面 → 找页面内嵌 JSON（`__NEXT_DATA__`、`window.__INITIAL_STATE__`）或站点的 JSON API（常见的 `/api/` 路径）
4. GitHub 的 raw/文件 → 加 `https://gh-proxy.com/` 前缀
5. 完全打不开 → 找替代来源（镜像站、官方文档另一个入口），或如实告诉用户"这个源够不到"

## 纪律

- 引用要记来源 URL + 访问日期；区分"页面原文"与"我的推断"
- 抓不到就说抓不到——**绝不编造网页内容**
