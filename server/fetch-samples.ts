/**
 * 테스트용 제품 이미지 수집 (Wikimedia Commons, 자유 라이선스).
 * 실행: npx tsx server/fetch-samples.ts
 *
 * 배경이 단순하고 제품이 크게 찍힌 것만 고르도록 후보를 훑어 점수를 매긴다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";

const OUT = path.join(config.outputsDir, "_samples");
await fs.mkdir(OUT, { recursive: true });

const API = "https://commons.wikimedia.org/w/api.php";
const UA = "vringon-flat-test/1.0 (local research; contact: rebuilderai14@gmail.com)";

interface Cand {
  title: string;
  url: string;
  width: number;
  height: number;
}

async function listCategory(cat: string, limit = 60): Promise<Cand[]> {
  const u =
    `${API}?action=query&format=json&generator=categorymembers` +
    `&gcmtitle=Category:${encodeURIComponent(cat)}&gcmtype=file&gcmlimit=${limit}` +
    `&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1400`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const j: any = await r.json();
  const pages = j.query?.pages ?? {};
  const out: Cand[] = [];
  for (const k of Object.keys(pages)) {
    const ii = pages[k].imageinfo?.[0];
    if (!ii) continue;
    const url: string = ii.thumburl ?? ii.url;
    if (!/\.(jpe?g|png|webp)$/i.test(url.split("?")[0])) continue;
    if ((ii.width ?? 0) < 500) continue;
    out.push({ title: pages[k].title, url, width: ii.width, height: ii.height });
  }
  return out;
}

/** 배경 단순도 + 제품 점유율로 점수 (테크팩 변환에 적합한 컷 고르기) */
async function score(buf: Buffer): Promise<{ ok: boolean; fill: number; plain: number }> {
  const S = 200;
  const { data, info } = await sharp(buf)
    .flatten({ background: "#ffffff" })
    .resize(S, S, { fit: "contain", background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  // 테두리 픽셀의 색 분산이 작으면 단순 배경
  const border: number[][] = [];
  for (let x = 0; x < S; x++) { border.push(px(0, x)); border.push(px(S - 1, x)); }
  for (let y = 1; y < S - 1; y++) { border.push(px(y, 0)); border.push(px(y, S - 1)); }
  function px(y: number, x: number) {
    const i = (y * S + x) * ch;
    return [data[i], data[i + 1], data[i + 2]];
  }
  const mean = [0, 1, 2].map((c) => border.reduce((s, p) => s + p[c], 0) / border.length);
  const varr =
    border.reduce((s, p) => s + (p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2 + (p[2] - mean[2]) ** 2, 0) /
    border.length;
  const plain = Math.max(0, 1 - varr / 3000);

  // 배경색과 다른 픽셀 비율 = 제품 점유율
  let fg = 0;
  for (let i = 0; i < S * S; i++) {
    const p = i * ch;
    const d = Math.hypot(data[p] - mean[0], data[p + 1] - mean[1], data[p + 2] - mean[2]);
    if (d > 40) fg++;
  }
  const fill = fg / (S * S);
  return { ok: plain > 0.55 && fill > 0.06 && fill < 0.85, fill, plain };
}

const GROUPS: { key: string; cats: string[] }[] = [
  { key: "shoe", cats: ["Sneakers", "Running shoes", "Athletic shoes"] },
  { key: "bag", cats: ["Handbags", "Backpacks", "Tote bags"] },
  { key: "jewelry", cats: ["Rings (jewellery)", "Earrings", "Bracelets"] },
];

for (const g of GROUPS) {
  const seen = new Set<string>();
  let saved = 0;
  for (const cat of g.cats) {
    if (saved >= 3) break;
    let cands: Cand[] = [];
    try {
      cands = await listCategory(cat);
    } catch (e) {
      console.log(`  ${cat} 목록 실패: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    for (const c of cands) {
      if (saved >= 3) break;
      if (seen.has(c.title)) continue;
      seen.add(c.title);
      try {
        const r = await fetch(c.url, { headers: { "User-Agent": UA } });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const s = await score(buf);
        if (!s.ok) continue;
        const dest = path.join(OUT, `${g.key}_${saved + 1}.png`);
        await sharp(buf).rotate().flatten({ background: "#ffffff" })
          .resize(1400, 1400, { fit: "inside", withoutEnlargement: true })
          .png().toFile(dest);
        await fs.appendFile(
          path.join(OUT, "SOURCES.txt"),
          `${g.key}_${saved + 1}.png\t${c.title}\thttps://commons.wikimedia.org/wiki/${encodeURIComponent(c.title)}\n`,
        );
        console.log(
          `  ${g.key}_${saved + 1}: ${c.title.replace("File:", "").slice(0, 55)} ` +
            `(제품 ${(s.fill * 100).toFixed(0)}% / 배경단순 ${(s.plain * 100).toFixed(0)}%)`,
        );
        saved++;
      } catch {
        continue;
      }
    }
  }
  if (saved < 3) console.log(`  ⚠ ${g.key}: ${saved}/3개만 확보`);
}
console.log(`\n저장 위치: ${OUT}`);
