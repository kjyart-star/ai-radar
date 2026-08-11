/* 힉스필드 공모전 수집기 (Playwright)
 *
 * 왜 브라우저가 필요한가:
 *   https://higgsfield.ai/contests 는 완전 클라이언트 렌더라 HTML 원문에 데이터가 없다.
 *   공개 API 도 없다 (/api/contests 404, api.higgsfield.ai 521 — 2026-08-12 실측).
 *   그래서 실제 브라우저로 렌더한 뒤 DOM 에서 뽑는다.
 *
 * 실측한 카드 구조 (2026-08-12):
 *   - 대부분 카드는 <a href="/contests/…"> 안에 상태·상금·<h2>제목</h2>·<p>부제</p> 가 있다
 *   - 일부 카드는 <a> 가 내용 없는 오버레이 링크이고 제목이 aria-label 에만 있다
 *     (예: /contests/make-your-action-scene) — 그래서 aria-label 과 조상 노드를 함께 본다
 *
 * 🔴 실패 시 규칙:
 *   추출 결과가 0건이면 data/higgsfield.json 을 건드리지 않고 종료 코드 0 으로 끝낸다.
 *   빈 배열로 덮어쓰면 화면에 "공모전 없음"이 떠서 없어진 걸로 오해한다.
 *   대신 로그에 크게 남긴다 — 로그를 보면 구조가 바뀐 걸 알 수 있다.
 */

import { chromium } from "playwright";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const OUT = join(DATA, "higgsfield.json");
const PAGE_URL = "https://higgsfield.ai/contests";

const NOISE = /^(prize\s*pool|in\s+higgsfield\s+credits\s+pool|join\s+the\s+(festival|contest)|see\s+winners|learn\s+more|see\s+details|submit|apply(\s+now)?)$/i;
const STATUS_RE = /^(contest\s+(is\s+)?(open|announced|closed|ended)|winners?\s+announced.*|coming\s+soon|ended)$/i;
const PRIZE_RE = /\$\s?\d[\d.,\s]*\d|\$\s?\d/;
const DATE_RE = /^[A-Z][a-z]{2}\s+\d{1,2}\s*[–—-]\s*([A-Z][a-z]{2}\s+)?\d{1,2}$/;

