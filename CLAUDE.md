# CLAUDE.md — AI 레이더 AI 작업 지침

이 파일은 **AI 레이더 repo에서 작업하는 AI 에이전트(Claude Code 등)를 위한 지침서**입니다.
사람용 설정·운영 안내는 [`README.md`](./README.md)에 있습니다. 이 문서는 "매번 지켜야 할 규칙"만 담습니다.

> ⚠️ **이 프로젝트는 애플시드 관리시스템과 분리된 독립 공개 서비스입니다.**
> 워크스페이스(`../애플시드워크스페이스`)의 CLAUDE.md 규칙(관리시스템·회의·대시보드)은 여기 적용되지 않습니다.
> 회사 판단 기준이 필요하면 노션 COMPANY OS의 🧠 BRAIN, 프로젝트 상세는 노션 "📡 AI 레이더" 페이지를 봅니다.

---

## 1. 무엇인가

- AI 공모전·영화제·지원사업·뉴스 브리핑·유튜브·AI 작품·자유게시판·프로필을 한 화면에서 보는 **공개 정보 서비스 + 커뮤니티**.
- 구성: **정적 사이트 한 장(`index.html`)** + 매일 아침 수집 GitHub Actions(`.github/workflows/collect.yml`) + 수집 결과(`data/*.json`) + 게시판·프로필용 Firebase.
- 배포: `main` 푸시 → **GitHub Pages** → 자체 도메인 **ai-radar.kr**(CNAME, HTTPS 강제).
- 수익 관점: **정보는 미끼, 상품은 교육**(노션 BRAIN 확정). 커뮤니티는 광고가 아니라 교육·수주 모객 채널.

## 2. 🔴 하드 규칙 — `index.html`은 ES5 전용

`index.html`의 인라인 스크립트는 **구형 브라우저까지 열리게 ES5로만** 씁니다. 다음을 쓰지 않습니다:

- 백틱/템플릿 리터럴 `` ` `` · 화살표 함수 `=>` · `let`/`const` · `class` · 구조분해 · 스프레드 · 옵셔널 체이닝
- 문자열은 `+` 연결. 변수는 `var`. 함수는 `function`.

**커밋 전 반드시 검증(둘 다 통과해야 함):**

```bash
grep -c '`' index.html        # 반드시 0
node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");const re=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;let m,i=0,bad=0;while((m=re.exec(h))){i++;try{new Function(m[1])}catch(e){bad++;console.log("SCRIPT#"+i+": "+e.message)}}console.log("scripts:"+i+" errors:"+bad)'
```

`node --check index.html`은 확장자 때문에 실패하므로 쓰지 않습니다. 위 방식으로 인라인 스크립트를 뽑아 검사합니다.

## 3. 배포와 검증

- **코드 변경 = 화면 변경**은 `main` 푸시 즉시 라이브에 반영(1~2분). 푸시 전 대표 눈확인이 필요한 큰 화면 변경은 물어봅니다.
- 라이브 반영 확인은 **캐시 무시**하고 봅니다(브라우저·CDN 캐시 때문에 옛 버전이 보일 수 있음):

```bash
curl -s "https://ai-radar.kr/index.html?cb=$(date +%s)" | grep -o '확인할문자열'
```

- 정적 페이지 재생성: `node scripts/build-pages.mjs` (공모전·영화제·지원사업·브리핑 개별 HTML + `sitemap.xml` + `robots.txt`).
- 주소는 `scripts/build-pages.mjs`의 `SITE_ORIGIN`/`SITE_BASE` 두 줄에만 둡니다. 도메인 이전 시 여기만 고칩니다.

## 4. Firebase (게시판·프로필·구독)

- 프로젝트: **`ai-radar-74be8`** (`.firebaserc`). **관리시스템 Firebase와 절대 공유 금지.** 무료(Spark) 플랜, 결제수단 없음.
- 로그인: 구글만. Firestore: 서울(asia-northeast3). Analytics: GA4 `G-9FBZV3FKFK`.
- 규칙/인덱스 배포:

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

- **보안은 `firestore.rules`가 유일한 방어선**입니다. `index.html`의 `FB_CONFIG`(apiKey 등)는 비밀이 아니라 주소이므로 공개 저장소에 있어도 정상입니다. 규칙을 고치면 반드시 위 명령으로 배포해야 라이브에 적용됩니다(파일만 고치면 반영 안 됨).

## 5. 🔴 보안·원칙 — 절대 어기지 않는다

- **관리시스템 Firebase/키/데이터를 이 repo나 서비스에 넣지 않는다.** 공개 서비스와 사내 데이터 분리.
- **AI 생성 이미지를 "수강생·강사·직원·팀원"으로 표기하지 않는다.** 분위기·연출 이미지로만 쓴다.
- **구독 명단(`subscribers`)은 `read: false`** — 아무도 못 읽는다. 명단 열람은 콘솔/관리자 SDK로만.
- **프로필에 이메일 저장 금지** — 규칙 `hasOnly`로 자리 자체를 막아 둠. 프로필 `photoURL`은 `https://` 또는 업로드 이미지(`data:image;base64`)만.
- **담은 것(`saves`)은 owner-only read/write** — 남이 무엇을 담았는지 공개 안 됨.
- 접근 키·URL 같은 비밀은 문서·코드·산출물에 넣지 않는다.

## 6. 작업 원칙

- 변경은 **외과적으로** — 요청한 것만 손대고, 옆의 멀쩡한 코드·주석·서식은 건드리지 않는다(기존 스타일에 맞춘다).
- 화면 문구는 **보는 사람 기준**의 자연스러운 한국어로.
- 세션에서 한 일은 노션 "📡 AI 레이더" 프로젝트 페이지에 날짜별로 기록(개발 세부는 커밋 해시로 갈음).

---

## 7. 파일 지도

| 경로 | 역할 |
| --- | --- |
| `index.html` | 서비스 전체(SPA, 해시 라우팅, ES5). ~250KB+ |
| `firestore.rules` | 게시판·프로필·작품·구독·담은것 보안 규칙 (유일한 방어선) |
| `firestore.indexes.json` | 복합 인덱스 |
| `scripts/build-pages.mjs` | 검색 노출용 정적 페이지·sitemap 생성 |
| `scripts/collect-*.mjs` | 공모전·힉스필드 등 자체 수집 |
| `data/*.json` | 수집 결과(매일 Actions가 갱신) |
| `.github/workflows/collect.yml` | 매일 08:30 KST 자동 수집 |
| `CNAME` | `ai-radar.kr` |
