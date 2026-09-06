/**
 * 평가용 자료 묶음 — 심사자에게 **같은 것을 같은 순서로** 보여 주기 위해.
 *
 * 한 샘플당 네 장을 굽는다.
 *   1. 원본 사진      — 무엇을 변환하려 했는가
 *   2. 도면(중간물)   — 파이프라인이 그린 플랫 스케치
 *   3. 최종 벡터      — .ai 를 제3자 렌더러(poppler)로 구운 것. 우리 SVG 가 아니다.
 *   4. 앵커 지도      — .ai 스트림에서 읽은 실제 앵커 위치
 *
 * 3번을 SVG 가 아니라 `.ai` 래스터로 쓰는 것이 중요하다. 심사 대상은 **배포되는 파일**이지
 * 우리가 화면에 그린 그림이 아니다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { readAiAnchors } from "../v4/ai-anchor-render.js";
import type { VectorScene } from "../v4/types.js";

const run = promisify(execFile);
export const BUNDLE_DIR = path.join("outputs", "_review");

export interface Bundle {
  name: string;
  category: string;
  /** 심사자에게 보여 줄 이미지 (파일 경로) */
  images: { label: string; file: string }[];
  /** 심사자에게 함께 주는 **측정된 사실** — 추측으로 채점하지 않게 */
  facts: Record<string, unknown>;
}

async function findPhoto(name: string): Promise<string | null> {
  // 잡 이름의 접두사(t_ 크롤링 · s_ 스트로크)와 접미사(_line)를 벗겨 원본 사진을 찾는다.
  // 접두사가 하나라도 빠지면 심사자가 원본을 못 보고, 그러면 "원본반영" 점수가 무의미해진다.
  const stem = name.replace(/^[ts]_/, "").replace(/_line$/, "");
  for (const p of [`inputs/test30/${stem}.png`, `outputs/_samples/${stem}.png`]) {
    try { await fs.access(p); return p; } catch { /* 다음 */ }
  }
  return null;
}

/** .ai 를 poppler 로 구워 PNG 로 — 제3자 렌더러 */
async function bakeAi(aiPath: string, out: string, long = 1100): Promise<void> {
  const pdf = await fs.readFile(aiPath, "latin1");
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf);
  const pw = Number(box?.[1] ?? 1000), ph = Number(box?.[2] ?? 1000);
  const W = Math.round(pw >= ph ? long : long * (pw / ph));
  const H = Math.round(pw >= ph ? long * (ph / pw) : long);
  const stem = out.replace(/\.png$/, "");
  await run("pdftoppm", ["-png", "-r", "150", "-scale-to-x", String(W), "-scale-to-y", String(H), aiPath, stem]);
  // pdftoppm 은 `-1` 같은 페이지 접미사를 붙인다
  for (const suf of ["-1", "-01", "-001", ""]) {
    try { await fs.rename(`${stem}${suf}.png`, out); return; } catch { /* 다음 후보 */ }
  }
  throw new Error(`pdftoppm 산출물을 못 찾음: ${stem}`);
}

