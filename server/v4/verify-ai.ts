/**
 * .ai 검증 — 세 가지를 각각 다른 방법으로 확인한다.
 *
 * 1. **레이어**  PDF 를 되읽어 OCG 트리를 세운다. 기능 레이어 아래 파트 하위 레이어가
 *    붙어 있고, 모든 패스가 정확히 하나의 하위 레이어에 속하는가.
 * 2. **그림**    Illustrator 가 아닌 제3의 렌더러(poppler pdftoppm)로 .ai 를 굽고,
 *    같은 장면의 SVG 래스터와 픽셀로 비교한다. 우리 코드가 자기 자신을 채점하지 않게.
 * 3. **끊김**    선이 끊기면 골격의 끝점이 늘어난다. 도면(기준)과 .ai 래스터의 골격
 *    끝점 수·성분 수를 비교하고, 기준 선 위에서 벡터가 덮지 못한 구간의 길이를 잰다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { skeletonize, crossingNumber } from "../vector/centerline.js";
import { inkMask, svgInkMask } from "../v3/metrics.js";
import { labelComponents } from "../v3/label.js";

const run = promisify(execFile);
const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const names = only.length ? only : ORDER;
const TMP = path.join("outputs", "v4", "_verify");
await fs.mkdir(TMP, { recursive: true });

// ── 1. PDF 되읽기 ───────────────────────────────────────────
interface OcgTree { layers: { name: string; children: string[] }[]; loose: number }

function parseOcg(pdf: string): OcgTree {
  // /Type /OCG /Name (…) — 객체 번호와 이름
  // 객체 경계로 자른다. "<< … >> endobj" 를 정규식 하나로 잡으려 하면 안 된다 —
  // content stream 객체가 `>>\nstream` 로 이어지므로 lazy 매치가 다음 객체까지 삼킨다.
  // (처음에 그렇게 썼다가 FILLS 레이어 이름이 통째로 사라졌다.)
  const nameByObj = new Map<number, string>();
  const chunks = pdf.split(new RegExp("(?:^|\\n)(\\d+) 0 obj\\n"));
  for (let i = 1; i < chunks.length; i += 2) {
    const num = Number(chunks[i]), body = chunks[i + 1] ?? "";
    const head = body.slice(0, body.indexOf("endobj"));
    if (!head.includes("/Type /OCG")) continue;
    const n = new RegExp("/Name \\(([^)]*)\\)").exec(head);
    if (n) nameByObj.set(num, n[1]);
  }
  const ord = new RegExp("/Order \\[([^]*?)\\] /ON").exec(pdf);
  const layers: { name: string; children: string[] }[] = [];
  let counted = 0;
  if (ord) {
    // "12 0 R [13 0 R 14 0 R] 20 0 R [21 0 R]" 를 부모+자식으로 쪼갠다
    const TOK = new RegExp("(\\d+) 0 R|\\[([^\\]]*)\\]", "g");
    let pending: string | null = null;
    for (const t of ord[1].matchAll(TOK)) {
      if (t[1]) {
        if (pending) { layers.push({ name: pending, children: [] }); counted++; }
        pending = nameByObj.get(Number(t[1])) ?? `?${t[1]}`;
      } else {
        const kids = [...t[2].matchAll(new RegExp("(\\d+) 0 R", "g"))]
          .map((k) => nameByObj.get(Number(k[1])) ?? `?${k[1]}`);
        layers.push({ name: pending ?? "?", children: kids });
        counted += 1 + kids.length;
        pending = null;
      }
    }
    if (pending) { layers.push({ name: pending, children: [] }); counted++; }
  }
  return { layers, loose: nameByObj.size - counted };
}

/** content stream 에서 BDC/EMC 중첩과 페인트 연산자를 센다 */
function auditContent(pdf: string): {
  maxDepth: number; balanced: boolean; painted: number; outsideLeaf: number; subpaths: number;
} {
  const s = new RegExp("stream\\n([^]*?)endstream").exec(pdf);
  if (!s) return { maxDepth: 0, balanced: false, painted: 0, outsideLeaf: 0, subpaths: 0 };
  let depth = 0, maxDepth = 0, painted = 0, outsideLeaf = 0, subpaths = 0, ok = true;
  for (const line of s[1].split("\n")) {
    const t = line.trim();
    if (t.endsWith("BDC")) { depth++; maxDepth = Math.max(maxDepth, depth); continue; }
    if (t === "EMC") { depth--; if (depth < 0) ok = false; continue; }
    if (t.endsWith(" m")) subpaths++;
    if (t === "f*" || t === "S" || t === "B*") { painted++; if (depth < 2) outsideLeaf++; }
  }
  return { maxDepth, balanced: ok && depth === 0, painted, outsideLeaf, subpaths };
}

