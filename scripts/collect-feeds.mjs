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

/* ---------- 제목 번역 (MyMemory · 키도 결제 계정도 없이 쓴다) ----------
 *
 * 왜: 뉴스리포트의 제목이 TechCrunch·MIT·The Verge·Hacker News·Reddit·arXiv 쪽은
 *     전부 영어라 훑어보기가 어렵다 (대표 2026-08-12).
 *
 * 왜 MyMemory 인가: Google Cloud Translation 은 결제 계정 등록이 필수라 과금 위험이 있어
 *     쓰지 않는다(대표 거부). MyMemory 는 키 없이 HTTP 200 이고, 익명 한도(하루 5,000단어)를
 *     넘겨도 청구되지 않고 그냥 실패한다. 우리가 보내는 건 제목뿐이라 약 1,000단어(한도의 20%)다.
 *     한도를 늘려 주는 de=<이메일> 파라미터는 쓰지 않는다 — 공개 저장소에 개인정보를 넣지 않는다.
 *
 * 규칙:
 *   - 원문 title 은 그대로 두고 titleKo 를 "덧붙인다". 기계번역은 틀릴 때가 있어
 *     원문을 잃으면 되돌릴 방법이 없다
 *   - 이미 한국어인 제목은 건너뛴다 (Google News 한국어 기사)
 *   - 실패·타임아웃이면 titleKo 를 넣지 않는다. 빈 문자열로 채우지 않는다
 *     (화면이 "번역했는데 비었다"와 "번역 안 했다"를 구분할 수 있어야 한다)
 *   - 요약은 번역하지 않는다. 한도와 품질 모두 제목 쪽에 쓰는 편이 낫다
 *   - 번역 때문에 수집이 실패하면 안 된다. 부가 단계다
 */

const TRANSLATE = process.env.NO_TRANSLATE !== "1";
const MM_MAX_CALLS = 140;   // 하루 총 호출 상한. 제목만 ~95건이라 여유가 있지만 폭주를 막는다
const MM_GAP_MS = 1200;     // 연속 호출로 차단당하면 그날 전부 실패한다
const MM_GIVEUP = 5;        // 연속 실패 5회면 더 안 부른다 (네트워크 차단 시 25분을 태우지 않으려고)

let mmCalls = 0, mmStreak = 0, mmStop = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 글자 중 한글 비율. 0.2 이상이면 이미 한국어로 본다 */
function hangulRatio(s) {
  const letters = String(s).match(/[A-Za-z가-힣]/g) || [];
  if (!letters.length) return 1;
  return letters.filter((c) => c >= "가" && c <= "힣").length / letters.length;
}

async function translateKo(text) {
  const j = await get(
    "https://api.mymemory.translated.net/get?langpair=en%7Cko&q=" + encodeURIComponent(text),
    { json: true, timeout: 12000 }
  );
  if (j.quotaFinished) { mmStop = "일일 한도 소진"; throw new Error("quota finished"); }
  if (Number(j.responseStatus) !== 200) throw new Error("responseStatus " + j.responseStatus);
  const out = String(j?.responseData?.translatedText || "").trim();
  /* 실패는 200 안에 대문자 경고문으로 온다("MYMEMORY WARNING…", "QUERY LENGTH LIMIT…").
     한글이 하나도 없으면 번역된 게 아니다. */
  if (!out || !/[가-힣]/.test(out)) throw new Error("번역 결과가 아님");
  if (out === text) throw new Error("원문 그대로 돌아옴");
  return out;
}

async function attachTitleKo(items, label) {
  if (!TRANSLATE) { log(`  · 번역 ${label}: 건너뜀 (NO_TRANSLATE=1)`); return; }
  let ok = 0, skip = 0, fail = 0;
  for (const it of items || []) {
    const t = String(it.title || "").trim();
    if (!t || t.length > 400 || hangulRatio(t) >= 0.2) { skip++; continue; }
    if (mmStop || mmCalls >= MM_MAX_CALLS) { fail++; continue; }
    mmCalls++;
    try {
      it.titleKo = await translateKo(t);
      ok++; mmStreak = 0;
    } catch (e) {
      fail++;
      if (++mmStreak >= MM_GIVEUP && !mmStop) mmStop = `연속 ${MM_GIVEUP}회 실패 (${e.message})`;
    }
    await sleep(MM_GAP_MS);
  }
  log(`  · 번역 ${label}: ${ok}건 붙임 · 한국어라 건너뜀 ${skip} · 실패 ${fail}` +
      (mmStop ? ` — 중단: ${mmStop}` : ""));
}

