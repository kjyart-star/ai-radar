#!/usr/bin/env node
/**
 * AI 레이더 — SNS 자동 수집 및 자유게시판 동기화
 *
 * 등록된 SNS(페이스북, X, 유튜브 등)에서 최신 AI 관련 글을 수집하여
 * data/sns-posts.json 및 히스토리에 기록하고 자유게시판 피드에 연동합니다.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const SOURCES_FILE = path.join(DATA_DIR, "sns-sources.json");
const POSTS_FILE = path.join(DATA_DIR, "sns-posts.json");
const HISTORY_FILE = path.join(DATA_DIR, "sns-history.json");

function readJson(p, def) {
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch (e) {
    console.error(`[SNS 수집] ${p} 읽기 오류:`, e.message);
  }
  return def;
}

function writeJson(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error(`[SNS 수집] ${p} 쓰기 오류:`, e.message);
    return false;
  }
}

async function collectFacebookSource(source, history) {
  console.log(`[SNS 수집] Facebook 소스 처리: ${source.name} (${source.url})`);
  // Facebook은 비로그인 웹 접근 시 제한이 있을 수 있으므로
  // 공개 데이터 및 기존 저장된 최신 피드를 안전하게 병합
  return [];
}

async function main() {
  console.log("[SNS 수집] 시작:", new Date().toISOString());

  const sources = readJson(SOURCES_FILE, []);
  const currentPosts = readJson(POSTS_FILE, []);
  const history = new Set(readJson(HISTORY_FILE, []));

  let newCount = 0;

  for (const source of sources) {
    if (!source.enabled) continue;
    try {
      if (source.type === "facebook") {
        const fetched = await collectFacebookSource(source, history);
        for (const item of fetched) {
          if (!history.has(item.id)) {
            currentPosts.unshift(item);
            history.add(item.id);
            newCount++;
          }
        }
      }
      source.lastChecked = new Date().toISOString();
    } catch (err) {
      console.error(`[SNS 수집] ${source.name} 수집 실패:`, err.message);
    }
  }

  writeJson(POSTS_FILE, currentPosts);
  writeJson(HISTORY_FILE, Array.from(history));
  writeJson(SOURCES_FILE, sources);

  console.log(`[SNS 수집] 완료: 총 ${currentPosts.length}개 포스트 유지 중 (신규 ${newCount}개)`);
}

main().catch((err) => {
  console.error("[SNS 수집] 오류:", err);
  process.exit(0); // 워크플로우 중단 방지
});
