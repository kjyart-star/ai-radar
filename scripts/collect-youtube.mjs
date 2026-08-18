/* AI 레이더 — 유튜브 자체수집기 (의존성 없음, Node 20+ 내장 fetch)
 *
 * 왜 이 파일이 있나:
 *   유튜브 화면(renderYoutube)은 그동안 관리시스템 수신부(fetchAiVideos)에서 목록을 받았다.
 *   그런데 그 목록이 거의 회전을 안 해서 매일 같은 영상만 떴다. 그래서 AI 레이더가
 *   직접 채널 RSS(피드)로 최신 업로드를 받아 매일 신선한 목록을 만든다. 공모전 자체수집과
 *   같은 방향(관리시스템 의존 제거).
 *
 * 방식:
 *   채널 RSS = https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>
 *   → 그 채널 최신 ~15개 업로드(Atom <entry>). 키 불필요, CORS 무관(빌드타임 Node fetch).
 *   조회수는 RSS 에 없다 — 넣지 않는다(published 로 충분). 썸네일은 영상ID 로 주소가 정해진다.
 *
 * 원칙(collect-feeds.mjs 와 동일):
 *   - 채널 하나가 죽어도 나머지는 수집한다 (각각 try/catch)
 *   - 수집 0건이면 기존 파일을 덮어쓰지 않는다 (빈 배열로 덮으면 "없어졌다"고 오해한다)
 *   - 결과 JSON 에 generated(ISO) 를 넣는다. 비밀값을 쓰지 않는다(공개 엔드포인트뿐)
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const UA = "Mozilla/5.0 (compatible; ai-radar-bot/1.0; +https://ai-radar.kr/)";
const NOW = new Date().toISOString();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 채널 시드 ----------
 * channelId 는 스크립트가 매번 해석하면 느리므로 값으로 박아 둔다(1회용 해석은 개발 때 끝냄).
 * 주석에 채널 이름을 남긴다. 새 채널을 넣을 땐 여기 한 줄만 추가하면 된다.
 */

/* News 군 — AI 창작/영상 채널 */
const NEWS_CHANNELS = [
  ["전조 INDEX", "UCKnv_2-6K3F5BB8fXup8hfA"],
  ["Higgsfield AI", "UCh13OyDSm-Kb8ij3yZArtFg"],
  ["Gossip Goblin", "UC4oOA0pU7YvHPGOHubo2chg"],
  ["Director Dave Clark", "UCqrWkLKwRKNZRbbJXVEvAjw"],
  ["Particle Panic", "UC-tCW7sRP5KYa791o-onKtg"],
  ["Pizza Later", "UCkEKwSaDElpHBVv0g3koF7w"],
  ["MetaPuppet", "UCsqod3mDyrhIxy8QoZRn0DA"],
  ["Skim On West", "UCHB3rzoUYi0_ArFvb__nRDQ"],
  ["JOEY", "UCG0sRL6J1x62Y-FQTrJmP1w"],
];

/* Vibe 군 — AI 코딩/바이브코딩 채널 */
const VIBE_CHANNELS = [
  ["IndyDevDan", "UC_x36zCEGilGpB1m-V4gmjg"],
  ["Riley Brown", "UCMcoud_ZW7cfxeIugBflSBw"],
  ["AI Jason", "UCrXSVX9a1mj8l0CMLwKgMVw"],
  ["Matthew Berman", "UCawZsQWqfGSbCI5yjkdVkTA"],
  ["Cole Medin", "UCMwVTLZIRRUyyVrkjDpn4pA"],
  ["Volo Builds", "UCBr1IoxBAF9RDPdTzb6459g"],
  ["Greg Isenberg", "UCPjNBjflYl0-HQtUvOx0Ibw"],
  ["조코딩 JoCoding", "UCYaDkwVaOhuoe_LuFr3lWkA"],
  ["The AI Advantage", "UCHhYXsLBEVVnbvsq57n1MTQ"],
  ["Wes Roth", "UCqcbQf6yw5KzRoDDcZ_wBSw"],
];

const NEWS_CAP = 40;   /* 각 군 상위 N */
const VIBE_CAP = 40;

/* ---------- 공통 ---------- */

async function getOnce(url, { timeout = 45000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "application/atom+xml, application/xml, text/xml, */*" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}
/* 유튜브 feeds 엔드포인트는 요청이 몰리면 404/500 을 간헐적으로 뱉는다(채널ID 는 멀쩡).
   지수 백오프로 몇 번 재시도한다 — 그러면 대부분 200 으로 돌아온다. */
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
function decode(s) {
  return entities(unwrapCdata(s ?? "")).replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? m[1] : "";
}
function isoDate(s) {
  const d = new Date(String(s || "").trim());
  return isNaN(d) ? "" : d.toISOString();
}

/* 유튜브 채널 Atom 피드의 <entry> 를 우리 카드 모양으로 뽑는다.
   각 entry: <yt:videoId>, <title>, <link rel="alternate" href>, <published>. */
function parseChannelFeed(xml, channelName) {
  const feedTitle = decode(tag(xml, "title")) || channelName;   /* 피드 상단 title = 채널명 */
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const vid = decode(tag(block, "yt:videoId"));
    if (!vid) continue;
    const title = decode(tag(block, "title"));
    const published = isoDate(tag(block, "published"));
    out.push({
      title: title,
      url: "https://www.youtube.com/watch?v=" + vid,
      videoId: vid,
      channel: channelName || feedTitle,
      published: published,
      thumbnail: "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg",
    });
  }
  return out;
}

async function collectGroup(label, channels, cap) {
  log("[" + label + "]");
  const items = [];
  let okCh = 0;
  for (let idx = 0; idx < channels.length; idx++) {
    const [name, cid] = channels[idx];
    if (idx > 0) await sleep(800);   /* 연속 요청 사이 간격 — feeds 엔드포인트 rate-limit 완화 */
    try {
      const xml = await get("https://www.youtube.com/feeds/videos.xml?channel_id=" + cid);
      const got = parseChannelFeed(xml, name);
      if (got.length) okCh++;
      for (const g of got) items.push(g);
      log("  · " + name + ": " + got.length + "개");
    } catch (e) {
      log("  ! " + name + ": 실패 (" + e.message + ")");
    }
  }
  /* 최신 업로드순 정렬 → videoId 중복 제거 → 상위 cap */
  items.sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  const seen = new Set();
  const dedup = [];
  for (const it of items) {
    if (seen.has(it.videoId)) continue;
    seen.add(it.videoId);
    dedup.push(it);
    if (dedup.length >= cap) break;
  }
  log("  = " + label + ": 채널 " + okCh + "/" + channels.length + " · 영상 " + dedup.length + "개");
  return dedup;
}

/* 수집 0건이면 기존 파일을 덮어쓰지 않는다 */
function save(name, payload, count) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  const path = join(DATA, name);
  if (!count) {
    log("  ! " + name + ": 수집 0건 — 기존 파일을 유지한다 (덮어쓰지 않음)");
    return false;
  }
  writeFileSync(path, JSON.stringify(payload, null, 1) + "\n", "utf8");
  log("  ✓ " + name + ": news " + payload.news.length + " · vibe " + payload.vibe.length);
  return true;
}

/* ---------- main ---------- */

async function main() {
  const news = await collectGroup("News", NEWS_CHANNELS, NEWS_CAP);
  const vibe = await collectGroup("Vibe", VIBE_CHANNELS, VIBE_CAP);
  save("youtube.json", { generated: NOW, news: news, vibe: vibe }, news.length + vibe.length);
}

main().catch((e) => {
  log("치명적 오류:", e);
  process.exit(1);
});
