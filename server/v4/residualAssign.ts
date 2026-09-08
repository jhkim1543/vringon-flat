/**
 * 잔여 잉크 승계 — **주인 없는 큰 잉크 덩어리의 정체만 LLM 에게 묻는다.**
 *
 * 워프 힌트가 무효인 파트(사진에서 거의 안 보이던 체인·클래스프 등)는 SAM 도 못
 * 구한다 — 힌트 자체가 틀렸기 때문이다(실측 bag_2: chain_handle 워프가 캔버스의
 * 0.2% 미만, SAM 후보 IoU 0.04). 그런데 그 파트의 잉크는 도면에 뻔히 있고,
 * 채택된 어느 마스크에도 덮이지 않은 **잔여 성분**으로 남는다.
 *
 * 그래서 역할을 가른다: 경계는 잉크 성분이 이미 정확하게 갖고 있다 — 모르는 것은
 * **정체**뿐이다. 잔여 성분의 실루엣을 GPT 비전에 보여 주고 어느 파트인지만 묻고,
 * 퇴화 마스크(캔버스 0.2% 미만)를 가진 파트에 배정된 성분만 그 파트의 마스크로
 * 승계한다. 건강한 파트는 건드리지 않는다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { labelComponents } from "../v3/label.js";
import { dilate } from "../v2/raster.js";
import { nameComponents, type ComponentInfo } from "../clients/openaiClient.js";

export async function assignResidualInk(opts: {
  ink: Uint8Array;
  W: number;
  H: number;
  partMasks: { id: string; mask: Uint8Array }[];
  partLabels: { id: string; label: string }[];
  tmpDir: string;
  say?: (m: string) => void;
}): Promise<{ upgraded: string[] }> {
  const { ink, W, H, partMasks, say } = opts;
  const N = W * H;


  // 채택 마스크가 못 덮은 잉크 성분
  const covered = new Uint8Array(N);
  for (const pm of partMasks) for (let i = 0; i < N; i++) if (pm.mask[i]) covered[i] = 1;
  const cov2 = dilate(covered, W, H, 2);
  const residual = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (ink[i] && !cov2[i]) residual[i] = 1;

  const comps = labelComponents(residual, W, H, 8, Math.round(N * 0.0008)).components
    .sort((a, b) => b.pixels.length - a.pixels.length)
    .slice(0, 6);
  say?.(`잔여 승계 — 잔여 성분 ${comps.length}개 (최대 ${comps[0]?.pixels.length ?? 0}px)`);
  if (!comps.length) return { upgraded: [] };

  // 실루엣 시트 (한 줄 그리드, 번호 순서)
  const CELL = 300;
  const tiles: Buffer[] = [];
  const infos: ComponentInfo[] = [];
  for (let idx = 0; idx < comps.length; idx++) {
    const c = comps[idx];
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const buf = Buffer.alloc(bw * bh, 255);
    for (let k = 0; k < c.pixels.length; k++) {
      const x = (c.pixels[k] % W) - c.x0, y = ((c.pixels[k] / W) | 0) - c.y0;
      buf[y * bw + x] = 0;
    }
    tiles.push(await sharp(buf, { raw: { width: bw, height: bh, channels: 1 } })
      .resize(CELL, CELL, { fit: "contain", background: "#ffffff" }).png().toBuffer());
    let sx = 0, sy = 0;
    for (let k = 0; k < c.pixels.length; k++) { sx += c.pixels[k] % W; sy += (c.pixels[k] / W) | 0; }
    infos.push({
      index: idx,
      areaPct: +((c.pixels.length / N) * 100).toFixed(2),
      cx: +(sx / c.pixels.length / W).toFixed(3),
      cy: +(sy / c.pixels.length / H).toFixed(3),
      color: "#111111",
    });
  }
  const sheet = await sharp({
    create: { width: CELL * tiles.length, height: CELL, channels: 3, background: "#ffffff" },
  }).composite(tiles.map((t, i) => ({ input: t, left: i * CELL, top: 0 }))).png().toBuffer();
  const sheetPath = path.join(opts.tmpDir, "residual_sheet.png");
  await fs.writeFile(sheetPath, sheet);

  const plan = {
    parts: opts.partLabels.map((p) => ({ id: p.id, name: p.label, parent: "" })),
  };
  // **배정을 캐시한다.** 이 호출만 캐시가 없어서 같은 입력·같은 도면·같은 seg 캐시로 돌려도
  // 결과가 달랐다(실측 2026-09-08 jewelry_1: 잔여 성분 2개의 배정이 `cuff_body 합집합` 과
  // `terminal_hallmark·side_inscription 교체` 로 갈려 마스크 정합 76.0% ↔ 80.8%, 앵커 383 ↔ 404).
  // A/B 로 알고리즘을 재는데 ±5% 잡음이 섞이면 어떤 결론도 못 믿는다.
  const cacheKey = crypto.createHash("sha256")
    .update(sheet)
    .update(JSON.stringify({ plan, infos }))
    .digest("hex");
  const cacheFile = path.join(".cache", "residual", `${cacheKey}.json`);
  let named: Awaited<ReturnType<typeof nameComponents>>;
  try {
    named = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    say?.(`잔여 승계 — GPT 배정 캐시 재사용: ${JSON.stringify(named)}`);
  } catch {
    named = await nameComponents(sheetPath, plan as never, infos);
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(named));
    } catch { /* 캐시 실패는 무시 — 결과는 이미 있다 */ }
    say?.(`잔여 승계 — GPT 배정: ${JSON.stringify(named)}`);
  }

  // 잔여 성분은 **정의상 어떤 마스크에도 없는 영역**이다 — 배정을 합집합으로 받으면
  // 기존 마스크는 절대 줄지 않고, 못 덮던 영역만 주인을 얻는다. 퇴화 파트만 받게
  // 제한하는 규칙은 실측에서 실패했다: 자리를 잘못 잡은 마스크는 크기·잉크량 어느
  // 기준으로도 "퇴화"로 안 잡히는데(남의 잉크를 붙잡고 있어서), GPT 는 잔여 성분을
  // 정확히 그 파트로 지목하고 있었다(bag_2 체인 30,968px).
  const upgraded: string[] = [];
  for (const a of named) {
    if (!a.partId) continue;
    const c = comps[a.index];
    if (!c) continue;
    const pm = partMasks.find((p) => p.id === a.partId);
    if (!pm) continue;
    const add = new Uint8Array(N);
    for (let k = 0; k < c.pixels.length; k++) add[c.pixels[k]] = 1;
    const fat = dilate(add, W, H, 2);
    // 성분이 그 파트가 지금 붙잡은 잉크의 3배를 넘으면, 성분이 곧 파트다 — 기존
    // 마스크는 자리를 잘못 잡은 것이니 **교체**한다. 합집합으로 두면 엉뚱한 옛 영역이
    // 경계 잡음으로 남는다(실측 bag_2 체인: 합집합 bF1 0.31, 정밀도 0.20).
    let own = 0;
    for (let i = 0; i < N; i++) if (pm.mask[i] && ink[i]) own++;
    const replace = c.pixels.length > own * 3;
    if (replace) pm.mask.fill(0);
    for (let i = 0; i < N; i++) if (fat[i]) pm.mask[i] = 1;
    upgraded.push(`${a.partId}(${replace ? "교체" : "합집합"} +${c.pixels.length}px)`);
  }
  if (upgraded.length) say?.(`잔여 잉크 승계 — ${upgraded.join(" · ")}`);
  return { upgraded };
}
