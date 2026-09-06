/** thinAnchors 가 형상을 크게 무너뜨리는 패스를 찾아 해부한다. */
import fs from "node:fs/promises";
import { parsePath } from "../../vector/pathdata.js";
import { thinAnchors, pathDeviation } from "../refit.js";
import type { VectorScene } from "../types.js";

const name = process.argv[2];
const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;
for (const p of sc.primitives) {
  const d = (p as { d?: string }).d;
  if (!d || d.length < 30) continue;
  const nd = thinAnchors(d, 0.6);
  const dev = pathDeviation(d, nd, 1.5);
  if (!Number.isFinite(dev) || dev <= 2) continue;
  const subs = parsePath(d);
  const a0 = (d.match(/[MLC]/g) ?? []).length;
  const a1 = (nd.match(/[MLC]/g) ?? []).length;
  console.log(`\n${p.cls}/${p.id}  이탈 ${dev.toFixed(1)}px · 앵커 ${a0}→${a1} · 서브패스 ${subs.length} (닫힘 ${subs.filter(s=>s.closed).length})`);
  console.log(`  d  = ${d.slice(0, 150)}…`);
  console.log(`  nd = ${nd.slice(0, 150)}…`);
}
