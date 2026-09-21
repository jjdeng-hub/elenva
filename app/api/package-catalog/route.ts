import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Pi 包目录搜索。
 *
 * 数据源是 npm registry 的官方搜索 API —— pi 包在 npm 上以 `pi-package` 关键词标记。
 *
 * ⚠️ 实测两个必须自己处理的坑（都在这里修掉了）：
 *  1. **npm 的关键词限定是模糊的**：`keywords:pi-package` 的 total 是 9743，
 *     把 pi-package 当普通词拆开匹配。所以必须按返回的 `keywords` 精确再筛一次。
 *  2. **npm 的自由文本不匹配也会返回结果**：查 `zzzz keywords:pi-package` 依然返回
 *     9743 条（只是打分变低）。直接把结果给用户就是「搜什么都是 60 条、看起来随机」。
 *     所以查询词必须在 name / description / keywords 里**真的出现**才算命中。
 *
 * 排序也自己定：按月下载量降序。npm 的 relevance 分在它自己的量纲里（44 vs 277），
 * 且 popularity/quality/maintenance 多项饱和到 1，区分度不如下载量。
 */
const REGISTRY_SEARCH = "https://registry.npmjs.org/-/v1/search";
/**
 * star 数据源用 shields.io 而不是 api.github.com。
 * 未认证的 GitHub API 只有 60 次/小时 —— 一页 30 个包就烧掉一半，第二页就没了。
 * shields.io 的 .json 端点没有这个限制（实测 30 并发全成功，~2.4s），代价是稍慢一点。
 */
const SHIELDS_STARS = "https://img.shields.io/github/stars";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
/** 向 npm 一次拉取的候选数：过滤后要够填满 limit，所以取一个较大的池子 */
const FETCH_SIZE = 250;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** star 缓存：比目录缓存长得多，因为 star 几乎不变，而拉取有成本 */
const STAR_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次请求最多补多少个包的 star（与分页大小对齐，保证每一行都有） */
const STAR_BUDGET = 30;

export type CatalogItem = {
  name: string;
  version?: string;
  description?: string;
  /** 最后发布时间（ISO） */
  date?: string;
  keywords?: string[];
  /** npm 月下载量 —— 主排序依据 */
  downloads?: number;
  /** GitHub star（拿不到就不返回，前端不显示） */
  stars?: number;
  repository?: string;
};

type CacheEntry = { at: number; items: CatalogItem[] };
const cache = new Map<string, CacheEntry>();

const starCache = new Map<string, { at: number; stars: number | null }>();

/** npm 的 keyword 是模糊匹配，这里按真实 keywords 再筛一次 */
function isPiPackage(keywords: unknown): boolean {
  return Array.isArray(keywords) && keywords.some((k) => String(k).toLowerCase() === "pi-package");
}

/** 查询词是否真的命中：名字 / 描述 / 关键词里出现即算（大小写不敏感的子串包含） */
function matchesQuery(pkg: { name: string; description?: string; keywords?: string[] }, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  // 多词查询按「每个词都命中」处理（AND），比 npm 的 OR 式相关度更符合直觉
  const terms = needle.split(/\s+/).filter(Boolean);
  const haystack = [pkg.name, pkg.description ?? "", (pkg.keywords ?? []).join(" ")].join(" ").toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function parseLimit(raw: string | null): number {
  // 注意 Number(null) === 0（不是 NaN），未传参时必须先短路，否则会被压到 1
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(num)));
}

function repoSlugFromLinks(links: Record<string, unknown> | undefined): string | undefined {
  const raw = typeof links?.repository === "string" ? links.repository : undefined;
  if (!raw) return undefined;
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(raw);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** 把 shields.io 的显示值（"1.2k"/"105k"/"156"/"1,234"）还原成数字，用于排序与展示 */
function parseStarValue(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/,/g, "");
  const m = /^([\d.]+)\s*([kKmM])?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return Math.round(unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n);
}

/** 取 star（带 24h 缓存）。拉不到就返回 null —— 只是不显示，不影响主流程 */
async function fetchStars(slug: string): Promise<number | null> {
  const hit = starCache.get(slug);
  if (hit && Date.now() - hit.at < STAR_TTL_MS) return hit.stars;
  try {
    const res = await fetch(`${SHIELDS_STARS}/${slug}.json`, {
      headers: { "User-Agent": "elenva-web" },
      cache: "no-store",
    });
    if (!res.ok) {
      starCache.set(slug, { at: Date.now(), stars: null });
      return null;
    }
    const d = (await res.json()) as { message?: unknown };
    const stars = parseStarValue(d.message);
    starCache.set(slug, { at: Date.now(), stars });
    return stars;
  } catch {
    starCache.set(slug, { at: Date.now(), stars: null });
    return null;
  }
}

// GET /api/package-catalog?q=memory&limit=30
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const limit = parseLimit(searchParams.get("limit"));

  const key = `${q}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ results: hit.items, cached: true });
  }

  const text = q ? `${q} keywords:pi-package` : "keywords:pi-package";
  const url = `${REGISTRY_SEARCH}?text=${encodeURIComponent(text)}&size=${FETCH_SIZE}`;

  try {
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "elenva-web" } });
    if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
    const data = (await res.json()) as {
      objects?: {
        downloads?: { monthly?: number };
        package?: {
          name?: string;
          version?: string;
          description?: string;
          date?: string;
          keywords?: unknown;
          links?: Record<string, unknown>;
        };
      }[];
    };

    const items: CatalogItem[] = [];
    for (const obj of data.objects ?? []) {
      const pkg = obj.package;
      if (!pkg || typeof pkg.name !== "string") continue;
      if (!isPiPackage(pkg.keywords)) continue;
      // 关键：npm 会把不匹配的也返回，必须自己判命中
      if (!matchesQuery({ name: pkg.name, description: pkg.description, keywords: (pkg.keywords as string[]) }, q)) {
        continue;
      }
      const slug = repoSlugFromLinks(pkg.links);
      items.push({
        name: pkg.name,
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        description: typeof pkg.description === "string" ? pkg.description : undefined,
        date: typeof pkg.date === "string" ? pkg.date : undefined,
        keywords: Array.isArray(pkg.keywords) ? (pkg.keywords as unknown[]).map(String).slice(0, 6) : undefined,
        downloads: typeof obj.downloads?.monthly === "number" ? obj.downloads.monthly : undefined,
        repository: slug ? `https://github.com/${slug}` : undefined,
        ...(slug ? { __slug: slug } as never : {}),
      });
    }

    /* 排序：月下载量降序，其次按最近发布（下载量缺失的沉底）。
       这样「哪个更值得装」有可见依据，而不是 npm 内部的相关度分。 */
    items.sort((a, b) => {
      const ad = a.downloads ?? -1;
      const bd = b.downloads ?? -1;
      if (bd !== ad) return bd - ad;
      return (b.date ?? "").localeCompare(a.date ?? "");
    });

    const page = items.slice(0, limit);

    /* star 富化：只补当前这一页的前 STAR_BUDGET 个，且并发（未认证限流时静默跳过） */
    await Promise.all(
      page.slice(0, STAR_BUDGET).map(async (item) => {
        const slug = (item as CatalogItem & { __slug?: string }).__slug;
        if (!slug) return;
        const stars = await fetchStars(slug);
        if (stars !== null) item.stars = stars;
      }),
    );
    for (const item of page) delete (item as CatalogItem & { __slug?: string }).__slug;

    cache.set(key, { at: Date.now(), items: page });
    return NextResponse.json({ results: page, total: items.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
