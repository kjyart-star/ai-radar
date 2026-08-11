/* AI 레이더 — 공개 소스 수집기 (의존성 없음, Node 20+ 내장 fetch)
 *
 * 왜 이 파일이 있나:
 *   아래 소스들은 CORS 헤더를 주지 않아 정적 페이지(index.html)에서 직접 못 부른다.
 *   그래서 GitHub Actions 가 하루 한 번 여기서 받아 data/*.json 으로 커밋하고,
 *   화면은 같은 출처(자기 저장소)의 JSON 만 읽는다. Apps Script 할당량을 쓰지 않는다.
 *
 * 원칙:
 *   - 소스 하나가 죽어도 나머지는 수집한다 (각각 try/catch)
 *   - 실패한 소스는 기존 파일을 덮어쓰지 않는다 (빈 배열로 덮으면 "없어졌다"고 오해한다)
 *   - 결과 JSON 에는 generated(ISO) 와 source 를 반드시 넣는다
 *   - 비밀값을 쓰지 않는다. 전부 키 불필요한 공개 엔드포인트다
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const UA = "Mozilla/5.0 (compatible; ai-radar-bot/1.0; +https://kjyart-star.github.io/ai-radar/)";
const NOW = new Date().toISOString();

const log = (...a) => console.log(...a);

/* ---------- 공통 ---------- */

async function get(url, { json = false, timeout = 45000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: json ? "application/json" : "application/rss+xml, application/xml, text/xml, */*", ...headers },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return json ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* 최소 XML 파서 — RSS 2.0 <item> 과 Atom <entry> 를 같은 모양으로 뽑는다.
   외부 의존성을 넣지 않으려고 정규식으로 처리한다. 피드 4~6개짜리 고정 형식이라
   범용 파서가 필요 없고, npm install 이 없으면 Actions 가 그만큼 빨라진다. */
function unwrapCdata(s) {
  return String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}
function entities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
/* 엔티티를 먼저 풀고 나서 태그를 지운다.
   Google News 의 <description> 은 HTML 이 엔티티로 인코딩돼 온다(&lt;a href=…&gt;).
   태그를 먼저 지우면 그건 태그로 안 보여서 살아남고, 그 다음 엔티티를 풀면
   화면에 <a href="https://…"> 가 글자 그대로 찍힌다. 실제로 그렇게 나갔다. */
function decode(s) {
  let t = entities(unwrapCdata(s ?? ""));
  t = t.replace(/<[^>]+>/g, " ");
  return entities(t).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? m[1] : "";
}
function atomLink(block) {
  // <link href="..." rel="alternate"/> 또는 <link>...</link>
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/>/i);
  if (alt) return alt[1];
  return decode(tag(block, "link"));
}
function isoDate(s) {
  const d = new Date(String(s || "").trim());
  return isNaN(d) ? "" : d.toISOString();
}
function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => {
    const title = decode(tag(b, "title"));
    const url = atomLink(b);
    const date = isoDate(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const summary = decode(tag(b, "description") || tag(b, "summary") || tag(b, "content"));
    return { title, url: decode(url), date, summary };
  }).filter((x) => x.title && /^https?:\/\//.test(x.url));
}

/* 이전 결과를 그대로 두는 저장 — 수집이 0건이면 쓰지 않는다 */
function save(name, payload, count) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  const path = join(DATA, name);
  if (!count) {
    log(`  ! ${name}: 수집 0건 — 기존 파일을 유지한다 (덮어쓰지 않음)`);
    return false;
  }
  const next = JSON.stringify(payload, null, 1) + "\n";
  writeFileSync(path, next, "utf8");
  log(`  ✓ ${name}: ${count}건`);
  return true;
}

/* ---------- 1. AI 뉴스 ---------- */

