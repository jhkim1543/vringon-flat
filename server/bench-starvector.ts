/**
 * StarVector(fal 호스팅) 벤치마크 — 비동기 큐 방식.
 *
 * 동기 엔드포인트(fal.run)는 8B급 VLM 콜드스타트가 길어 7분 넘게 응답이 없고
 * ECONNRESET으로 끊긴다(실측). queue.fal.run에 제출하고 상태를 폴링한다.
 *
 * 실행: npx tsx server/bench-starvector.ts <jobId>
 * 산출: outputs/_bench/starvector.svg + 우리·Recraft와의 비교 표
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: tsx server/bench-starvector.ts <jobId>");
const flat = path.join(config.outputsDir, jobId, "layers", "_aligned_flat.png");
const OUT = path.join(config.outputsDir, "_bench");
await fs.mkdir(OUT, { recursive: true });

const buf = await sharp(flat).flatten({ background: "#ffffff" }).resize(1024, 1024, { fit: "inside" }).png().toBuffer();
const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
const H = { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" };

async function queued(model: string, body: unknown, maxMin = 25): Promise<any> {
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!sub.ok) throw new Error(`submit ${sub.status}: ${(await sub.text()).slice(0, 300)}`);
  const j: any = await sub.json();
  const statusUrl: string = j.status_url;
  const responseUrl: string = j.response_url;
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 6000));
    const s = await fetch(statusUrl, { headers: H });
    const sj: any = await s.json();
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    if (sj.status === "COMPLETED") {
      const r = await fetch(responseUrl, { headers: H });
      return await r.json();
    }
    if (sj.status === "FAILED") throw new Error(`FAILED: ${JSON.stringify(sj).slice(0, 300)}`);
    process.stdout.write(`\r  ${model} ${sj.status} queue=${sj.queue_position ?? "-"} ${el}s   `);
    if (Date.now() - t0 > maxMin * 60_000) throw new Error("timeout");
  }
}

function svgFromResponse(j: any): string {
  // 후보 필드들을 관대하게 탐색
  const cand = j.svg ?? j.svg_code ?? j.output ?? j.image?.url ?? j.images?.[0]?.url;
  if (typeof cand === "string" && cand.trim().startsWith("<svg")) return cand;
  if (typeof cand === "string" && cand.startsWith("data:image/svg+xml")) {
    const b64 = cand.split(",")[1];
    return cand.includes(";base64,") ? Buffer.from(b64, "base64").toString("utf8") : decodeURIComponent(b64);
  }
  throw new Error(`svg 필드 못 찾음: ${JSON.stringify(j).slice(0, 300)}`);
}

function stats(svg: string) {
  const tags = svg.match(/<path\b[^>]*>/g) ?? [];
  let anchors = 0, open = 0;
  for (const t of tags) {
    const d = /\bd="([^"]+)"/.exec(t)?.[1] ?? "";
    anchors += (d.match(/[LlCcSsQqTtAaHhVv]/g) ?? []).length;
    if (!/[Zz]\s*$/.test(d.trim())) open++;
  }
  return { paths: tags.length, anchors, openPct: tags.length ? Math.round((100 * open) / tags.length) : 0 };
}

console.log(`입력: ${flat}`);
console.log("StarVector 큐 제출 (콜드스타트 수 분 소요 가능)…");
try {
  const t0 = Date.now();
  const res = await queued("fal-ai/star-vector", { image_url: dataUri });
  const svg = svgFromResponse(res);
  await fs.writeFile(path.join(OUT, "starvector.svg"), svg);
  const st = stats(svg);
  console.log(`\nStarVector 완료 ${((Date.now() - t0) / 1000).toFixed(0)}s → 패스 ${st.paths} 앵커 ${st.anchors} 열린 ${st.openPct}%`);
  // 응답 원문도 남긴다 (필드 구조 확인용)
  await fs.writeFile(path.join(OUT, "starvector.response.json"), JSON.stringify(res, null, 2).slice(0, 5000));
} catch (e) {
  console.log(`\nStarVector 실패: ${(e as Error).message.slice(0, 300)}`);
}
