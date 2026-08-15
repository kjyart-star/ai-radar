#!/usr/bin/env node
// AI 레이더 — 검색 노출용 정적 페이지 생성
//
// 왜 필요한가:
//   화면(index.html)은 해시 라우팅 SPA 라서 크롤러가 개별 공모전·영화제·지원사업을
//   따로 색인할 수 없다. 같은 데이터를 항목마다 하나의 HTML 파일로 미리 찍어두면
//   검색엔진이 항목 단위로 색인하고, 사람은 거기서 SPA 로 넘어온다.
//
// 원칙:
//   - 슬러그는 한 번 정하면 바꾸지 않는다 (data/slugs.json 이 원본)
//   - 데이터에서 빠진 항목의 HTML 은 지우지 않는다 (이미 색인된 주소를 404 로 만들지 않는다)
//   - 날짜가 "미정" 이면 JSON-LD 에 날짜 필드를 아예 넣지 않는다
//   - 자동 리다이렉트 없음. 사람이 눌러서 이동한다
//   - 외부 의존성 없음 (Node 20 표준 라이브러리만)
//
// 도메인을 옮길 때:
//   아래 SITE_ORIGIN / SITE_BASE 두 줄만 고치고 워크플로(.github/workflows/collect.yml)를
//   한 번 돌리면 canonical·og:url·og:image·JSON-LD url·sitemap.xml·robots.txt 가 모두 새 주소로 다시 찍힌다.
//   주소를 여기 말고 다른 곳에 적지 않는다.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 주소는 이 두 줄에만 둔다. 나머지는 전부 여기서 조립한다.
// 자체 도메인(CNAME)이라 저장소가 도메인 루트에 서빙된다 — 프로젝트 경로 접두어가 없다.
// github.io 프로젝트 사이트로 되돌릴 일이 있으면 SITE_BASE 를 `${SITE_ORIGIN}/저장소이름` 으로 바꾼다.
const SITE_ORIGIN = "https://ai-radar.kr";
const SITE_BASE = SITE_ORIGIN;

const SITE_NAME = "AI 레이더";
const OG_IMAGE = `${SITE_BASE}/assets/og-cover.png`; // 1200×630 공용 대표 이미지

// GA4 측정 ID 도 주소와 같은 규칙 — 여기 한 줄에만 두고 나머지는 조립해 쓴다.
const GA_ID = "G-9FBZV3FKFK";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

/* ── 문자열 유틸 ─────────────────────────────────────────────── */

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

const clip = (v, n) => {
  const s = norm(v);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
};

const hash6 = (key) => createHash("sha1").update(key).digest("hex").slice(0, 6);

function slugBase(text) {
  const s = norm(text)
    .normalize("NFC")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return s || "item";
}

/* ── 날짜 ────────────────────────────────────────────────────── */

// "2026-09-11" / "2026-09-11 예정" → "2026-09-11".  "미정" / "" / 그 외 → null
//
// 2015년 이전은 버린다: Devpost 수집분에 시작일이 "2001-10-16" 으로 들어온 항목이 있다
// (2026년 해커톤인데 연도만 2001). 형식은 맞지만 구조화 데이터로 내보내면 안 되는 값이다.
function isoDate(v) {
  const s = norm(v);
  if (!s || s === "미정") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (+y < 2015 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}

const shortDate = (v) => {
  const iso = isoDate(v);
  return iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : null;
};

const dateOf = (stamp) => {
  const m = norm(stamp).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : today;
};

// today → iso 까지 남은 일수. 날짜 문자열을 그대로 Date 에 넣으면 실행 서버의
// 표준시대·서머타임에 따라 하루가 밀린다. 연·월·일을 떼어 Date.UTC 로만 계산한다.
const dday = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
};

// 남은 일수 표시. 이미 지난 날짜는 null — 지난 마감을 "D--3" 으로 보여줄 이유가 없다.
const ddayLabel = (v) => {
  const iso = isoDate(v);
  if (!iso) return null;
  const n = dday(iso);
  return n === 0 ? "오늘 마감" : n > 0 ? `D-${n}` : null;
};

// 아직 접수 중인가 — ISO 문자열은 사전순 비교가 곧 날짜 비교다
const stillOpen = (v) => {
  const iso = isoDate(v);
  return iso && iso >= today ? iso : null;
};

/* ── 슬러그 대장 ─────────────────────────────────────────────── */

const SLUGS_PATH = join(ROOT, "data", "slugs.json");
let slugStore = { version: 1, entries: {} };
if (existsSync(SLUGS_PATH)) {
  try {
    const parsed = JSON.parse(readFileSync(SLUGS_PATH, "utf8"));
    if (parsed && parsed.entries) slugStore = { version: 1, entries: parsed.entries };
  } catch {
    console.warn("slugs.json 을 읽지 못해 새로 만든다");
  }
}

// 같은 종류(contest/festival/funding) 안에서만 슬러그 충돌을 본다
const takenByKind = new Map();
for (const [key, entry] of Object.entries(slugStore.entries)) {
  const kind = key.split("|")[0];
  if (!takenByKind.has(kind)) takenByKind.set(kind, new Map());
  takenByKind.get(kind).set(entry.slug, key);
}

