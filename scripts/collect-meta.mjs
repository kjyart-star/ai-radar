/* AI 레이더 — 작품소개 영상 메타(조회수·채널·게시일) 자체수집기 (의존성 없음, Node 20+ 내장 fetch)
 *
 * 왜 이 파일이 있나:
 *   작품소개(SHOWCASE) 화면은 3소스를 병합해 보여준다:
 *     Firebase picks(관리자 폼 업로드) + data/aivideo-extra.json(대표 선정 정적) + 수신부.
 *   picks·extras 에는 조회수·채널·게시일이 없어서, index.html 의 avMeta 가
 *   data/aivideo-meta.json(영상ID → {channel, views, published}) 에서 그 값을 채운다.
 *   그동안 이 meta 는 사람이 한 번 수동으로 긁었다. 대표가 새 작품(picks)을 올리면
 *   자동으로 조회수가 안 채워졌다 → 이걸 매일 수집에 포함시켜 자동화한다.
 *
 * 방식:
 *   대상 영상ID = Firebase picks(공개 REST 읽기) + data/aivideo-extra.json.
 *   각 영상ID 마다 유튜브 watch 페이지를 긁어 viewCount/publishDate/author 를 뽑는다.
 *
 * 원칙(collect-youtube.mjs 와 동일 — 유실방지가 핵심):
 *   ⚠️ 유튜브는 GitHub Actions IP 를 자주 막는다. 실패한 영상은 기존 값을 유지하고,
 *      성공한 것만 갱신한다. 수집 0건이면 기존 파일을 아예 덮어쓰지 않는다.
 *   - 요청 사이 짧은 딜레이 + 지수 백오프 재시도.
 *   - data/aivideo-meta.json 형식({ "<videoId>": {channel, views, published} })은 바꾸지 않는다.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const META = join(DATA, "aivideo-meta.json");
const EXTRA = join(DATA, "aivideo-extra.json");
const PICKS_URL =
  "https://firestore.googleapis.com/v1/projects/ai-radar-74be8/databases/(default)/documents/picks?pageSize=300";
/* 유튜브 watch 페이지는 브라우저 UA 를 줘야 안정적으로 메타를 담아 준다. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 공통 fetch (지수 백오프) ---------- */

async function getOnce(url, { timeout = 30000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}
async function get(url, opts) {
  const delays = [700, 1500, 3000];
  let last;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await getOnce(url, opts);
    } catch (e) {
      last = e;
      if (i < delays.length) await sleep(delays[i]);
    }
  }
  throw last;
}

/* ---------- 대상 영상ID 수집 ---------- */

/* picks(공개 REST): 각 문서 fields.videoId.stringValue, 없으면 fields.url 에서 v= 추출 */
async function collectPickIds() {
  const ids = [];
  try {
    const txt = await get(PICKS_URL, { headers: { accept: "application/json" } });
    const j = JSON.parse(txt);
    const docs = j.documents || [];
    for (const d of docs) {
      const f = (d && d.fields) || {};
      let vid = f.videoId && f.videoId.stringValue;
      if (!vid && f.url && f.url.stringValue) {
        const m = f.url.stringValue.match(/[?&]v=([A-Za-z0-9_-]+)/);
        if (m) vid = m[1];
      }
      if (vid) ids.push(vid);
    }
    log("  · picks: " + ids.length + "개 영상ID (" + docs.length + " 문서)");
  } catch (e) {
    log("  ! picks 조회 실패 (" + e.message + ") — extras 만으로 진행");
  }
  return ids;
}

/* extras(정적 파일): 각 항목 videoId */
function collectExtraIds() {
  try {
    const arr = JSON.parse(readFileSync(EXTRA, "utf8"));
    const ids = (Array.isArray(arr) ? arr : [])
      .map((x) => x && x.videoId)
      .filter(Boolean);
    log("  · extras: " + ids.length + "개 영상ID");
    return ids;
  } catch (e) {
    log("  ! extras 읽기 실패 (" + e.message + ")");
    return [];
  }
}

/* ---------- 유튜브 watch 페이지에서 메타 추출 ---------- */

function amp(s) {
  return String(s).replace(/&amp;/g, "&");
}

/* 성공하면 {channel, views, published}, 실패(차단/네트워크/파싱)면 null 을 돌려준다.
   null 이면 호출부가 기존 값을 유지한다 — 절대 덮어쓰지 않는다. */
async function fetchMeta(videoId) {
  let html;
  try {
    html = await get("https://www.youtube.com/watch?v=" + videoId, {
      headers: { "user-agent": UA, "accept-language": "en-US,en" },
    });
  } catch (e) {
    return null; /* 네트워크/차단 — 기존 유지 */
  }
  const vm = html.match(/"viewCount":"(\d+)"/);
  const pm =
    html.match(/"publishDate":"([^"]+)"/) ||
    html.match(/itemprop="datePublished" content="([^"]+)"/);
  const am = html.match(/"author":"([^"]+)"/);

  const views = vm ? parseInt(vm[1], 10) : null;
  const published = pm ? String(pm[1]).slice(0, 10) : null; /* YYYY-MM-DD */
  const channel = am ? amp(am[1]) : null;

  /* 하나도 못 뽑았으면 차단/변형 페이지로 보고 실패 처리(기존 유지). */
  if (views == null && published == null && channel == null) return null;

  const out = {};
  if (channel != null) out.channel = channel;
  if (views != null) out.views = views;
  if (published != null) out.published = published;
  return out;
}

/* ---------- main ---------- */

async function main() {
  log("[작품소개 메타 수집]");

  /* 기존 meta 로드(없거나 깨지면 빈 객체) — 유실방지의 기준값 */
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(META, "utf8")) || {};
  } catch (e) {
    existing = {};
  }
  const existingCount = Object.keys(existing).length;

  /* 대상 영상ID = picks ∪ extras (중복 제거) */
  const pickIds = await collectPickIds();
  const extraIds = collectExtraIds();
  const targets = [];
  const seen = {};
  for (const id of pickIds.concat(extraIds)) {
    if (id && !seen[id]) {
      seen[id] = 1;
      targets.push(id);
    }
  }
  log("  · 대상 영상: " + targets.length + "개 (기존 meta " + existingCount + "건)");

  /* 성공한 것만 결과에 반영. 시작값은 기존 meta 를 그대로 복사(실패해도 남는다). */
  const merged = Object.assign({}, existing);
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const id = targets[i];
    if (i > 0) await sleep(500); /* watch 요청 간 간격 — rate-limit 완화 */
    const meta = await fetchMeta(id);
    if (meta) {
      merged[id] = meta;
      ok++;
      log("  ✓ " + id + ": " + (meta.channel || "?") + " · " + (meta.views != null ? meta.views : "?") + "회 · " + (meta.published || "?"));
    } else {
      fail++;
      log("  ! " + id + ": 실패 — 기존 값 유지" + (existing[id] ? "" : " (기존 없음)"));
    }
  }

  /* 유실방지: 성공 0건이면 기존 파일을 건드리지 않는다. */
  if (ok === 0) {
    log("  ! 성공 0건 — 기존 파일을 유지한다 (덮어쓰지 않음). 실패 " + fail + "개");
    return;
  }

  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(META, JSON.stringify(merged, null, 1) + "\n", "utf8");
  log(
    "  ✓ aivideo-meta.json 저장: " +
      Object.keys(merged).length +
      "건 (성공 " + ok + " · 실패 " + fail + " · 기존 " + existingCount + ")"
  );
}

main().catch((e) => {
  log("치명적 오류:", e);
  process.exit(1);
});
