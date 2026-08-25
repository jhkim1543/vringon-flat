/**
 * V2 (컬러 플랫 벡터) vs 지금 (V4.5) 종합 비교.
 *
 * 두 파이프라인은 **다른 것을 벡터화한다** — V2 는 컬러 플랫 이미지를, V4 는 VRINGON
 * 도면을. 그래서 "어느 쪽이 원본과 더 닮았나"로는 비교할 수 없다(기준이 다르다).
 * 대신 산출물 자체의 성질을 잰다.
 *
 *   벡터 규모   패스 · 서브패스 · 앵커 · 한 패스 최대 서브패스
 *   레이어      레이어 수 · 파트 그룹 수 · 파트별 기하 유무
 *   선 끊김     칠해진 영역 안에 갇힌 **흰 틈** — 인접 색 영역을 따로 추적해 이어 붙일 때
 *               생기는 결함이다. 사람 눈에 가장 먼저 걸린다.
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import { labelComponents } from "../v3/label.js";

const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];

/** d 문자열의 서브패스·앵커 */
function dStats(svg: string): { paths: number; subpaths: number; anchors: number; maxSub: number } {
  let paths = 0, subpaths = 0, anchors = 0, maxSub = 0;
  for (const m of svg.matchAll(new RegExp('(?:^|[\\s"])d="([^"]*)"', "g"))) {
    paths++;
    const s = (m[1].match(new RegExp("[Mm]", "g")) ?? []).length;
    subpaths += s;
    if (s > maxSub) maxSub = s;
    anchors += (m[1].match(new RegExp("[MLCQSTA]", "g")) ?? []).length;
  }
  return { paths, subpaths, anchors, maxSub };
}

/**
 * 칠해진 영역 안에 갇힌 흰 틈을 센다.
 *
 * 렌더한 뒤 "거의 흰 픽셀" 중 **캔버스 테두리에서 닿지 않는** 덩어리를 찾는다.
 * 제품 안쪽의 정당한 흰 면(반지 구멍 등)은 크므로 면적 상한으로 거른다 — 남는 것이
 * 선 사이로 새어 나온 틈이다.
 */
async function whiteCracks(png: Buffer, W: number, H: number): Promise<{ count: number; px: number }> {
  const g = await sharp(png).resize(W, H, { fit: "fill" }).flatten({ background: "#ffffff" })
    .greyscale().raw().toBuffer();
  const N = W * H;
  const white = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (g[i] >= 240) white[i] = 1;

  // 테두리에서 닿는 흰색 = 배경
  const bg = new Uint8Array(N);
  const st: number[] = [];
  for (let x = 0; x < W; x++) { st.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { st.push(y * W, y * W + W - 1); }
  while (st.length) {
    const i = st.pop()!;
    if (bg[i] || !white[i]) continue;
    bg[i] = 1;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) st.push(i - 1);
    if (x < W - 1) st.push(i + 1);
    if (y > 0) st.push(i - W);
    if (y < H - 1) st.push(i + W);
  }
  const inner = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (white[i] && !bg[i]) inner[i] = 1;

  // 큰 흰 면(반지 구멍 등)은 정당하다 — 캔버스의 0.5% 미만만 "틈"으로 센다
  let count = 0, px = 0;
  const cap = N * 0.005;
  for (const c of labelComponents(inner, W, H, 8, 12).components) {
    if (c.area > cap) continue;
    count++; px += c.area;
  }
  return { count, px };
}

const LONG = 1000;
const rows: string[][] = [];
const tot = { v2p: 0, v2s: 0, v2a: 0, v2c: 0, np: 0, ns: 0, na: 0, nc: 0, v2max: 0, nmax: 0 };

for (const name of ORDER) {
  const v2svg = await fs.readFile(`docs/samples/${name}/result.svg`, "utf8");
  const nowsvg = await fs.readFile(`outputs/v4/v4_${name}/fidelity.svg`, "utf8");
  const a = dStats(v2svg), b = dStats(nowsvg);

  const v2ir = JSON.parse(await fs.readFile(`docs/samples/${name}/result.ir.json`, "utf8"));
  const v2Layers = v2ir.layers.length;
  const v2Groups = v2ir.layers.reduce((s: number, l: { groups: unknown[] }) => s + l.groups.length, 0);
  const scene = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8"));
  const nowParts = scene.parts.length;

  const vb = new RegExp('viewBox="0 0 ([\\d.]+) ([\\d.]+)"').exec(nowsvg)!;
  const cw = Number(vb[1]), ch = Number(vb[2]);
  const W = cw >= ch ? LONG : Math.round(LONG * (cw / ch));
  const H = cw >= ch ? Math.round(LONG * (ch / cw)) : LONG;

  const v2png = await sharp(Buffer.from(v2svg), { density: 96 }).png().toBuffer();
  const nowpng = await sharp(Buffer.from(nowsvg), { density: 96 }).png().toBuffer();
  const ca = await whiteCracks(v2png, W, H);
  const cb = await whiteCracks(nowpng, W, H);

  tot.v2p += a.paths; tot.v2s += a.subpaths; tot.v2a += a.anchors; tot.v2c += ca.count;
  tot.np += b.paths; tot.ns += b.subpaths; tot.na += b.anchors; tot.nc += cb.count;
  tot.v2max = Math.max(tot.v2max, a.maxSub); tot.nmax = Math.max(tot.nmax, b.maxSub);

  rows.push([
    name,
    `${a.paths}→${b.paths}`, `${a.subpaths}→${b.subpaths}`, `${a.anchors}→${b.anchors}`,
    `${v2Layers}L/${v2Groups}G→${nowParts}파트`,
    `${ca.count}→${cb.count}`,
  ]);
}

console.log();
console.log("── V2 → 지금(V4.5) ────────────────────────────────────────────────────────");
console.log("샘플         패스          서브패스        앵커              레이어             흰 틈");
for (const r of rows) {
  console.log(
    r[0].padEnd(11) + r[1].padEnd(14) + r[2].padEnd(16) + r[3].padEnd(18) + r[4].padEnd(19) + r[5],
  );
}
console.log();
console.log(
  `합계         ${tot.v2p}→${tot.np}`.padEnd(24) +
  `${tot.v2s}→${tot.ns}`.padEnd(16) +
  `${tot.v2a}→${tot.na}`.padEnd(18) +
  `한 패스 최대 서브패스 ${tot.v2max}→${tot.nmax}`,
);
console.log(`흰 틈 합계   ${tot.v2c} → ${tot.nc}`);