function slugFor(kind, identityKey, title) {
  const existing = slugStore.entries[identityKey];
  if (existing) {
    existing.last_seen = today;
    return existing.slug;
  }
  if (!takenByKind.has(kind)) takenByKind.set(kind, new Map());
  const taken = takenByKind.get(kind);
  const base = `${slugBase(title)}-${hash6(identityKey)}`;
  let slug = base;
  for (let n = 2; taken.has(slug) && taken.get(slug) !== identityKey; n++) slug = `${base}-${n}`;
  taken.set(slug, identityKey);
  slugStore.entries[identityKey] = { slug, first_seen: today, last_seen: today };
  return slug;
}

/* ── 페이지 껍데기 ───────────────────────────────────────────── */

// 주석은 CSS 문자열이 아니라 여기에 둔다 — 문자열 안에 쓰면 458장에 그대로 실려 나간다.
//   .go       원문으로 넘어가는 버튼이 이 페이지의 1순위 행동이다. 눌러야 할 것처럼 채운다(.sec 는 보조)
//   .nx-*     다음 행동 블록. 카드 열은 minmax(0,1fr) 이라야 긴 제목이 375px 를 밀어내지 않는다
//   420px 이하  dl 의 7.5rem 라벨 열은 좁은 화면에서 값 자리를 다 먹는다 — 한 열로 편다
function styles() {
  return `:root{color-scheme:light dark;--bg:#fff;--fg:#16181d;--muted:#5b616e;--line:#e3e5ea;--link:#1a56c4;--card:#f7f8fa;--warn-bg:#fff4e5;--warn-fg:#8a4b00;--warn-line:#f0c48a;--accent:#1a56c4}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e8eaef;--muted:#9aa1b0;--line:#2a2e37;--link:#7fb0ff;--card:#181b21;--warn-bg:#2e2109;--warn-fg:#f6c37a;--warn-line:#5c4415;--accent:#2563eb}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--fg);line-height:1.7;
font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Malgun Gothic",system-ui,sans-serif;
font-size:16px;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:46rem;margin:0 auto}
h1{font-size:1.6rem;line-height:1.35;margin:0 0 .5rem}
h2{font-size:1.15rem;margin:2.2rem 0 .6rem;padding-bottom:.35rem;border-bottom:1px solid var(--line)}
h3{font-size:1rem;margin:1.4rem 0 .3rem}
p{margin:.7rem 0}
a{color:var(--link)}
.lede{color:var(--muted);margin:0 0 1.6rem}
dl{display:grid;grid-template-columns:7.5rem 1fr;gap:.45rem 1rem;margin:1.4rem 0;padding:1rem 1.1rem;
background:var(--card);border:1px solid var(--line);border-radius:10px}
dt{color:var(--muted);font-size:.9rem}
dd{margin:0}
ul{margin:.6rem 0;padding-left:1.1rem}
li{margin:.5rem 0}
.src{color:var(--muted);font-size:.88rem}
.closed{margin:0 0 1.2rem;padding:.85rem 1rem;border:1px solid var(--warn-line);border-radius:8px;
background:var(--warn-bg);color:var(--warn-fg);line-height:1.6}
.closed a{color:var(--warn-fg);font-weight:600}
.go{display:inline-flex;align-items:center;max-width:100%;min-height:44px;margin:1.1rem 0;padding:.55rem 1.15rem;
border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:700}
.go.sec{background:var(--card);border-color:var(--line);color:var(--link);font-weight:600}
.nx-top h2{margin-top:1.2rem}
.nx-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;margin:.9rem 0}
.nx-card{display:block;min-width:0;max-width:100%;padding:.7rem .8rem;border:1px solid var(--line);
border-radius:10px;background:var(--card);text-decoration:none}
.nx-card b{display:block;color:var(--link);font-size:.92rem;line-height:1.45}
.nx-card .dd{display:inline-block;margin-top:.45rem;padding:0 .4rem;border-radius:5px;
background:var(--warn-bg);color:var(--warn-fg);font-size:.8rem;font-weight:700}
.nx-card .mt{display:block;margin-top:.25rem;color:var(--muted);font-size:.8rem}
nav.back{margin-top:2.6rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.92rem}
nav.back a{margin-right:1rem}
@media (max-width:640px){.nx-grid{grid-template-columns:1fr}}
@media (max-width:420px){dl{grid-template-columns:1fr;gap:.2rem}dd{margin-bottom:.5rem}}`;
}

