/**
 * 배치 결과 리포트 — 9종 샘플의 품질 지표를 한 표로 모은다.
 * 실행: npx tsx server/report-batch.ts
 *
 * 질감 제거가 목표이므로 "선이 얼마나 줄었는가"와 "구조가 유지되는가"를
 * 함께 본다. 선만 줄고 구조가 무너지면 개선이 아니다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import type { VectorIR } from "./types.js";

const jobsFile = path.join(config.outputsDir, "_samples", "JOBS.txt");
const jobs = (await fs.readFile(jobsFile, "utf8"))
  .trim()
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 2 && !p[1].startsWith("ERR:"));

const S = 512;

/**
 * 어두운 선 픽셀 마스크 — 선 충실도 측정용.
 * 실루엣 IoU는 면적 지배적이라 얇은 프레임·체인 소실을 전혀 못 잡았다
 * (실측: bag_2 프레임이 통째로 없는데 IoU 95.9%).
 */
async function darkMask(buf: Buffer, isSvg: boolean): Promise<Uint8Array> {
  const { data, info } = await (isSvg ? sharp(buf, { density: 150 }) : sharp(buf))
    .flatten({ background: "#ffffff" })
    .resize(S, S, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = data[i * info.channels] < 110 ? 1 : 0;
  return m;
}

/** 2px 허용 오차의 chamfer F1 — 선이 끊기거나 빠지면 recall이 떨어진다 */
function lineF1(ref: Uint8Array, test: Uint8Array): number {
  const dt = (m: Uint8Array) => {
    const INF = 1e9;
    const d = new Float32Array(S * S).fill(INF);
    for (let i = 0; i < S * S; i++) if (m[i]) d[i] = 0;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
        if (y > 0) d[i] = Math.min(d[i], d[i - S] + 1);
      }
    for (let y = S - 1; y >= 0; y--)
      for (let x = S - 1; x >= 0; x--) {
        const i = y * S + x;
        if (x < S - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
        if (y < S - 1) d[i] = Math.min(d[i], d[i + S] + 1);
      }
    return d;
  };
  const dRef = dt(ref), dTest = dt(test);
  const TOL = 2;
  let refN = 0, recall = 0, testN = 0, prec = 0;
  for (let i = 0; i < S * S; i++) {
    if (ref[i]) { refN++; if (dTest[i] <= TOL) recall++; }
    if (test[i]) { testN++; if (dRef[i] <= TOL) prec++; }
  }
  const r = refN ? recall / refN : 1;
  const p = testN ? prec / testN : 1;
  return r + p ? (2 * r * p) / (r + p) : 0;
}

async function mask(buf: Buffer, isSvg: boolean): Promise<Uint8Array> {
  const { data, info } = await (isSvg ? sharp(buf, { density: 150 }) : sharp(buf))
    .flatten({ background: "#ffffff" })
    .resize(S, S, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = data[i * info.channels] < 245 ? 1 : 0;
  return m;
}
const iou = (a: Uint8Array, b: Uint8Array) => {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] && b[k]) i++;
    if (a[k] || b[k]) u++;
  }
  return u ? i / u : 0;
};

console.log(
  "샘플".padEnd(11),
  "그룹".padStart(4),
  "미명명".padStart(6),
  "선".padStart(6),
  "앵커".padStart(7),
  "실루엣".padStart(7),
  "선F1".padStart(6),
  "질감밀도".padStart(8),
);
console.log("-".repeat(60));

for (const [name, id] of jobs) {
  const d = path.join(config.outputsDir, id);
  const base = `flat_${id.slice(0, 8)}`;
  let ir: VectorIR;
  try {
    ir = JSON.parse(await fs.readFile(path.join(d, `${base}.ir.json`), "utf8"));
  } catch {
    console.log(name.padEnd(11), "  — 산출물 없음");
    continue;
  }
  let groups = 0, region = 0, anchors = 0, lw = 0;
  for (const L of ir.layers)
    for (const g of L.groups) {
      groups++;
      if (/^Region /.test(g.name)) region++;
      anchors += g.paths.reduce((n, p) => n + (p.d.match(/[LC]/g) ?? []).length, 0);
      if (g.name === "Linework") lw = g.paths.length;
    }

  let sil = "—";
  let lf = "—";
  try {
    // 복수 인스턴스 잡이면 인스턴스별 플랫을 하나로 합쳐 기준으로 쓴다
    // (각 inst 플랫은 같은 캔버스에 자기 인스턴스만 있으므로 어두운쪽 합성)
    let flatBuf: Buffer;
    const instDirs = (await fs.readdir(d)).filter((f) => f.startsWith("inst_")).sort();
    if (instDirs.length) {
      const parts = await Promise.all(instDirs.map((f) => fs.readFile(path.join(d, f, "layers", "_aligned_flat.png"))));
      let acc = sharp(parts[0]).flatten({ background: "#ffffff" });
      for (const p of parts.slice(1)) acc = sharp(await acc.png().toBuffer()).composite([{ input: p, blend: "darken" }]);
      flatBuf = await acc.png().toBuffer();
    } else {
      flatBuf = await fs.readFile(path.join(d, "layers", "_aligned_flat.png"));
    }
    const svgBuf = await fs.readFile(path.join(d, `${base}.svg`));
    sil = (iou(await mask(flatBuf, false), await mask(svgBuf, true)) * 100).toFixed(1) + "%";
    lf = (lineF1(await darkMask(flatBuf, false), await darkMask(svgBuf, true)) * 100).toFixed(1) + "%";
  } catch {
    /* skip */
  }

  // 질감 밀도 = 캔버스 100만 px당 선 패스 수. 낮을수록 도면이 깔끔하다.
  const density = ((lw / (ir.width * ir.height)) * 1e6).toFixed(0);

  console.log(
    name.padEnd(11),
    String(groups).padStart(4),
    String(region).padStart(6),
    String(lw).padStart(6),
    String(anchors).padStart(7),
    sil.padStart(7),
    lf.padStart(6),
    density.padStart(8),
  );
}
console.log("\n질감밀도 = 캔버스 100만px당 선 패스 수 (낮을수록 깔끔)");
