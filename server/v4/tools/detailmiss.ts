/**
 * 소실된 작은 디테일의 **자리**를 찍는다 — `npx tsx server/v4/tools/detailmiss.ts <잡폴더> [out.svg]`
 *
 * QA 의 `detailRecall` 은 몇 개가 사라졌는지만 보고한다. 어디가 사라졌는지 모르면 원인을
 * 못 찾는다. 같은 계산을 그대로 다시 돌려 `missing` 좌표를 도면 위에 찍는다.
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import path from "node:path";
import { inkMask, svgInkMask, detailRecall } from "../../v3/metrics.js";
import { inkSvg } from "../qa4.js";

const job = process.argv[2];
const out = process.argv[3];
if (!job) { console.error("사용: detailmiss <잡폴더> [out.svg]"); process.exit(2); }

const scene = JSON.parse(await fs.readFile(path.join(job, "scene.json"), "utf8"));
const W = scene.canvas.width, H = scene.canvas.height;
const refPng = path.join(job, "schematic.png");
const ref = await inkMask(refPng, W, H, 170);
const vec = await svgInkMask(inkSvg(scene), W, H);
// QA 는 해프톤·반사 제거 영역을 제외하고 센다. 그 마스크는 잡 폴더에 남아 있다 —
// 안 넘기면 표본이 849개가 되어 QA 의 8개와 전혀 다른 이야기를 하게 된다.
let exclude: Uint8Array | undefined;
try {
  const ex = await sharp(path.join(job, "qa_excluded.png")).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  if (ex.info.width === W && ex.info.height === H) {
    exclude = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) exclude[i] = ex.data[i] < 128 ? 1 : 0;   // 검정 = 제외
  } else console.error("  ! qa_excluded.png 크기 불일치 — 제외 없이 센다");
} catch { console.error("  ! qa_excluded.png 없음 — 제외 없이 센다"); }
const small = Math.max(6, Math.round(W * H * 0.00008));
const r = detailRecall(ref, vec, small, 2, exclude, Number(process.env.V4_DETAIL_MIN ?? 12));

console.log(`${path.basename(job)}: 총 ${r.total} · 유지 ${r.kept} · 회수율 ${r.recall}`);
for (const m of r.missing) console.log(`  소실 (${m.x}, ${m.y}) 면적 ${m.area}px`);

if (out) {
  const body = (scene.primitives ?? [])
    .filter((p: { d?: string }) => typeof p.d === "string" && p.d)
    .map((p: { d: string }) => `<path d="${p.d}" fill="none" stroke="#bbb" stroke-width="1.5"/>`).join("");
  const marks = r.missing.map((m) =>
    `<circle cx="${m.x}" cy="${m.y}" r="26" fill="none" stroke="#e00" stroke-width="5"/>`).join("");
  await fs.writeFile(out,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="100%" height="100%" fill="white"/>${body}${marks}</svg>`, "utf8");
  console.log("→", out);
}
