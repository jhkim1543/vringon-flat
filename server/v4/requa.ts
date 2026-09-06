/**
 * 저장된 scene.json 으로 **QA만 다시 채점**한다 — 파이프라인은 안 돌린다.
 *
 * 지표를 고쳤을 때 26장을 재생성하면 두 시간이 걸리고 도면 재과금까지 난다.
 * 채점 규칙만 바뀐 경우에는 장면이 그대로이므로 QA 만 다시 돌리면 된다.
 *
 *   npx tsx server/v4/requa.ts [접두사]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runQa4 } from "./qa4.js";
import type { VectorScene } from "./types.js";

const prefix = process.argv[2] ?? "t_";
const root = "outputs/v4";
const dirs = (await fs.readdir(root)).filter((d) => d.startsWith(`v4_${prefix}`)).sort();

let done = 0;
for (const d of dirs) {
  const dir = path.join(root, d);
  try {
    const scene = JSON.parse(await fs.readFile(path.join(dir, "scene.json"), "utf8")) as VectorScene;
    const prev = JSON.parse(await fs.readFile(path.join(dir, "qa_v4.json"), "utf8"));
    const sd = path.join(dir, "schematics");
    const files = await fs.readdir(sd);
    const schPath = path.join(sd, files.find((f) => /\.(png|jpg)$/.test(f))!);

    // 제외 마스크(해프톤·보석 반사)는 실행 때 저장해 둔 것을 그대로 쓴다
    let texture: Uint8Array | undefined;
    try {
      const { data, info } = await sharp(path.join(dir, "qa_excluded.png"))
        .greyscale().resize(scene.canvas.width, scene.canvas.height, { fit: "fill" })
        .raw().toBuffer({ resolveWithObject: true });
      texture = new Uint8Array(info.width * info.height);
      for (let i = 0; i < texture.length; i++) texture[i] = data[i] < 128 ? 1 : 0;
    } catch { /* 없으면 제외 없음 */ }

    // 파트 마스크는 저장돼 있지 않다 — semantic 은 이전 값을 유지하고 충실도·편집성만 갱신
    const svgs = {
      fidelity: await fs.readFile(path.join(dir, "fidelity.svg"), "utf8"),
      editable: await fs.readFile(path.join(dir, "editable.svg"), "utf8"),
      production: await fs.readFile(path.join(dir, "production.svg"), "utf8"),
    };
    const qa = await runQa4(scene, schPath, svgs, {
      texture,
      partMasks: [],
      aspectRatio: prev.qa?.semantic ? 1 : 1,
      maskFit: prev.maskFit ?? 1,
      lineMode: /_line$/.test(d),
    });
    // semantic 은 파트 마스크가 없으면 못 재므로 이전 결과를 보존한다
    const merged = {
      ...prev,
      qa: { ...qa, semantic: prev.qa.semantic, state: prev.qa.state },
    };
    await fs.writeFile(path.join(dir, "qa_v4.json"), JSON.stringify(merged, null, 2), "utf8");
    done++;
  } catch (e) {
    console.log(`  ! ${d}: ${(e as Error).message.slice(0, 60)}`);
  }
}
console.log(`\nQA 재채점 ${done}/${dirs.length}건`);
