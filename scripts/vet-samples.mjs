/**
 * 수집 샘플 검수 — **제품 단품컷만 남긴다.**
 *
 * 자유 라이선스 검색은 제품컷 외의 것도 끌고 온다(실측: 사막 풍경·회화·광고판이 섞였다).
 * 그대로 파이프라인에 넣으면 "품질이 나쁘다"가 아니라 "입력이 제품이 아니다"인 실패가
 * 통계를 오염시킨다. GPT 비전에게 한 장씩 물어 제품 단품컷만 통과시킨다.
 *
 *   node scripts/vet-samples.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const ROOT = process.env.VET_IN ?? "inputs/crawl";
const KEEP = process.env.VET_OUT ?? "inputs/vetted";

async function ask(file, cat) {
  const b64 = (await fs.readFile(file)).toString("base64");
  const body = {
    model: process.env.OPENAI_MODEL ?? "gpt-5.6",
    messages: [
      {
        role: "system",
        content:
          "You screen images for a product-flat-sketch pipeline. PASS only if the image is " +
          "a clear product shot of a SINGLE main item of the stated category, where the item " +
          "fills a good part of the frame and its silhouette is unobstructed. " +
          "FAIL landscapes, paintings, people wearing the item, storefronts, ads, " +
          "multiple different products, or extreme close-ups of a detail. " +
          'Reply JSON: {"pass":true|false,"why":"short reason"}',
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Category: ${cat}. Is this a usable single-product shot?` },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    response_format: { type: "json_object" },
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  try { return JSON.parse(j.choices[0].message.content); } catch { return { pass: false, why: "파싱 실패" }; }
}

const credits = JSON.parse(await fs.readFile(path.join(ROOT, "CREDITS.json"), "utf8"));
const kept = [];
for (const cat of ["footwear", "bag", "jewelry"]) {
  await fs.mkdir(path.join(KEEP, cat), { recursive: true });
  const files = (await fs.readdir(path.join(ROOT, cat))).filter((f) => f.endsWith(".png"));
  for (const f of files) {
    const src = path.join(ROOT, cat, f);
    let v;
    try { v = await ask(src, cat); } catch (e) { v = { pass: false, why: String(e).slice(0, 40) }; }
    console.log(`  ${cat}/${f}  ${v.pass ? "통과" : "제외"}  ${(v.why ?? "").slice(0, 60)}`);
    if (!v.pass) continue;
    await fs.copyFile(src, path.join(KEEP, cat, f));
    const cr = credits.find((c) => c.file === `${cat}/${f}`);
    if (cr) kept.push(cr);
  }
}
await fs.writeFile(path.join(KEEP, "CREDITS.json"), JSON.stringify(kept, null, 2));
console.log(`\n검수 통과 ${kept.length}장 → ${KEEP}`);
