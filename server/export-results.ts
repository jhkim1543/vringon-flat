/**
 * 결과 패키징 — 샘플 잡들을 사람이 열어보기 좋은 폴더 구조로 모은다.
 * 실행: npx tsx server/export-results.ts
 * 이후 PowerShell Compress-Archive 로 zip 생성.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import type { VectorIR } from "./types.js";

const SAMPLES = path.join(config.outputsDir, "_samples");
const OUT = path.join(config.outputsDir, "_export", "vringon-flat-results");
await fs.rm(path.join(config.outputsDir, "_export"), { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

const jobsTxt = await fs.readFile(path.join(SAMPLES, "JOBS.txt"), "utf8");
const jobs = jobsTxt
  .trim()
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 2 && !p[1].startsWith("ERR:"))
  .map(([name, id]) => ({ name, id }));

const copy = async (src: string, dst: string) => {
  try {
    await fs.copyFile(src, dst);
    return true;
  } catch {
    return false;
  }
};

interface Row {
  name: string;
  groups: number;
  region: number;
  anchors: number;
  lines: number;
  iou: string;
  cerr: string;
}
const rows: Row[] = [];

for (const { name, id } of jobs) {
  const d = path.join(config.outputsDir, id);
  const base = `flat_${id.slice(0, 8)}`;
  const dst = path.join(OUT, name);
  await fs.mkdir(dst, { recursive: true });

  await copy(path.join(d, "raw.png"), path.join(dst, "1_원본.png"));
  await copy(path.join(d, "input.png"), path.join(dst, "2_전처리(배경제거·크롭).png"));
  // 복수 인스턴스 잡은 플랫이 inst_*/layers/ 아래에 있다 → 어두운쪽 합성으로 한 장
  const instDirs = (await fs.readdir(d)).filter((f) => f.startsWith("inst_")).sort();
  if (instDirs.length) {
    try {
      const parts = await Promise.all(
        instDirs.map((f) => fs.readFile(path.join(d, f, "layers", "_aligned_flat.png"))),
      );
      let acc = sharp(parts[0]).flatten({ background: "#ffffff" });
      for (const p of parts.slice(1))
        acc = sharp(await acc.png().toBuffer()).composite([{ input: p, blend: "darken" }]);
      await acc.png().toFile(path.join(dst, "3_플랫스케치.png"));
    } catch {
      /* skip */
    }
  } else {
    await copy(path.join(d, "layers", "_aligned_flat.png"), path.join(dst, "3_플랫스케치.png"));
  }
  await copy(path.join(d, `${base}.ai`), path.join(dst, "4_레이어드.ai"));
  await copy(path.join(d, `${base}.jsx`), path.join(dst, "5_일러스트레이터.jsx"));
  await copy(path.join(d, `${base}.svg`), path.join(dst, "6_벡터.svg"));
  await copy(path.join(d, `${base}.ir.json`), path.join(dst, "7_VectorIR.json"));

  // 벡터 미리보기 렌더
  let irData: VectorIR | null = null;
  try {
    const svg = await fs.readFile(path.join(d, `${base}.svg`), "utf8");
    await sharp(Buffer.from(svg), { density: 160 })
      .flatten({ background: "#ffffff" })
      .resize(1000, 1000, { fit: "inside" })
      .png()
      .toFile(path.join(dst, "0_벡터결과.png"));
    irData = JSON.parse(await fs.readFile(path.join(d, `${base}.ir.json`), "utf8"));
  } catch {
    /* skip */
  }

  // 레이어 목록
  if (irData) {
    let anchors = 0, groups = 0, region = 0, lines = 0;
    const lines_: string[] = [`# ${name} — 레이어 구성`, ""];
    for (const L of irData.layers) {
      lines_.push(`[${L.name}]`);
      for (const g of L.groups) {
        groups++;
        if (/^Region /.test(g.name)) region++;
        const a = g.paths.reduce((n, p) => n + (p.d.match(/[LC]/g) ?? []).length, 0);
        anchors += a;
        if (g.name === "Linework") lines = g.paths.length;
        const style = g.paths[0].stroke
          ? `stroke ${g.paths[0].stroke} ${g.paths[0].strokeWidth}pt`
          : `fill ${g.paths[0].fill}`;
        lines_.push(`   ${g.name.padEnd(24)} 패스 ${String(g.paths.length).padStart(4)}  앵커 ${String(a).padStart(5)}  ${style}`);
      }
    }
    await fs.writeFile(path.join(dst, "레이어목록.txt"), lines_.join("\n"), "utf8");
    rows.push({ name, groups, region, anchors, lines, iou: "-", cerr: "-" });
  }
}

await copy(path.join(SAMPLES, "SOURCES.txt"), path.join(OUT, "이미지출처.txt"));

const readme = `VRINGON FLAT — 이미지 → 플랫 스케치 → 레이어드 .ai
====================================================

폴더마다 한 제품의 전체 변환 과정이 들어 있습니다.

  0_벡터결과.png              최종 벡터 렌더 (미리보기)
  1_원본.png                  입력 이미지
  2_전처리...png              EXIF 보정 · 배경 제거 · 제품 크롭 후
  3_플랫스케치.png            AI가 생성한 플랫 (벡터화 대상)
  4_레이어드.ai               ★ Illustrator에서 바로 열기
  5_일러스트레이터.jsx        Illustrator에서 실행하면 네이티브 .ai 재생성
                              (File > Scripts > Other Script...)
  6_벡터.svg                  레이어 그룹 유지 SVG
  7_VectorIR.json             마스터 데이터 (모든 산출물의 원본)
  레이어목록.txt              파트별 패스·앵커 수와 색/선 굵기

.ai 파일 두 가지 중 무엇을 쓰나
-------------------------------
4_레이어드.ai 는 PDF-OCG 기반으로, Illustrator에서 열면 레이어 패널에
파트가 그대로 나타납니다. 대부분의 경우 이것으로 충분합니다.
완전한 네이티브 편집 메타데이터가 필요하면 5_일러스트레이터.jsx 를
Illustrator에서 실행하세요.

선 레이어에 대해
----------------
CONSTRUCTION/Linework 는 중심선을 추출한 **열린 stroke 패스**입니다.
일반 벡터라이저처럼 선을 면으로 만들지 않았으므로, Illustrator에서
선 굵기를 그대로 바꿀 수 있습니다.

질감이 강한 제품(비즈·메시)은 선이 수천 개로 늘어나 편집이 불가능해지므로
길이 상위 600개만 남깁니다. 몇 개를 제외했는지는 변환 로그에 남습니다.

이미지 출처
-----------
테스트 이미지는 Wikimedia Commons의 자유 라이선스 자료입니다.
개별 출처와 파일명은 이미지출처.txt 를 참고하세요.
`;
await fs.writeFile(path.join(OUT, "README.txt"), readme, "utf8");

console.log(`패키징 완료: ${OUT}`);
console.log(`  ${rows.length}개 제품`);
for (const r of rows)
  console.log(`  ${r.name.padEnd(11)} 그룹 ${String(r.groups).padStart(2)} · 미명명 ${r.region} · 앵커 ${String(r.anchors).padStart(5)} · 선 ${r.lines}`);