const NEWS_FEEDS = [
  ["Google News", "https://news.google.com/rss/search?q=AI&hl=ko&gl=KR&ceid=KR:ko", 20],
  ["TechCrunch", "https://techcrunch.com/category/artificial-intelligence/feed/", 15],
  ["MIT Technology Review", "https://www.technologyreview.com/topic/artificial-intelligence/feed", 15],
  ["The Verge", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", 15],
];

async function collectNews() {
  log("[뉴스]");
  const items = [];
  const okSources = [];
  for (const [name, url, cap] of NEWS_FEEDS) {
    try {
      const xml = await get(url);
      const got = parseFeed(xml).slice(0, cap).map((x) => {
        /* Google News 제목은 "기사 제목 - 매체명" 형태다. 매체명을 출처로 떼어낸다 —
           "Google News" 라고만 쓰면 어느 언론사 기사인지 알 수 없다. */
        let title = x.title, src = name;
        if (name === "Google News") {
          const m = x.title.match(/^([\s\S]+?)\s+-\s+([^-]{2,40})$/);
          if (m) { title = m[1].trim(); src = m[2].trim(); }
        }
        /* Google News 의 요약은 "제목 + 매체명"이라 새로 알려주는 게 없다.
           화면에 제목과 매체를 이미 따로 보여주므로 같은 말을 세 번 하게 된다 — 비운다.
           특정 피드를 지목하지 않고 "요약이 제목으로 시작하면"으로 판정한다. */
        const flat = (t) => String(t).replace(/\s+/g, "").toLowerCase();
        let summary = x.summary.slice(0, 220);
        if (title && flat(summary).indexOf(flat(title)) === 0) summary = "";
        return { title, url: x.url, date: x.date, source: src, feed: name, summary };
      });
      items.push(...got);
      okSources.push(name);
      log(`  · ${name} ${got.length}건`);
    } catch (e) {
      log(`  ! ${name} 실패: ${e.message}`);
    }
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return save("news.json", { generated: NOW, source: okSources.join(" · "), sources: okSources, items: items.slice(0, 60) }, items.length);
}

/* ---------- 2. 커뮤니티 (Hacker News · Reddit) ---------- */

async function collectCommunity() {
  log("[커뮤니티]");
  const items = [];
  const okSources = [];

  try {
    const xml = await get("https://hnrss.org/newest?q=AI&points=50");
    const got = parseFeed(xml).slice(0, 20).map((x) => {
      const pts = (x.summary.match(/Points:\s*(\d+)/i) || [])[1] || "";
      const cmt = (x.summary.match(/Comments:\s*(\d+)/i) || [])[1] || "";
      return { title: x.title, url: x.url, date: x.date, source: "Hacker News", points: pts ? +pts : null, comments: cmt ? +cmt : null, summary: "" };
    });
    items.push(...got); okSources.push("Hacker News");
    log(`  · Hacker News ${got.length}건`);
  } catch (e) { log(`  ! Hacker News 실패: ${e.message}`); }

  try {
    // .json 은 403 이라 RSS 를 쓴다 (2026-08-12 실측)
    const xml = await get("https://www.reddit.com/r/artificial/top/.rss?t=day");
    const got = parseFeed(xml).slice(0, 20).map((x) => ({
      title: x.title, url: x.url, date: x.date, source: "r/artificial",
      points: null, comments: null, summary: x.summary.slice(0, 200),
    }));
    items.push(...got); okSources.push("r/artificial");
    log(`  · Reddit r/artificial ${got.length}건`);
  } catch (e) { log(`  ! Reddit 실패: ${e.message}`); }

  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return save("community.json", { generated: NOW, source: okSources.join(" · "), sources: okSources, items }, items.length);
}

/* ---------- 3. 기술 동향 (arXiv · GitHub · Hugging Face) ---------- */

async function collectTech() {
  log("[기술 동향]");
  const out = { generated: NOW, source: "", sources: [], arxiv: [], github: [], huggingface: [] };
  const ok = [];

  try {
    const xml = await get("https://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=20&sortBy=submittedDate&sortOrder=descending");
    out.arxiv = parseFeed(xml).slice(0, 20).map((x) => ({
      title: x.title, url: x.url, date: x.date, summary: x.summary.slice(0, 220),
    }));
    if (out.arxiv.length) { ok.push("arXiv cs.AI"); log(`  · arXiv ${out.arxiv.length}건`); }
  } catch (e) { log(`  ! arXiv 실패: ${e.message}`); }

  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const headers = process.env.GITHUB_TOKEN ? { authorization: "Bearer " + process.env.GITHUB_TOKEN } : {};
    const j = await get(
      `https://api.github.com/search/repositories?q=topic:ai+pushed:>${since}&sort=stars&order=desc&per_page=20`,
      { json: true, headers: { accept: "application/vnd.github+json", ...headers } }
    );
    out.github = (j.items || []).slice(0, 20).map((r) => ({
      title: r.full_name, url: r.html_url, stars: r.stargazers_count,
      language: r.language || "", date: r.pushed_at || "",
      summary: String(r.description || "").slice(0, 200),
    }));
    if (out.github.length) { ok.push("GitHub"); log(`  · GitHub ${out.github.length}건`); }
  } catch (e) { log(`  ! GitHub 실패: ${e.message}`); }

  try {
    const j = await get("https://huggingface.co/api/models?sort=trendingScore&limit=20", { json: true });
    out.huggingface = (j || []).slice(0, 20).map((m) => ({
      title: m.modelId || m.id, url: "https://huggingface.co/" + (m.modelId || m.id),
      downloads: m.downloads ?? null, likes: m.likes ?? null,
      task: m.pipeline_tag || "", date: m.lastModified || m.createdAt || "",
    }));
    if (out.huggingface.length) { ok.push("Hugging Face"); log(`  · Hugging Face ${out.huggingface.length}건`); }
  } catch (e) { log(`  ! Hugging Face 실패: ${e.message}`); }

  out.sources = ok;
  out.source = ok.join(" · ");
  return save("tech.json", out, out.arxiv.length + out.github.length + out.huggingface.length);
}

/* ---------- 4. Devpost 해커톤·공모전 ---------- */

async function collectDevpost() {
  log("[Devpost]");
  const items = [];
  const seen = new Set();
  let total = null;
  for (let page = 1; page <= 6; page++) {
    try {
      const j = await get(`https://devpost.com/api/hackathons?search=ai&page=${page}`, { json: true });
      if (total == null) total = j.meta?.total_count ?? null;
      const list = j.hackathons || [];
      if (!list.length) break;
      for (const h of list) {
        const url = String(h.url || "");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        items.push({
          title: String(h.title || "").trim(),
          url,
          state: h.open_state || "",
          dates: String(h.submission_period_dates || "").trim(),
          time_left: String(h.time_left_to_submission || "").trim(),
          prize: String(h.prize_amount || "").replace(/<[^>]+>/g, "").trim(),
          themes: (h.themes || []).map((t) => t.name).filter(Boolean),
          location: h.displayed_location?.location || "",
          thumbnail: h.thumbnail_url ? (String(h.thumbnail_url).startsWith("//") ? "https:" + h.thumbnail_url : h.thumbnail_url) : "",
          registrations: h.registrations_count ?? null,
        });
      }
    } catch (e) {
      log(`  ! page ${page} 실패: ${e.message}`);
      break;
    }
  }
  /* 접수 중 → 예정 → 종료 순, 같은 상태 안에서는 상금이 큰 순.
     2,151건 중 54건만 보여주므로 "지금 낼 수 있고 상금이 큰 것"이 위로 와야 한다. */
  const rank = (s) => (s === "open" ? 0 : s === "upcoming" ? 1 : 2);
  const money = (s) => Number(String(s || "").replace(/[^\d]/g, "")) || 0;
  items.sort((a, b) => rank(a.state) - rank(b.state) || money(b.prize) - money(a.prize));
  log(`  · Devpost 전체 ${total ?? "미확인"}건 중 ${items.length}건 수집`);
  return save("devpost.json", {
    generated: NOW, source: "Devpost", total_on_devpost: total,
    search: "ai", items,
  }, items.length);
}

/* ---------- 실행 ---------- */

const results = [];
for (const [name, fn] of [["news", collectNews], ["community", collectCommunity], ["tech", collectTech], ["devpost", collectDevpost]]) {
  try {
    results.push([name, await fn()]);
  } catch (e) {
    log(`! ${name} 전체 실패: ${e.stack || e.message}`);
    results.push([name, false]);
  }
}
log("\n=== 결과 ===");
results.forEach(([n, ok]) => log(`${ok ? "갱신" : "유지"}  ${n}`));
