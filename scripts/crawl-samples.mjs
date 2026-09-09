/**
 * 테스트 샘플 수집 — Wikimedia Commons (자유 라이선스, 상업적 재사용 가능).
 *
 * 스톡 사이트(iStock·Shutterstock 등)는 워터마크와 저작권 때문에 테스트 자료로 못 쓴다.
 * Commons 는 CC0/CC BY/CC BY-SA 라 파이프라인 검증에 자유롭게 쓸 수 있다.
 * 출처와 라이선스는 CREDITS.json 에 남긴다 — 나중에 결과를 공유할 때 필요하다.
 *
 *   node scripts/crawl-samples.mjs [카테고리당개수]
 */
import fs from "node:fs/promises";
import path from "node:path";

const UA = "vringon-flat-research/1.0 (https://rebuilder.ai; contact rebuilderai14@gmail.com)";
const OUT = process.env.CRAWL_OUT ?? "inputs/crawl";
const PER = Number(process.argv[2] ?? 10);

/** 카테고리별 검색어 — 단품·정면/측면 제품컷이 나올 법한 표현을 고른다 */
const QUERIES = {
  footwear: [
    "shoe museum collection", "shoe single object", "oxford shoe leather",
    "pump shoe collection", "shoe MET", "boot single", "sneaker single shoe",
    "sandal museum", "moccasin shoe", "shoe Rijksmuseum",
  ],
  bag: [
    "handbag", "backpack", "tote bag", "leather bag", "clutch bag",
    "shoulder bag", "briefcase bag", "purse bag",
  ],
  jewelry: [
    "gold ring", "earring", "pendant necklace", "bracelet jewelry",
    "brooch", "signet ring", "gemstone ring", "silver necklace",
  ],
};

async function search(term, limit) {
  const u = "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
    `&gsrsearch=${encodeURIComponent(term)}&gsrlimit=${limit}` +
    "&gsrnamespace=6&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1400&format=json";
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const j = await r.json();
  return Object.values(j.query?.pages ?? {})
    .map((p) => {
      const ii = p.imageinfo?.[0];
      return ii?.thumburl ? {
        title: p.title,
        url: ii.thumburl,
        page: ii.descriptionurl,
        license: ii.extmetadata?.LicenseShortName?.value ?? "?",
        author: (ii.extmetadata?.Artist?.value ?? "").replace(/<[^>]*>/g, "").slice(0, 80),
      } : null;
    })
    .filter(Boolean);
}

const credits = [];
let n = 0;
for (const [cat, terms] of Object.entries(QUERIES)) {
  await fs.mkdir(path.join(OUT, cat), { recursive: true });
  const seen = new Set();
  let got = 0;
  for (const term of terms) {
    if (got >= PER) break;
    for (const hit of await search(term, 20)) {
      if (got >= PER) break;
      if (seen.has(hit.title)) continue;
      seen.add(hit.title);
      try {
        const res = await fetch(hit.url, {
          headers: { "User-Agent": UA, Referer: "https://commons.wikimedia.org/" },
        });
        if (!res.ok) { console.log(`  ! ${hit.title.slice(0, 40)} — HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 8000) continue; // 너무 작으면 제품컷이 아니다
        const name = `${cat}_${String(got + 1).padStart(2, "0")}.png`;
        await fs.writeFile(path.join(OUT, cat, name), buf);
        credits.push({ file: `${cat}/${name}`, ...hit });
        got++; n++;
        console.log(`  ${name}  ${hit.license.padEnd(12)} ${hit.title.slice(0, 55)}`);
      } catch { /* 개별 실패는 건너뛴다 */ }
    }
  }
  console.log(`[${cat}] ${got}장`);
}
await fs.writeFile(path.join(OUT, "CREDITS.json"), JSON.stringify(credits, null, 2));
console.log(`\n합계 ${n}장 · 출처는 ${OUT}/CREDITS.json`);