/* "$85 000" 처럼 천 단위가 공백인 경우가 있다 — 콤마로 통일한다 */
function normPrize(s) {
  const m = String(s).match(PRIZE_RE);
  if (!m) return "";
  return m[0].replace(/\s+/g, " ").trim().replace(/(\d)\s(?=\d{3}(\D|$))/g, "$1,");
}
function titleFromSlug(href) {
  const slug = String(href).split("/").filter(Boolean).pop() || "";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseCard(card) {
  const lines = String(card.text || "").split("\n").map((s) => s.trim()).filter(Boolean);

  let status = "", prize = "", dates = "";
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!status && STATUS_RE.test(L)) {
      status = L;
      /* "WINNERS ANNOUNCED ON" / "AUGUST 7" 처럼 두 줄로 쪼개진 경우 붙인다 */
      if (/\bon$/i.test(L) && lines[i + 1] && !PRIZE_RE.test(lines[i + 1])) { status += " " + lines[++i]; }
      continue;
    }
    if (!prize && PRIZE_RE.test(L) && L.replace(PRIZE_RE, "").trim().length < 4) { prize = normPrize(L); continue; }
    if (!dates && DATE_RE.test(L)) { dates = L.replace(/\s+/g, " "); continue; }
    if (NOISE.test(L)) continue;
    rest.push(L);
  }
  if (!prize) prize = normPrize(card.text || "");

  /* 제목은 <h2> 가 있으면 그걸 그대로 쓴다. 없으면 마침표로 끝나지 않는 앞줄들이 제목,
     마침표가 나오는 순간부터가 설명이다 ("GLOBAL FILM FESTIVAL" / "Make your best film in two weeks.") */
  let title = (card.h2 || "").trim();
  let desc = "";
  if (title) {
    /* 제목 바로 옆 <p> 가 부제다. 이걸 안 쓰고 남은 줄을 다 이으면 수상작 목록까지
       설명에 딸려 들어온다 (APPS CONTEST 카드에서 실제로 그랬다). */
    const p = (card.p || "").trim();
    desc = p && !DATE_RE.test(p) ? p
      : rest.filter((L) => L !== title && !title.includes(L) && !DATE_RE.test(L)).join(" ");
  } else {
    const cut = rest.findIndex((L) => /[.!?]$/.test(L));
    if (cut > 0) { title = rest.slice(0, cut).join(" "); desc = rest.slice(cut).join(" "); }
    else { title = rest.join(" "); }
  }
  if (!title) title = (card.aria || "").trim() || titleFromSlug(card.href);

  return { title: title.replace(/\s+/g, " ").trim(), desc: desc.replace(/\s+/g, " ").trim(), status, prize, dates };
}

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await ctx.newPage();

  let items = [];
  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector('a[href^="/contests/"]', { timeout: 60000 });

    /* 지연 렌더 카드가 있다. 끝까지 훑어 전부 붙게 한 뒤 읽는다. */
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1000); await page.waitForTimeout(1000); }
    await page.waitForTimeout(3000);

    const raw = await page.$$eval('a[href^="/contests/"]', (els) =>
      els.map((el) => {
        /* 오버레이 링크(내용 없음)는 카드 본문이 조상에 있다. 위로 올라가며 본문을 찾는다. */
        let host = el, text = (el.innerText || "").trim();
        for (let up = 0; up < 4 && !text && host.parentElement; up++) {
          host = host.parentElement;
          const t = (host.innerText || "").trim();
          if (t && t.length < 600) text = t;
        }
        const h2 = host.querySelector("h2, h1, h3");
        const p = host.querySelector("p");
        const img = host.querySelector("img");
        return {
          href: el.getAttribute("href") || "",
          text,
          h2: h2 ? (h2.innerText || "").trim() : "",
          p: p ? (p.innerText || "").replace(/\s+/g, " ").trim() : "",
          aria: el.getAttribute("aria-label") || "",
          img: img ? img.src : "",
        };
      })
    );

    const seen = new Set();
    for (const r of raw) {
      const href = r.href.split("?")[0].replace(/\/$/, "");
      if (!href || href === "/contests" || seen.has(href)) continue;
      seen.add(href);
      const p = parseCard(r);
      items.push({
        title: p.title,
        url: "https://higgsfield.ai" + href,
        prize: p.prize,
        status: p.status,
        dates: p.dates,
        desc: p.desc,
        thumbnail: r.img && /^https?:/.test(r.img) ? r.img : "",
      });
    }
  } catch (e) {
    console.error("힉스필드 렌더 실패: " + (e.message || e));
  } finally {
    await browser.close();
  }

  console.log(`힉스필드 추출 ${items.length}건`);
  items.forEach((i) => console.log(`  · [${i.status || "상태미상"}] ${i.prize || "상금미상"} | ${i.dates || "기간미상"} | ${i.title} | ${i.url}`));

  if (!items.length) {
    console.error("!! 힉스필드 0건 — DOM 구조가 바뀌었거나 렌더에 실패했다.");
    console.error("!! data/higgsfield.json 을 덮어쓰지 않고 직전 커밋 내용을 그대로 둔다.");
    if (existsSync(OUT)) {
      const prev = JSON.parse(readFileSync(OUT, "utf8"));
      console.error(`!! 유지되는 직전 수집: ${prev.generated} · ${(prev.items || []).length}건`);
    }
    return;
  }

  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: "Higgsfield (higgsfield.ai/contests)",
    page: PAGE_URL,
    items,
  }, null, 1) + "\n", "utf8");
  console.log("data/higgsfield.json 갱신");
}

main();