/* 이전 결과를 그대로 두는 저장 — 수집이 0건이면 쓰지 않는다 */
function save(name, payload, count, opts = {}) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  const path = join(DATA, name);
  if (!count) {
    log(`  ! ${name}: 수집 0건 — 기존 파일을 유지한다 (덮어쓰지 않음)`);
    return false;
  }
  /* compact: 사람이 읽을 일이 없고 덩치가 큰 스냅샷은 들여쓰기 없이 쓴다 (pub 은 228KB 다) */
  const next = JSON.stringify(payload, null, opts.compact ? 0 : 1) + "\n";
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
  const top = items.slice(0, 60);
  await attachTitleKo(top, "뉴스");
  return save("news.json", { generated: NOW, source: okSources.join(" · "), sources: okSources, items: top }, items.length);
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
  await attachTitleKo(items, "커뮤니티");
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
  /* arXiv 논문 제목만 번역한다. GitHub 는 저장소 이름(owner/repo), Hugging Face 는
     모델 ID 라 번역하면 오히려 못 찾는 식별자가 된다. */
  await attachTitleKo(out.arxiv, "arXiv");
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

/* ---------- 5. 관리시스템 응답 스냅샷 (첫 로딩용) ----------
 *
 * 왜: index.html 이 화면을 그리기 전에 Apps Script 를 기다린다. 2026-08-12 실측으로
 *     ?action=pub 은 6.0 ~ 68.5초, ?action=aivideos 는 6.3 ~ 37.7초가 걸렸고
 *     둘 다 세 번에 한 번꼴로 404(HTML 7,954B)를 냈다. 같은 출처의 data/*.json 은 0.05~0.27초다.
 *     그래서 응답을 그대로 떠 두고, 화면은 스냅샷으로 먼저 그린 뒤 살아있는 값으로 조용히 갱신한다.
 *
 * 규칙:
 *   - 주소는 index.html 에서 읽는다. 여기에 옮겨 적으면 재배포로 주소가 바뀔 때 어긋난다
 *     (2026-08-12: 옛 주소를 계속 부르다 다섯 메뉴가 조용히 죽었다)
 *   - 응답을 가공하지 않고 그대로 저장한다. 화면이 라이브와 같은 코드로 읽어야 한다.
 *     generated 도 서버 값 그대로 둔다 — 화면의 "수집 시각"이 거짓이 되면 안 된다
 *   - 기대한 키가 없으면(404 HTML·빈 응답) 기존 파일을 그대로 둔다
 *   - 404 가 잦으므로 몇 번 다시 부른다. 그래도 안 되면 오늘은 갱신하지 않는다
 */

const SNAP_TRIES = 4;
const SNAP_GAP_MS = 5000;