// ── 3. 끊김 ────────────────────────────────────────────────
function skeletonStats(mask: Uint8Array, W: number, H: number) {
  const sk = skeletonize(mask, W, H);
  let ends = 0, junctions = 0, len = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!sk[y * W + x]) continue;
      len++;
      const c = crossingNumber(sk, W, H, x, y);
      if (c === 1) ends++;
      else if (c >= 3) junctions++;
    }
  }
  const { components } = labelComponents(sk, W, H, 8, 4);
  return { ends, junctions, len, components: components.length, sk };
}

function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  let cur = m;
  for (let i = 0; i < r; i++) {
    const nx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i0 = y * W + x;
        if (cur[i0] ||
          (x > 0 && cur[i0 - 1]) || (x < W - 1 && cur[i0 + 1]) ||
          (y > 0 && cur[i0 - W]) || (y < H - 1 && cur[i0 + W])) nx[i0] = 1;
      }
    }
    cur = nx;
  }
  return cur;
}

/**
 * 기준 골격 중 벡터 잉크가 덮지 못한 픽셀을 성분으로 묶는다.
 * 한 성분의 길이가 tol 을 넘고, 양쪽 끝이 덮인 골격에 닿아 있으면 **선 중간이 끊긴 것**이다.
 * 끝이 한쪽만 닿아 있으면 선이 짧게 끝난 것(누락)이지 끊김이 아니다.
 */
function findBreaks(refSk: Uint8Array, vecInk: Uint8Array, W: number, H: number, tol: number) {
  const covered = dilate(vecInk, W, H, tol);
  const missing = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (refSk[i] && !covered[i]) missing[i] = 1;
  const { components } = labelComponents(missing, W, H, 8, 1);

  let gaps = 0, gapLen = 0, longest = 0, tails = 0;
  for (const c of components) {
    // 이 조각의 이웃 중 "덮인 기준 골격" 픽셀이 몇 방향에 있나
    const touch = new Set<number>();
    for (const idx of c.pixels) {
      const x = idx % W, y = (idx / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (refSk[j] && covered[j] && !missing[j]) touch.add(j);
        }
      }
    }
    // 닿는 지점이 서로 멀리 떨어진 둘 이상이면 "사이가 비었다"
    const pts = [...touch].map((j) => [j % W, (j / W) | 0]);
    let far = false;
    for (let a = 0; a < pts.length && !far; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        if (Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]) > Math.max(3, c.area * 0.5)) { far = true; break; }
      }
    }
    if (far) { gaps++; gapLen += c.area; longest = Math.max(longest, c.area); }
    else if (touch.size > 0) tails++;
  }
  return { gaps, gapLen, longest, tails, missingComponents: components.length };
}