function jsonLd(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// 방문 측정. async 라 첫 페인트를 막지 않는다.
const gaSnippet = () =>
  `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA_ID}')</script>`;

// path: "contests/foo.html" 또는 "contests/" (허브)
function page({ path, title, description, ogType = "website", ld, body }) {
  const url = `${SITE_BASE}/${path}`;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:locale" content="ko_KR">
<meta property="og:image" content="${esc(OG_IMAGE)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(OG_IMAGE)}">
${gaSnippet()}
<style>${styles()}</style>
<script type="application/ld+json">${jsonLd(ld)}</script>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

const written = [];
function emit(path, html) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
  written.push(path);
}

// 항목 페이지는 루프 안에서 바로 찍지 않고 모아둔다.
// "마감이 가까운 다른 항목 3개"를 고르려면 전체 목록이 다 모인 뒤여야 하기 때문이다.
// body 를 문자열이 아니라 함수로 받아, 루프가 다 끝난 뒤 한 번에 펼친다.
const deferred = [];
const defer = (path, meta, bodyFn) => deferred.push({ path, meta, bodyFn });

function dl(rows) {
  const items = rows.filter(([, v]) => norm(v)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
  return items.length ? `<dl>\n${items.join("\n")}\n</dl>` : "";
}

function backNav(spaHash, hubPath, hubLabel) {
  return `<nav class="back">
<a href="${SITE_BASE}/${hubPath}">${esc(hubLabel)}</a>
<a href="${SITE_BASE}/#${spaHash}">AI 레이더에서 보기</a>
<a href="${SITE_BASE}/">AI 레이더 홈</a>
</nav>`;
}

// 원본 데이터의 url 이 "미정" 인 항목이 있다. 링크 자리에 그대로 쓰면 죽은 링크가 된다.
// 진짜 http(s) 주소일 때만 주소로 취급하고, 아니면 링크를 아예 만들지 않는다.
const httpUrl = (v) => (/^https?:\/\//i.test(norm(v)) ? norm(v) : "");

function outbound(url, label, cls = "") {
  const href = httpUrl(url);
  if (!href) return "";
  return `<p><a class="go${cls ? " " + cls : ""}" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} →</a></p>`;
}

// 제목 = 항목명 + 핵심사실. 60자를 넘으면 사실이 아니라 항목명을 줄인다.
function headline(name, facts) {
  const suffix = facts ? ` — ${facts}` : "";
  const budget = Math.max(12, 60 - suffix.length);
  return clip(name, budget) + suffix;
}

// 제목·설명이 다른 페이지와 겹치면 검색엔진이 한쪽을 버린다.
// 짧게 자른 결과가 겹칠 때는 자르지 않은 원문(fallback)으로 되돌린다.
const usedTitles = new Set();
const usedDescs = new Set();
function uniqueText(used, primary, fallback, max) {
  if (!used.has(primary)) {
    used.add(primary);
    return primary;
  }
  let text = clip(fallback, max);
  for (let n = 2; used.has(text); n++) text = `${clip(fallback, max - 5)} (${n})`;
  used.add(text);
  return text;
}
const uniqueTitle = (primary, fallback) => uniqueText(usedTitles, primary, fallback, 90);
const uniqueDesc = (primary, fallback) => uniqueText(usedDescs, primary, fallback, 160);

// Devpost 수집분은 summary 가 "상금 $0" 한 줄뿐인 경우가 있다.
// 0원은 정보가 아니라 오해를 부르는 값이라 아예 없는 것으로 본다. "상금 $25" 같은 값은 그대로 쓴다.
const ZERO_PRIZE = /^상금\s*[$€£¥₩₹]?\s*0(?:[.,]0+)?$/;
const usefulSummary = (v) => {
  const s = norm(v);
  return !s || ZERO_PRIZE.test(s) ? "" : s;
};

// 설명이 너무 짧으면 검색 결과에서 아무 쓸모가 없다.
// 없는 말을 지어내지 않고, 가지고 있는 사실을 우선순위대로 더 붙여 최소 길이를 넘긴다.
function describe(primary, extras = [], min = 40) {
  const parts = primary.map(norm).filter(Boolean);
  for (const e of extras) {
    if (parts.join(" · ").length >= min) break;
    const v = norm(e);
    if (v && !parts.includes(v)) parts.push(v);
  }
  return parts.join(" · ");
}

/* ── 데이터 읽기 ─────────────────────────────────────────────── */

function loadJson(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    console.warn(`${rel} 없음 — 건너뛴다`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`${rel} 파싱 실패 — 건너뛴다: ${e.message}`);
    return null;
  }
}

const contestsData = loadJson("data/contests.json");
const overseasData = loadJson("data/overseas-contests.json");
const pubData = loadJson("data/pub.json");
const govData = loadJson("data/gov-pub.json");

// priority: 접수 중인 항목을 접수 마감된 항목보다 위에 둔다
const sitemap = []; // {path, lastmod, priority}
const addUrl = (path, lastmod, priority = "0.7") => sitemap.push({ path, lastmod, priority });

/* ── 공모전 ──────────────────────────────────────────────────── */

const contestGroups = []; // {label, overseas, bucket, items:[{item,slug,path}]}
const seenContest = new Set();
const BUCKETS = [
  ["ongoing", "진행중"],
  ["awaiting_results", "결과 대기"],
];

for (const [data, isOverseas, scopeLabel, lastmod] of [
  [contestsData, false, "국내", contestsData ? dateOf(contestsData.generated_at) : today],
  [overseasData, true, "해외", overseasData ? dateOf(overseasData.generated_at) : today],
]) {
  if (!data || !data.sections) continue;
  for (const [bucket, bucketLabel] of BUCKETS) {
    const list = Array.isArray(data.sections[bucket]) ? data.sections[bucket] : [];
    const closed = bucket === "awaiting_results"; // 접수는 끝나고 결과를 기다리는 중
    const group = {
      label: `${scopeLabel} · ${bucketLabel}`,
      id: `${bucket === "ongoing" ? "ongoing" : "closed"}${isOverseas ? "-overseas" : ""}`,
      items: [],
    };
    for (const item of list) {
      const title = norm(item.title);
      if (!title) continue;
      const key = `contest|${title}|${norm(item.organizer)}`;
      if (seenContest.has(key)) continue;
      seenContest.add(key);

      const slug = slugFor("contest", key, title);
      const path = `contests/${slug}.html`;
      const url = `${SITE_BASE}/${path}`;

      const end = isoDate(item.submission_end);
      const start = isoDate(item.submission_start);
      const md = shortDate(item.submission_end);
      const facts = [md ? `마감 ${md}` : null, norm(item.organizer) || null].filter(Boolean).join(" · ");
      const pageTitle = uniqueTitle(headline(title, facts), `${title}${facts ? " — " + facts : ""}`);
      // status 필드가 섹션과 어긋난 항목이 10건 있다(마감 섹션인데 "진행중").
      // 한 페이지에서 두 말을 하지 않도록, 마감 섹션이면 섹션 쪽을 따른다.
      const statusText = closed ? "발표 대기" : norm(item.status);
      const summary = usefulSummary(item.summary);
      const deadlineFact = norm(item.submission_end) ? `마감 ${norm(item.submission_end)}` : "";
      const organizerFact = norm(item.organizer) ? `주최 ${norm(item.organizer)}` : "";
      // 쓸 만한 요약이 없으면 공모전 이름이 곧 설명이다. 없는 말을 채워 넣지 않는다.
      const descBase = describe(
        summary ? [deadlineFact, organizerFact, summary] : [title, deadlineFact, organizerFact],
        [
          norm(item.category),
          isOverseas ? norm(item.country) : "국내",
          start && end ? `접수 ${start} ~ ${end}` : "",
          statusText,
        ]
      );
      const description = uniqueDesc(clip(descBase, 160), `${title} · ${descBase}`);

      const ld =
        start || end
          ? {
              "@context": "https://schema.org",
              "@type": "Event",
              name: title,
              description,
              url,
              ...(start ? { startDate: start } : {}),
              ...(end ? { endDate: end } : {}),
              ...(norm(item.organizer)
                ? { organizer: { "@type": "Organization", name: norm(item.organizer) } }
                : {}),
              eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
              eventStatus: "https://schema.org/EventScheduled",
              location: { "@type": "VirtualLocation", url: httpUrl(item.url) || url },
            }
          : { "@context": "https://schema.org", "@type": "WebPage", name: title, description, url };

      const period =
        norm(item.submission_start) && norm(item.submission_end)
          ? `${norm(item.submission_start)} ~ ${norm(item.submission_end)}`
          : "";

      // 마감된 공모전도 이름으로 검색해 들어온다. 페이지는 남기되,
      // 들어온 사람이 헛걸음하지 않도록 상태를 먼저 알리고 접수 중인 목록으로 보낸다.
      // 목록으로 보내는 링크는 바로 아래 nextActions 가 건수까지 붙여 내보낸다.
      // 같은 곳으로 가는 버튼을 두 번 쌓지 않는다.
      const closedNotice = closed
        ? `<p class="closed"><strong>접수가 마감되었습니다.</strong> 현재 결과 발표를 기다리는 공모전입니다.</p>`
        : "";

      // 마감된 페이지는 그냥 두면 100% 이탈이다 — 다음 행동을 아래가 아니라 안내문 바로 밑에 둔다.
      defer(
        path,
        { path, title: pageTitle, description, ogType: "website", ld },
        () => `<h1>${esc(title)}</h1>
${closedNotice}
${closed ? nextActions({ kind: "contest", selfUrl: url, emphasis: "top" }) : ""}
<p class="lede">${esc([norm(item.category), isOverseas ? norm(item.country) : "국내", statusText].filter(Boolean).join(" · "))}</p>
${dl([
  ["접수 마감", item.submission_end],
  ["접수 기간", period],
  ["결과 발표", item.result_date],
  ["주최·주관", item.organizer],
  ["분류", item.category],
  ["국가", isOverseas ? item.country : ""],
  ["진행 상태", statusText],
])}
${closed ? outbound(item.url, "공모 요강 원문 보기", "sec") : outbound(item.url, "신청하기 · 공모 요강 원문")}
${summary ? `<p>${esc(summary)}</p>` : ""}
${norm(item.evidence) ? `<p class="src">${esc(norm(item.evidence))}</p>` : ""}
${nextActions({ kind: "contest", selfUrl: url, emphasis: closed ? "bottom" : "all" })}
${backNav("contests", "contests/", "공모전 전체 보기")}`
      );
      addUrl(path, lastmod, closed ? "0.4" : "0.8");
      group.items.push({
        name: title,
        url,
        deadline: norm(item.submission_end) || "미정",
        host: norm(item.organizer),
      });
    }
    if (group.items.length) contestGroups.push(group);
  }
}

/* ── 영화제·페스티벌 ─────────────────────────────────────────── */

const festivalList = [];
const seenFestival = new Set();
const pubLastmod = pubData ? dateOf(pubData.generated) : today;

for (const f of pubData && Array.isArray(pubData.festivals) ? pubData.festivals : []) {
  const name = norm(f.name);
  if (!name) continue;
  const key = `festival|${name}|${norm(f.host)}`;
  if (seenFestival.has(key)) continue;
  seenFestival.add(key);

  const slug = slugFor("festival", key, name);
  const path = `festivals/${slug}.html`;
  const url = `${SITE_BASE}/${path}`;

  const deadline = isoDate(f.deadline);
  const eventStart = isoDate(f.event); // event 는 자유 텍스트 — 엄격한 ISO 로 시작할 때만 쓴다
  const facts = [`출품마감 ${norm(f.deadline) || "미정"}`, norm(f.place) || null].filter(Boolean).join(" · ");
  const pageTitle = uniqueTitle(headline(name, facts), `${name}${facts ? " — " + facts : ""}`);
  const descBase = describe(
    [
      `출품마감 ${norm(f.deadline) || "미정"}`,
      norm(f.host) ? `주최 ${norm(f.host)}` : "",
      norm(f.note),
    ],
    [norm(f.place), norm(f.region), norm(f.event) ? `행사 ${norm(f.event)}` : ""]
  );
  const description = uniqueDesc(clip(descBase, 160), `${name} · ${descBase}`);

  const ld =
    eventStart || deadline
      ? {
          "@context": "https://schema.org",
          "@type": "Event",
          name,
          description,
          url,
          ...(eventStart ? { startDate: eventStart } : {}),
          ...(norm(f.host) ? { organizer: { "@type": "Organization", name: norm(f.host) } } : {}),
          eventStatus: "https://schema.org/EventScheduled",
          ...(norm(f.place)
            ? { location: { "@type": "Place", name: norm(f.place), address: norm(f.place) } }
            : {}),
        }
      : { "@context": "https://schema.org", "@type": "WebPage", name, description, url };

  defer(
    path,
    { path, title: pageTitle, description, ogType: "website", ld },
    () => `<h1>${esc(name)}</h1>
<p class="lede">${esc([norm(f.region), norm(f.place)].filter(Boolean).join(" · "))}</p>
${dl([
  ["출품 마감", f.deadline],
  ["행사 일정", f.event],
  ["주최", f.host],
  ["장소", f.place],
  ["지역", f.region],
])}
${outbound(f.url, "출품 신청 · 공식 페이지")}
${norm(f.note) ? `<p>${esc(norm(f.note))}</p>` : ""}
${nextActions({ kind: "festival", selfUrl: url })}
${backNav("festivals", "festivals/", "영화제 전체 보기")}`
  );
  addUrl(path, pubLastmod);
  festivalList.push({ name, url, deadline: norm(f.deadline) || "미정", host: norm(f.host) });
}

/* ── 지원사업 ────────────────────────────────────────────────── */

const fundingList = [];
const seenFunding = new Set();
const govLastmod = govData ? dateOf(govData.generated) : today;

/* index.html 의 GOV_AI_RE 와 같은 판정. 화면 기본값(govAiOnly=true)이 nm 한 필드만 보므로
   여기도 같아야 한다 — 다르면 화면과 검색이 서로 다른 서비스가 된다.
   org·cls·inst 를 함께 보면 33건이 되어 화면(29건)과 어긋난다. nm 만 본다.
   화면에서 사용자가 필터를 끄면 274건 전부 보이는 동작은 그대로다. 검색에만 내보내지 않는 것이다. */
const GOV_AI_RE = /AI|인공지능|생성형|딥테크|디지털|데이터/i;

const govItems = govData && Array.isArray(govData.items) ? govData.items : [];
const govAiItems = govItems.filter((g) => GOV_AI_RE.test(g.nm || ""));

for (const g of govAiItems) {
  const nm = norm(g.nm);
  if (!nm) continue;
  const key = `funding|${nm}|${norm(g.org)}`;
  if (seenFunding.has(key)) continue;
  seenFunding.add(key);

  const slug = slugFor("funding", key, nm);
  const path = `funding/${slug}.html`;
  const url = `${SITE_BASE}/${path}`;

  const start = isoDate(g.bgng);
  const end = isoDate(g.end);
  const facts = [`접수마감 ${norm(g.end) || "미정"}`, norm(g.org) || null].filter(Boolean).join(" · ");
  const pageTitle = uniqueTitle(headline(nm, facts), `${nm}${facts ? " — " + facts : ""}`);
  const descBase = [
    `접수마감 ${norm(g.end) || "미정"}`,
    norm(g.org) ? `주관 ${norm(g.org)}` : null,
    norm(g.cls),
    norm(g.trgt) ? `대상 ${norm(g.trgt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const description = uniqueDesc(clip(descBase, 160), `${nm} · ${descBase}`);

  const ld =
    start || end
      ? {
          "@context": "https://schema.org",
          "@type": "Event",
          name: nm,
          description,
          url,
          ...(start ? { startDate: start } : {}),
          ...(end ? { endDate: end } : {}),
          ...(norm(g.org) ? { organizer: { "@type": "Organization", name: norm(g.org) } } : {}),
          eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
          eventStatus: "https://schema.org/EventScheduled",
          location: { "@type": "VirtualLocation", url: httpUrl(g.url) || url },
        }
      : { "@context": "https://schema.org", "@type": "WebPage", name: nm, description, url };

  const period = norm(g.bgng) && norm(g.end) ? `${norm(g.bgng)} ~ ${norm(g.end)}` : "";
  defer(
    path,
    { path, title: pageTitle, description, ogType: "website", ld },
    () => `<h1>${esc(nm)}</h1>
<p class="lede">${esc([norm(g.cls), norm(g.inst), norm(g.regin)].filter(Boolean).join(" · "))}</p>
${dl([
  ["접수 마감", g.end],
  ["접수 기간", period],
  ["주관", g.org],
  ["기관 유형", g.inst],
  ["분류", g.cls],
  ["지역", g.regin],
  ["신청 대상", g.trgt],
])}
${outbound(g.url, "신청하기 · K-Startup 공고 원문")}
<p>${esc(`${nm} 공고입니다. ${norm(g.org) ? norm(g.org) + "이(가) 주관하며 " : ""}${norm(g.end) ? "접수 마감은 " + norm(g.end) + "입니다." : "접수 일정은 공고를 확인하세요."}`)}</p>
${nextActions({ kind: "funding", selfUrl: url })}
${backNav("gov", "funding/", "지원사업 전체 보기")}`
  );
  addUrl(path, govLastmod);
  fundingList.push({ name: nm, url, deadline: norm(g.end) || "미정", host: norm(g.org) });
}

/* ── 브리핑 ──────────────────────────────────────────────────── */

// 브리핑 content 는 시기에 따라 두 가지 형식이 섞여 있다.
//   최근: "■ 문서제목" / "[섹션]" / "• 제목 — 요약 (출처: URL) (img: URL)"
//   이전: "## 문서제목" / "### [섹션]" / "*   제목 — 요약 (출처: URL) (img: URL)"
// 둘 다 같은 결과로 만든다.
const BULLET = /^([•·*+]|-)\s+/;
const HEADING = /^(?:■|#{1,6})\s*/;

// "• 제목 — 요약 (출처: URL) (img: URL)" → {title, summary, src}
function parseBullet(line) {
  let s = line.replace(BULLET, "");
  s = s.replace(/\s*\(img:\s*[^)]*\)\s*$/u, "");
  let src = "";
  const m = s.match(/\s*\(출처:\s*([^)]*)\)\s*$/u);
  if (m) {
    src = m[1].trim();
    s = s.slice(0, m.index);
  }
  const i = s.indexOf(" — ");
  const title = norm(i >= 0 ? s.slice(0, i) : s);
  const summary = norm(i >= 0 ? s.slice(i + 3) : "");
  return { title, summary, src: httpUrl(src) };
}

function renderBriefingBody(content) {
  const out = [];
  let open = false;
  const closeList = () => {
    if (open) {
      out.push("</ul>");
      open = false;
    }
  };
  for (const raw of String(content || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^-{3,}$/.test(line)) continue; // 구분선
    if (HEADING.test(line)) {
      closeList();
      const sec = line.replace(HEADING, "").match(/^\[(.+)\]$/);
      // 대괄호가 붙은 것만 섹션이다. 나머지는 문서 제목 — h1 으로 이미 나갔다
      if (sec) out.push(`<h2>${esc(sec[1])}</h2>`);
      continue;
    }
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      closeList();
      out.push(`<h2>${esc(sec[1])}</h2>`);
      continue;
    }
    if (BULLET.test(line)) {
      const b = parseBullet(line);
      if (!b.title) continue;
      if (!open) {
        out.push("<ul>");
        open = true;
      }
      out.push(
        `<li><strong>${esc(b.title)}</strong>` +
          (b.summary ? `<br>${esc(b.summary)}` : "") +
          (b.src
            ? `<br><a class="src" href="${esc(b.src)}" target="_blank" rel="noopener">출처 보기</a>`
            : "") +
          `</li>`
      );
      continue;
    }
    closeList();
    out.push(`<p>${esc(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

function briefingHeadlines(content) {
  const heads = [];
  for (const raw of String(content || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (BULLET.test(line)) {
      const b = parseBullet(line);
      if (b.title) heads.push(b.title);
    }
    if (heads.length >= 3) break;
  }
  return heads;
}

const briefingList = [];
const seenBriefing = new Set();

for (const r of pubData && Array.isArray(pubData.reports) ? pubData.reports : []) {
  const date = isoDate(r.report_date);
  if (!date) continue;
  if (seenBriefing.has(date)) continue; // 같은 날짜가 둘이면 배열 순서상 앞선 것을 쓴다
  seenBriefing.add(date);

  const path = `briefing/${date}.html`;
  const url = `${SITE_BASE}/${path}`;
  const pageTitle = `AI 업계 브리핑 ${date}`;
  const heads = briefingHeadlines(r.content);
  const description = clip(
    `${date} 생성형 AI·바이브코딩·AI VFX 업계 소식 정리. ${heads.join(" / ")}`,
    160
  );

  const ld = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: pageTitle,
    datePublished: date,
    dateModified: date,
    author: { "@type": "Organization", name: SITE_NAME },
    publisher: { "@type": "Organization", name: SITE_NAME },
    url,
    description,
  };

  defer(
    path,
    { path, title: pageTitle, description, ogType: "article", ld },
    () => `<h1>${esc(pageTitle)}</h1>
<p class="lede">생성형 AI·바이브코딩·AI VFX 업계에서 그날 나온 소식을 한 자리에 모았습니다.</p>
${renderBriefingBody(r.content)}
${nextActions({ kind: "briefing", selfUrl: url })}
${backNav("newsrep", "briefing/", "브리핑 전체 보기")}`
  );
  addUrl(path, pubLastmod);
  briefingList.push({ date, url, title: pageTitle });
}

briefingList.sort((a, b) => (a.date < b.date ? 1 : -1));

/* ── 다음 행동 ───────────────────────────────────────────────── */

// 검색으로 들어온 사람에게 권할 수 있는 건 "아직 접수 중인" 항목뿐이다.
// 지난 항목을 권하면 막다른 길을 하나 더 만드는 셈이다. 마감이 가까운 순으로 둔다.
const openPool = (list) =>
  list
    .map((it) => ({ ...it, iso: stillOpen(it.deadline) }))
    .filter((it) => it.iso)
    .sort((a, b) => (a.iso < b.iso ? -1 : 1));

// ongoing / ongoing-overseas 둘 다 "접수 중" 이다
const contestPool = openPool(
  contestGroups.filter((g) => g.id.startsWith("ongoing")).flatMap((g) => g.items)
);
const festivalPool = openPool(festivalList);
const fundingPool = openPool(fundingList);

const NEXT = {
  contest: {
    head: "마감이 가까운 다른 AI 공모전",
    pool: contestPool,
    href: `${SITE_BASE}/contests/#ongoing`,
    all: (n) => `지금 접수 중인 AI 공모전 ${n}건 보기`,
    hub: "AI 공모전 전체 보기",
    talk: "이 공모전 준비하시는 분들과 이야기 나누기 →",
  },
  festival: {
    head: "출품 마감이 가까운 다른 영화제",
    pool: festivalPool,
    href: `${SITE_BASE}/festivals/`,
    all: (n) => `출품 접수 중인 AI 영화제 ${n}곳 보기`,
    hub: "AI 영화제 전체 보기",
    talk: "이 영화제 출품 준비하시는 분들과 이야기 나누기 →",
  },
  funding: {
    head: "접수 마감이 가까운 다른 지원사업",
    pool: fundingPool,
    href: `${SITE_BASE}/funding/`,
    all: (n) => `모집 중인 지원사업 ${n}건 보기`,
    hub: "지원사업 전체 보기",
    talk: "이 지원사업 준비하시는 분들과 이야기 나누기 →",
  },
  briefing: {
    head: "최근 브리핑",
    pool: briefingList, // 이미 최신순 — 브리핑에는 마감이라는 개념이 없다
    href: `${SITE_BASE}/briefing/`,
    all: (n) => `AI 업계 브리핑 ${n}일치 보기`,
    hub: "AI 업계 브리핑 보기",
    talk: "AI 소식 나누는 커뮤니티 →",
  },
};

function nxCard(it, kind) {
  const title = kind === "briefing" ? it.title : it.name;
  const meta =
    kind === "briefing"
      ? `<span class="mt">${esc(it.date)}</span>`
      : `<span class="dd">${esc(ddayLabel(it.iso))}</span><span class="mt">마감 ${esc(it.iso)}</span>`;
  return `<a class="nx-card" href="${esc(it.url)}"><b>${esc(clip(title, 40))}</b>${meta}</a>`;
}

// ① 비슷한 항목 ② 마감 알림 ③ 전체 목록 ④ 커뮤니티.
// emphasis "top" = ①③만(마감 페이지 위쪽), "bottom" = ②④만, 기본 = 넷 다.
// ② 는 메일 주소를 여기서 받지 않는다 — 이 정적 페이지에는 받아줄 곳이 없어서,
//    입력칸을 놓으면 주소를 삼키고 알림은 오지 않는 약속이 된다. 홈 구독 블록으로 보낸다.
function nextActions({ kind, selfUrl, emphasis = "all" }) {
  const c = NEXT[kind];
  const rel = c.pool.filter((it) => it.url !== selfUrl).slice(0, 3);
  const n = c.pool.length;
  const out = [];

  if (emphasis !== "bottom" && rel.length)
    out.push(
      `<h2>${esc(c.head)}</h2>\n<div class="nx-grid">\n${rel.map((it) => nxCard(it, kind)).join("\n")}\n</div>`
    );
  if (emphasis !== "top")
    out.push(`<h2>마감 알림 구독</h2>
<p>마감 3일 전에 메일로 알려드립니다.</p>
<p><a class="go" href="${SITE_BASE}/?to=sub">마감 알림 받기 →</a></p>`);
  // 접수 중인 게 하나도 없으면 "0건"을 적지 않는다 — 숫자 없이 허브로만 보낸다
  if (emphasis !== "bottom")
    out.push(`<p><a class="go sec" href="${esc(c.href)}">${esc(n ? c.all(n) : c.hub)} →</a></p>`);
  if (emphasis !== "top")
    out.push(`<p><a href="${SITE_BASE}/board/">${esc(c.talk)}</a></p>`);

  if (!out.length) return "";
  return `<section class="nx${emphasis === "top" ? " nx-top" : ""}">\n${out.join("\n")}\n</section>`;
}

// 목록이 다 모였으니 이제 항목 페이지를 찍는다
for (const d of deferred) emit(d.path, page({ ...d.meta, body: d.bodyFn() }));

/* ── 허브 ────────────────────────────────────────────────────── */

function itemListLd(name, entries) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    itemListElement: entries.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: e.url,
      name: e.name,
    })),
  };
}

function listBlock(items) {
  if (!items.length) return `<p>현재 올라온 항목이 없습니다.</p>`;
  return (
    "<ul>\n" +
    items
      .map(
        (it) =>
          `<li><a href="${esc(it.url)}">${esc(it.name)}</a><br>` +
          `<span class="src">마감 ${esc(it.deadline)}${it.host ? ` · ${esc(it.host)}` : ""}</span></li>`
      )
      .join("\n") +
    "\n</ul>"
  );
}

function hub({ path, spaHash, title, description, h1, lede, sections, ldName, ldEntries, lastmod }) {
  const body = `<h1>${esc(h1)}</h1>
<p class="lede">${esc(lede)}</p>
${sections}
<nav class="back">
<a href="${SITE_BASE}/#${spaHash}">AI 레이더에서 보기</a>
<a href="${SITE_BASE}/">AI 레이더 홈</a>
</nav>`;
  emit(
    `${path}index.html`,
    page({ path, title, description, ogType: "website", ld: itemListLd(ldName, ldEntries), body })
  );
  addUrl(path, lastmod, "0.9"); // 허브는 개별 항목보다 위
}

// 공모전 허브
{
  const all = contestGroups.flatMap((g) => g.items);
  const sections = contestGroups
    .map((g) => `<h2 id="${esc(g.id)}">${esc(g.label)} (${g.items.length}건)</h2>\n${listBlock(g.items)}`)
    .join("\n");
  hub({
    path: "contests/",
    spaHash: "contests",
    title: `AI 영상 공모전 모음 — 국내·해외 ${all.length}건`,
    description: clip(
      `국내외 AI 영상·생성형 AI 공모전 ${all.length}건을 마감일과 주최 기준으로 모았습니다. 진행중·결과 대기 상태를 함께 확인하세요.`,
      160
    ),
    h1: "AI 영상 공모전 모음",
    lede: `국내외 생성형 AI·AI 영상 공모전 ${all.length}건입니다. 마감일과 주최를 확인하고 원문으로 바로 넘어갈 수 있습니다.`,
    sections,
    ldName: "AI 영상 공모전 모음",
    ldEntries: all,
    lastmod: contestsData ? dateOf(contestsData.generated_at) : today,
  });
}

// 영화제 허브
hub({
  path: "festivals/",
  spaHash: "festivals",
  title: `AI 영화제·페스티벌 ${festivalList.length}곳 출품 정보`,
  description: clip(
    `AI 영화제·페스티벌 ${festivalList.length}곳의 출품 마감과 주최, 개최지를 한눈에 정리했습니다.`,
    160
  ),
  h1: "AI 영화제·페스티벌",
  lede: `AI 영화·영상을 받는 영화제와 페스티벌 ${festivalList.length}곳입니다. 출품 마감과 개최지를 확인하세요.`,
  sections: listBlock(festivalList),
  ldName: "AI 영화제·페스티벌",
  ldEntries: festivalList,
  lastmod: pubLastmod,
});

// 지원사업 허브
hub({
  path: "funding/",
  spaHash: "gov",
  title: `정부 지원사업 공고 ${fundingList.length}건 — 접수 마감순`,
  description: clip(
    `창업·사업화·교육 등 정부 지원사업 공고 ${fundingList.length}건의 접수 마감과 주관 기관을 정리했습니다.`,
    160
  ),
  h1: "정부 지원사업 공고",
  lede: `창업·사업화·R&D·교육 등 모집 중인 지원사업 공고 ${fundingList.length}건입니다. 접수 마감과 주관 기관을 확인하세요.`,
  sections: listBlock(fundingList),
  ldName: "정부 지원사업 공고",
  ldEntries: fundingList,
  lastmod: govLastmod,
});

// 브리핑 허브
{
  const entries = briefingList.map((b) => ({ name: b.title, url: b.url }));
  const listing = briefingList.length
    ? "<ul>\n" +
      briefingList
        .map((b) => `<li><a href="${esc(b.url)}">${esc(b.title)}</a></li>`)
        .join("\n") +
      "\n</ul>"
    : "<p>아직 올라온 브리핑이 없습니다.</p>";
  hub({
    path: "briefing/",
    spaHash: "newsrep",
    title: `AI 업계 브리핑 아카이브 — ${briefingList.length}일치`,
    description: clip(
      `생성형 AI·바이브코딩·AI VFX 업계 일일 브리핑 ${briefingList.length}일치 아카이브입니다. 날짜별로 그날의 주요 소식을 정리했습니다.`,
      160
    ),
    h1: "AI 업계 브리핑 아카이브",
    lede: "생성형 AI·바이브코딩·AI VFX 업계 소식을 날짜별로 정리한 브리핑입니다.",
    sections: listing,
    ldName: "AI 업계 브리핑 아카이브",
    ldEntries: entries,
    lastmod: pubLastmod,
  });
}

/* ── sitemap.xml / robots.txt / slugs.json ───────────────────── */

const xmlEsc = (v) =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const urls = [{ path: "", lastmod: today, priority: "1.0" }, ...sitemap];
const sitemapXml =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls
    .map(
      (u) =>
        `  <url>\n    <loc>${xmlEsc(`${SITE_BASE}/${u.path}`)}</loc>\n    <lastmod>${xmlEsc(u.lastmod)}</lastmod>\n    <priority>${xmlEsc(u.priority)}</priority>\n  </url>`
    )
    .join("\n") +
  `\n</urlset>\n`;

writeFileSync(join(ROOT, "sitemap.xml"), sitemapXml);
writeFileSync(join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_BASE}/sitemap.xml\n`);

const sorted = {};
for (const k of Object.keys(slugStore.entries).sort()) sorted[k] = slugStore.entries[k];
writeFileSync(SLUGS_PATH, JSON.stringify({ version: 1, entries: sorted }, null, 2) + "\n");

/* ── 요약 ────────────────────────────────────────────────────── */

const count = (p) => written.filter((w) => w.startsWith(p) && !w.endsWith("index.html")).length;
console.log(`공모전   ${count("contests/")}건`);
console.log(`영화제   ${count("festivals/")}건`);
console.log(`지원사업 ${count("funding/")}건 (AI 판정 통과 / 전체 ${govItems.length}건)`);
console.log(`브리핑   ${count("briefing/")}건`);
console.log(`허브     ${written.filter((w) => w.endsWith("index.html")).length}건`);
console.log(`sitemap  ${urls.length}개 URL`);
console.log(`slugs    ${Object.keys(sorted).length}개 (신규 포함)`);