function readEndpoints() {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const pick = (name) => {
    const m = html.match(new RegExp("var\\s+" + name + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : "";
  };
  return { pub: pick("API"), aivideos: pick("AIVIDEO_API") };
}

/* 응답이 valid() 를 통과할 때까지만 다시 부른다. 404 는 HTTP 404 라 get() 이 던진다 */
async function fetchSnapshot(label, url, valid, timeout = 90000) {
  for (let i = 1; i <= SNAP_TRIES; i++) {
    try {
      const j = await get(url, { json: true, timeout });
      if (!valid(j)) throw new Error("기대한 키가 없다");
      log(`  · ${label} ${i}번째 시도에서 받음`);
      return j;
    } catch (e) {
      log(`  ! ${label} ${i}/${SNAP_TRIES} 실패: ${e.message}`);
      if (i < SNAP_TRIES) await sleep(SNAP_GAP_MS);
    }
  }
  return null;
}

async function collectSnapshots() {
  log("[관리시스템 스냅샷]");
  const ep = readEndpoints();
  let wrote = false;

  try {
    if (!ep.pub) throw new Error("index.html 에서 API 주소를 못 읽었다");
    const sep = ep.pub.indexOf("?") >= 0 ? "&" : "?";
    const j = await fetchSnapshot("pub", ep.pub + sep + "action=pub", (x) => x && Array.isArray(x.reports));
    if (j) {
      const n = j.reports.length + (Array.isArray(j.festivals) ? j.festivals.length : 0);
      wrote = save("pub.json", j, n, { compact: true }) || wrote;
      log(`  · pub: 리포트 ${j.reports.length}건 · 영화제 ${(j.festivals || []).length}건 · generated ${j.generated || "미확인"}`);
    } else {
      log("  ! pub: 끝내 못 받음 — 기존 data/pub.json 을 유지한다");
    }
  } catch (e) { log(`  ! pub 실패: ${e.message}`); }

  /* pubgov 는 K-Startup 공고 전체를 훑어 오느라 pub 보다도 느리다 —
     대표 curl 실측에서 2분 타임아웃까지 응답이 없던 적도 있다(2026-08-12). 그 단계만 120초를 준다.
     파일명이 gov.json 이 아니라 gov-pub.json 인 이유: 화면이 부르는 건 action=pubgov 응답이고,
     gov.json 은 쓰는 데가 없다(grep 확인). 나중에 다른 수집이 gov.json 을 쓰더라도 겹치지 않는다. */
  try {
    if (!ep.pub) throw new Error("index.html 에서 API 주소를 못 읽었다");
    const sep = ep.pub.indexOf("?") >= 0 ? "&" : "?";
    const j = await fetchSnapshot("pubgov", ep.pub + sep + "action=pubgov",
      (x) => x && x.ok === true && Array.isArray(x.items) && x.items.length > 0, 120000);
    if (j) {
      wrote = save("gov-pub.json", j, j.items.length, { compact: true }) || wrote;
      log(`  · pubgov: 공고 ${j.items.length}건 · total ${j.total ?? "미확인"} · generated ${j.generated || "미확인"}`);
    } else {
      log("  ! pubgov: 끝내 못 받음 — 기존 data/gov-pub.json 을 유지한다");
    }
  } catch (e) { log(`  ! pubgov 실패: ${e.message}`); }

  try {
    if (!ep.aivideos) throw new Error("index.html 에서 AIVIDEO_API 주소를 못 읽었다");
    const sep = ep.aivideos.indexOf("?") >= 0 ? "&" : "?";
    const j = await fetchSnapshot("aivideos", ep.aivideos + sep + "action=aivideos", (x) => x && x.ok === true && x.generated);
    if (j) {
      const len = (k) => (Array.isArray(j[k]) ? j[k].length : 0);
      const n = len("works") + len("domestic") + len("overseas") + len("news") + len("vibe");
      wrote = save("aivideos.json", j, n, { compact: true }) || wrote;
      log(`  · aivideos: works ${len("works")} · 국내 ${len("domestic")} · 해외 ${len("overseas")} · 뉴스 ${len("news")} · 바이브 ${len("vibe")} · generated ${j.generated}`);
    } else {
      log("  ! aivideos: 끝내 못 받음 — 기존 data/aivideos.json 을 유지한다");
    }
  } catch (e) { log(`  ! aivideos 실패: ${e.message}`); }

  return wrote;
}

/* ---------- AI 공모전 (자체 수집: wevity·devpost·higgsfield 병합) ----------
 * 예전엔 junyeo217/ai-contest-board(남의 저장소)를 그대로 떠 오는 미러였다. 그 저장소 하나가
 * 멈추면 공모전 메뉴 전체가 죽는 단일 장애점이었다. 이제는 우리가 직접 세 소스를 긁는다:
 * 국내는 wevity 목록 스크래핑, 해외는 devpost API 실시간 크롤 + higgsfield 스냅샷.
 * junyeo217 은 살아 있으면 합치고 죽어도 무방한 안전망으로만 쓴다 — 그 독립성이 핵심이다.
 * 소스 하나가 죽어도(try/catch) 나머지로 목록을 채운다.
 */

/* KST(Asia/Seoul) 날짜 헬퍼 — Actions 러너는 UTC 라 +9h 로 옮겨 계산한다 */
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function kstNowIso() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + "+09:00";
}
function addDaysKst(days) {
  return new Date(Date.parse(kstToday() + "T00:00:00+09:00") + days * 86400000).toISOString().slice(0, 10);
}

/* ---- wevity 스크래핑 (proto.mjs 에서 이식, 실측 검증됨) ---- */
const CT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const KW = ["AI", "인공지능", "생성형", "LLM", "챗봇", "데이터", "머신러닝", "딥러닝",
  "영상", "UCC", "숏폼", "쇼츠", "영화", "다큐", "광고", "마케팅",
  "디자인", "캐릭터", "웹툰", "일러스트", "브랜드", "BI", "포스터",
  "콘텐츠", "웹/모바일/IT", "게임", "메타버스", "사진"];
const decodeEnt = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
const strip = (s) => decodeEnt(String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
const matchKW = (item) => {
  const hay = (item.title + " " + item.categories);
  return KW.some((k) => hay.toLowerCase().includes(k.toLowerCase()));
};

function parseWevity(html) {
  const out = [];
  const ulStart = html.indexOf('class="list"');
  if (ulStart < 0) return out;
  const seg = html.slice(ulStart, html.indexOf("</ul>", ulStart));
  const liBlocks = seg.split(/<li\b/).slice(1);
  for (const b of liBlocks) {
    if (/class="top"/.test(b)) continue;          // header row
    const aMatch = b.match(/<a href="(\?c=find[^"]*ix=(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!aMatch) continue;
    const href = decodeEnt(aMatch[1]);
    const ix = aMatch[2];
    let title = strip(aMatch[3]).replace(/\s*SPECIAL\s*$/i, "").trim();
    const subM = b.match(/class="sub-tit">([\s\S]*?)<\/div>/);
    const cats = subM ? strip(subM[1]).replace(/^분야\s*:\s*/, "") : "";
    const organM = b.match(/class="organ">([\s\S]*?)<\/div>/);
    const organ = organM ? strip(organM[1]) : "";
    const dayM = b.match(/class="day">([\s\S]*?)<\/div>/);
    const dayRaw = dayM ? strip(dayM[1]) : "";
    const ddayM = dayRaw.match(/D-\d+|D-DAY|마감/i);
    out.push({
      title, url: "https://www.wevity.com/" + href, ix,
      organizer: organ, categories: cats,
      deadline_dday: ddayM ? ddayM[0] : dayRaw,
      status: /접수중/.test(dayRaw) ? "ongoing" : (/마감|D-DAY/.test(dayRaw) ? "closing" : "unknown"),
    });
  }
  return out;
}

async function collectWevity(pages) {
  let all = [];
  for (let gp = 1; gp <= pages; gp++) {
    const url = `https://www.wevity.com/?c=find&s=1&gp=${gp}`;
    const html = await get(url, { headers: { "user-agent": CT_UA, "accept-language": "ko" } });
    const rows = parseWevity(html);
    if (!rows.length) break;                       // 목록이 비면 마지막 페이지를 지난 것
    all = all.concat(rows);
  }
  const seen = new Set(); const dedup = [];
  for (const r of all) { if (!seen.has(r.ix)) { seen.add(r.ix); dedup.push(r); } }
  return dedup.filter(matchKW);
}

async function collectContests() {
  log("[공모전 자체수집]");
  const today = kstToday();
  const domestic = [];   // 국내 pool (우리 소스)
  const overseas = [];   // 해외 pool (우리 소스)
  const contrib = { wevity: 0, devpost: 0, higgsfield: 0, junyeoDom: 0, junyeoOvr: 0 };
  let junyeoDomOk = false, junyeoOvrOk = false;

  /* 1. 국내 = wevity 스크래핑 */
  try {
    const rows = await collectWevity(40);
    for (const r of rows) {
      const m = String(r.deadline_dday || "").match(/D-?(\d+)/i);
      const end = m ? addDaysKst(parseInt(m[1], 10)) : today;   // 숫자 없으면(마감/D-DAY) 오늘
      domestic.push({
        title: r.title,
        category: r.categories || "AI",
        organizer: r.organizer,
        submission_start: "",
        submission_end: end,
        result_date: "미정",
        url: r.url,
        source_type: "aggregator",
        discovery_source: "wevity",
        summary: r.categories || "",
        status: r.status === "ongoing" ? "진행중" : "마감임박",
      });
    }
    contrib.wevity = rows.length;
    log(`  · wevity ${rows.length}건`);
  } catch (e) { log(`  ! wevity 실패: ${e.message}`); }

  /* 2. 해외 = devpost 실시간 크롤 */
  try {
    const seenUrl = new Set();
    let n = 0;
    for (let page = 1; page <= 8; page++) {
      const j = await get(`https://devpost.com/api/hackathons?search=ai&page=${page}`, { json: true });
      const list = j.hackathons || [];
      if (!list.length) break;
      for (const h of list) {
        const url = String(h.url || "");
        if (!url || seenUrl.has(url)) continue;
        const themes = (h.themes || []).map((t) => t.name).filter(Boolean);
        const isAI = themes.some((t) => /AI|Machine Learning/i.test(t));
        const state = h.open_state || "";
        if (!isAI || !(state === "open" || state === "upcoming")) continue;
        seenUrl.add(url);
        const parts = String(h.submission_period_dates || "").split(" - ");
        const ds = new Date(parts[0]);
        const de = new Date(parts[parts.length - 1]);
        const prize = String(h.prize_amount || "").replace(/<[^>]+>/g, "").trim();
        overseas.push({
          title: String(h.title || "").trim(),
          category: "AI 해커톤",
          organizer: "Devpost",
          country: h.displayed_location?.location || "Global",
          submission_start: isNaN(ds) ? "" : ds.toISOString().slice(0, 10),
          submission_end: isNaN(de) ? "" : de.toISOString().slice(0, 10),
          result_date: "미정",
          url,
          source_type: "hackathon",
          discovery_source: "devpost",
          summary: prize ? ("상금 " + prize) : String(h.title || "").trim(),
          status: state === "open" ? "진행중" : "예정",
        });
        n++;
      }
    }
    contrib.devpost = n;
    log(`  · devpost ${n}건`);
  } catch (e) { log(`  ! devpost 실패: ${e.message}`); }

  /* higgsfield 스냅샷 병합 (data/higgsfield.json 은 다른 수집기가 떠 둔다) */
  try {
    const hf = JSON.parse(readFileSync(join(DATA, "higgsfield.json"), "utf8"));
    let n = 0;
    for (const it of hf.items || []) {
      overseas.push({
        title: it.title,
        category: "AI 영상",
        organizer: "Higgsfield",
        country: "Global",
        submission_start: "",
        submission_end: "",                        // "Jul 27 – Aug 24" 처럼 연도가 없어 추측 안 함
        result_date: "미정",
        url: it.url,
        source_type: "hackathon",
        discovery_source: "higgsfield",
        summary: it.desc || it.prize || "",
        status: /open/i.test(it.status || "") ? "진행중" : "예정",
      });
      n++;
    }
    contrib.higgsfield = n;
    log(`  · higgsfield ${n}건`);
  } catch (e) { log(`  ! higgsfield 실패: ${e.message}`); }

  /* 3. junyeo217 안전망 — 성공하면 합치고, 실패(404/네트워크)해도 우리 소스로 계속한다 */
  const junyeoDom = [], junyeoOvr = [];
  const pullJunyeo = (j, pool) => {
    for (const k of ["starting_today", "ongoing", "awaiting_results"]) {
      for (const it of (j.sections && j.sections[k]) || []) pool.push(it);
    }
  };
  try {
    const j = await get("https://junyeo217.github.io/ai-contest-board/data/contests.json", { json: true });
    pullJunyeo(j, junyeoDom);
    junyeoDomOk = true; contrib.junyeoDom = junyeoDom.length;
    log(`  · junyeo217 국내 성공 ${junyeoDom.length}건`);
  } catch (e) { log(`  ! junyeo217 국내 실패(무시): ${e.message}`); }
  try {
    const j = await get("https://junyeo217.github.io/ai-contest-board/data/overseas-contests.json", { json: true });
    pullJunyeo(j, junyeoOvr);
    junyeoOvrOk = true; contrib.junyeoOvr = junyeoOvr.length;
    log(`  · junyeo217 해외 성공 ${junyeoOvr.length}건`);
  } catch (e) { log(`  ! junyeo217 해외 실패(무시): ${e.message}`); }

  /* 4. 지역별 중복 제거 — junyeo217 원본을 먼저 넣어 우선 보존하고, 우리 소스는 키가 겹치면 버린다 */
  const dedup = (junyeo, ours) => {
    /* 제목 정규화: 공백·구두점·밑줄만 지우고 글자/숫자는 유지한다. \W 는 유니코드를 몰라
       한글을 전부 지워 버려서(예: "2026년 남원 숏폼…" → "2026") 서로 다른 국내 공모전이
       무더기로 같은 키가 돼 잘못 제거됐다. \p{L}\p{N} 로 한글을 살려 진짜 중복만 잡는다. */
    const normTitle = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    /* host+path 만 쓰면 쿼리로 id 를 넘기는 wevity(?...&ix=110051)가 전부 "www.wevity.com"
       한 키로 뭉쳐 1건만 남는다. search 까지 넣어 항목을 구분한다. 서로 다른 소스는 host 가
       달라 어차피 url 로는 안 겹치므로(교차 중복은 제목으로 잡는다) search 를 넣어도 안전하다. */
    const normUrl = (u) => {
      try { const x = new URL(u); return (x.host + x.pathname + x.search).toLowerCase().replace(/\/+$/, ""); }
      catch { return String(u || "").toLowerCase(); }
    };
    const titles = new Set(), urls = new Set(), out = [];
    for (const it of junyeo) { titles.add(normTitle(it.title)); urls.add(normUrl(it.url)); out.push(it); }
    for (const it of ours) {
      const tk = normTitle(it.title), uk = normUrl(it.url);
      if (titles.has(tk) || urls.has(uk)) continue;
      titles.add(tk); urls.add(uk); out.push(it);
    }
    return out;
  };
  const domPool = dedup(junyeoDom, domestic);
  const ovrPool = dedup(junyeoOvr, overseas);

  /* 5. KST 오늘 기준 버킷팅 — 모든 항목에 동일 적용 */
  const bucket = (items) => {
    const sec = { starting_today: [], ongoing: [], awaiting_results: [] };
    for (const it of items) {
      const s = it.submission_start, e = it.submission_end;
      if (s && s === today) sec.starting_today.push(it);
      else if (!e) sec.ongoing.push(it);            // 마감일 불명은 보이게 유지
      else if (e >= today) sec.ongoing.push(it);    // YYYY-MM-DD 문자열 비교로 충분
      else sec.awaiting_results.push(it);
    }
    return sec;
  };

  /* 6. 저장 */
  const notice = "AI 레이더 자체 수집 (wevity·devpost·higgsfield 병합)";
  const genAt = kstNowIso();
  const domCount = domPool.length, ovrCount = ovrPool.length;
  let wrote = false;
  wrote = save("contests.json", { generated_at: genAt, notice, sections: bucket(domPool) }, domCount, { compact: true }) || wrote;
  wrote = save("overseas-contests.json", { generated_at: genAt, notice, sections: bucket(ovrPool) }, ovrCount, { compact: true }) || wrote;
  log(`  · 국내 합계 ${domCount} (wevity ${contrib.wevity} + junyeo217 ${contrib.junyeoDom}${junyeoDomOk ? "" : "[실패]"}, 중복 제거 후)`);
  log(`  · 해외 합계 ${ovrCount} (devpost ${contrib.devpost} + higgsfield ${contrib.higgsfield} + junyeo217 ${contrib.junyeoOvr}${junyeoOvrOk ? "" : "[실패]"}, 중복 제거 후)`);
  return wrote;
}

/* ---------- 실행 ---------- */

const only = process.argv[2];   // 인자를 주면 그 수집기만 돈다 (예: node collect-feeds.mjs contests)
const results = [];
for (const [name, fn] of [["news", collectNews], ["community", collectCommunity], ["tech", collectTech], ["devpost", collectDevpost], ["contests", collectContests], ["snapshots", collectSnapshots]]) {
  if (only && name !== only) continue;
  try {
    results.push([name, await fn()]);
  } catch (e) {
    log(`! ${name} 전체 실패: ${e.stack || e.message}`);
    results.push([name, false]);
  }
}
log("\n=== 결과 ===");
results.forEach(([n, ok]) => log(`${ok ? "갱신" : "유지"}  ${n}`));