// ── 실행 ────────────────────────────────────────────────────
const LONG = 1400;
const report: Record<string, unknown>[] = [];
console.log();
for (const name of names) {
  const dir = path.join("docs", "samples-v4", name);
  const aiPath = path.join(dir, "layered.ai");
  const pdf = await fs.readFile(aiPath, "latin1");

  const ocg = parseOcg(pdf);
  const ct = auditContent(pdf);

  // .ai 를 poppler 로 굽는다 (제3의 렌더러).
  // **목표 크기로 바로 굽는다.** 크게 굽고 나중에 줄이면 가는 선이 임계 아래로 흐려져
  // 사라진다 — bag_3(그물)에서 그것만으로 IoU 가 0.77 로 보였다. 렌더러 탓이 아니라
  // 재는 방법 탓이었다.
  const stem = path.join(TMP, name);
  const box = new RegExp("/MediaBox \\[0 0 ([\\d.]+) ([\\d.]+)\\]").exec(pdf)!;
  const pw = Number(box[1]), ph = Number(box[2]);
  const W = Math.round(pw >= ph ? LONG : LONG * (pw / ph));
  const H = Math.round(pw >= ph ? LONG * (ph / pw) : LONG);
  await run("pdftoppm", [
    "-png", "-gray", "-singlefile",
    "-scale-to-x", String(W), "-scale-to-y", String(H), aiPath, stem,
  ]);
  const aiPng = await fs.readFile(`${stem}.png`);

  const aiMask = await inkMask(aiPng, W, H);
  const svgMask = await svgInkMask(await fs.readFile(path.join(dir, "fidelity.svg"), "utf8"), W, H);
  const schMask = await inkMask(await fs.readFile(path.join(dir, "schematic.jpg")), W, H);

  let inter = 0, aOnly = 0, bOnly = 0;
  for (let i = 0; i < W * H; i++) {
    const a = aiMask.data[i], b = svgMask.data[i];
    if (a && b) inter++; else if (a) aOnly++; else if (b) bOnly++;
  }
  const iou = inter / (inter + aOnly + bOnly);

  const sAi = skeletonStats(aiMask.data, W, H);
  const sRef = skeletonStats(schMask.data, W, H);
  const br = findBreaks(sRef.sk, aiMask.data, W, H, 3);

  const groups = ocg.layers.reduce((s, l) => s + l.children.length, 0);
  console.log(`${name}`);
  console.log(`  레이어   ${ocg.layers.length}개 · 하위 ${groups}개 · 트리 밖 OCG ${ocg.loose}개 · 중첩깊이 ${ct.maxDepth} · BDC/EMC ${ct.balanced ? "짝 맞음" : "**안 맞음**"}`);
  console.log(`           ${ocg.layers.map((l) => `${l.name}(${l.children.length})`).join(" · ")}`);
  console.log(`  내용     페인트 ${ct.painted}회 · 서브패스 ${ct.subpaths} · 하위레이어 밖 페인트 ${ct.outsideLeaf}회`);
  console.log(`  그림     .ai(poppler) vs SVG  IoU ${iou.toFixed(4)} · .ai에만 ${aOnly} · SVG에만 ${bOnly}`);
  console.log(`  골격     끝점 도면 ${sRef.ends} → .ai ${sAi.ends} · 성분 도면 ${sRef.components} → .ai ${sAi.components}`);
  console.log(`  끊김     선 중간 끊김 ${br.gaps}곳 (합 ${br.gapLen}px · 최장 ${br.longest}px) · 짧게 끝난 꼬리 ${br.tails}곳`);
  console.log();

  report.push({
    name,
    layers: ocg.layers.length,
    sublayers: groups,
    tree: ocg.layers.map((l) => ({ name: l.name, parts: l.children })),
    looseOcg: ocg.loose,
    depth: ct.maxDepth,
    balanced: ct.balanced,
    painted: ct.painted,
    subpaths: ct.subpaths,
    outsideLeaf: ct.outsideLeaf,
    iou: +iou.toFixed(4),
    onlyAi: aOnly,
    onlySvg: bOnly,
    refEnds: sRef.ends, aiEnds: sAi.ends,
    refComponents: sRef.components, aiComponents: sAi.components,
    gaps: br.gaps, gapLen: br.gapLen, longestGap: br.longest, tails: br.tails,
  });
}

if (names.length === ORDER.length) {
  const dst = path.join("docs", "samples-v4", "ai-verify.json");
  await fs.writeFile(dst, JSON.stringify({ renderer: "poppler pdftoppm", long: LONG, samples: report }, null, 1), "utf8");
  const mean = report.reduce((s, r) => s + (r.iou as number), 0) / report.length;
  console.log(`→ ${dst}   평균 IoU ${mean.toFixed(4)} · 레이어 밖 패스 ${report.reduce((s, r) => s + (r.outsideLeaf as number), 0)}개`);
}