export async function buildBundle(name: string): Promise<Bundle | null> {
  const dir = `outputs/v4/v4_${name}`;
  let sc: VectorScene;
  try { sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8")) as VectorScene; }
  catch { return null; }
  const qa = JSON.parse(await fs.readFile(`${dir}/qa_v4.json`, "utf8"));
  const out = path.join(BUNDLE_DIR, name);
  await fs.mkdir(out, { recursive: true });

  const images: Bundle["images"] = [];

  const photo = await findPhoto(name);
  if (photo) {
    const f = path.join(out, "1_photo.png");
    await sharp(photo).resize(1100, 1100, { fit: "inside" }).png().toFile(f);
    images.push({ label: "원본 사진 (입력)", file: f });
  }

  const sd = `${dir}/schematics`;
  const files = await fs.readdir(sd);
  const sf = files.find((x) => /^schematic.*\.(png|jpg)$/.test(x)) ?? files.find((x) => /\.(png|jpg)$/.test(x));
  if (sf) {
    const f = path.join(out, "2_schematic.png");
    await sharp(path.join(sd, sf)).flatten({ background: "#ffffff" })
      .resize(1100, 1100, { fit: "inside" }).png().toFile(f);
    images.push({ label: "중간 산출물 — 플랫 스케치 도면", file: f });
  }

  const aiPath = `${dir}/layered.ai`;
  const aiPng = path.join(out, "3_ai.png");
  await bakeAi(aiPath, aiPng);
  images.push({ label: "최종 .ai 를 제3자 렌더러로 구운 그림", file: aiPng });

  // **앵커는 이미 구운 .ai 래스터 위에 얹는다.** 별도 프로세스를 띄우면 Windows 에서
  // `npx` 를 못 찾고, 같은 파일을 두 번 굽는 낭비도 생긴다.
  const anchors = await readAiAnchors(aiPath);
  const anchorPng = path.join(out, "4_anchors.png");
  {
    const meta = await sharp(aiPng).metadata();
    const W = meta.width!, H = meta.height!;
    const sx = W / anchors.page[0], sy = H / anchors.page[1];
    const R = Math.max(1.6, Math.min(W, H) * 0.0022);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<g stroke="#b9c4d0" stroke-width="${(R * 0.45).toFixed(2)}" fill="none" opacity="0.8">` +
      anchors.handles.map(([x1, y1, x2, y2]) =>
        `<path d="M${(x1 * sx).toFixed(1)} ${(y1 * sy).toFixed(1)}L${(x2 * sx).toFixed(1)} ${(y2 * sy).toFixed(1)}"/>`).join("") +
      `</g><g>` +
      anchors.dots.map((d) =>
        `<circle cx="${(d.x * sx).toFixed(1)}" cy="${(d.y * sy).toFixed(1)}" r="${R.toFixed(2)}" ` +
        `fill="${d.corner ? "#e0342c" : "#2f6fd0"}" stroke="#fff" stroke-width="${(R * 0.3).toFixed(2)}"/>`).join("") +
      `</g></svg>`;
    await sharp(aiPng).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(anchorPng);
  }
  images.push({ label: "실제 앵커 위치 (파랑=곡선 앵커 · 빨강=꺾임 앵커)", file: anchorPng });

  // 레이어 구조 — 이름과 중첩을 그대로
  const layers: Record<string, string[]> = {};
  {
    const { sceneToAiDoc } = await import("../v4/aiExport.js");
    const doc = sceneToAiDoc(sc);
    for (const l of doc.layers) layers[l.name] = l.groups.map((g) => `${g.name} (${g.paths.length} paths)`);
  }

  const gaps: number[] = [];
  for (let i = 1; i < anchors.dots.length; i++) {
    if (anchors.dots[i].corner) continue;
    gaps.push(Math.hypot(anchors.dots[i].x - anchors.dots[i - 1].x, anchors.dots[i].y - anchors.dots[i - 1].y));
  }
  gaps.sort((a, b) => a - b);
  const q = (p: number) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(1) : 0);

  return {
    name,
    category: name.replace(/^t_/, "").split("_")[0],
    images,
    facts: {
      캔버스: `${sc.canvas.width}x${sc.canvas.height}px`,
      "AI 페이지": `${anchors.page[0].toFixed(0)}x${anchors.page[1].toFixed(0)}pt`,
      총_앵커: anchors.dots.length,
      곡선_앵커: anchors.dots.filter((d) => !d.corner).length,
      꺾임_앵커: anchors.dots.filter((d) => d.corner).length,
      앵커_간격_pt: { p10: q(0.1), 중앙: q(0.5), p90: q(0.9) },
      레이어별_앵커: Object.fromEntries(anchors.byLayer),
      레이어_구조: layers,
      프리미티브_수: sc.primitives.length,
      부품_수: sc.parts.length,
      자동판정: {
        충실도: qa.qa.fidelity.pass ? "통과" : "검토",
        편집성: qa.qa.editability.pass ? "통과" : "검토",
        의미: qa.qa.semantic.pass ? "통과" : "검토",
      },
      선모드: /_line$/.test(name),
    },
  };
}
