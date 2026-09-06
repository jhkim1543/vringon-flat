/**
 * 페르소나 20명 × 샘플 여러 개의 심사.
 *
 * **각 심사자는 자기 역할의 눈으로만 본다.** 스무 명에게 같은 질문을 던져 평균을 내는 것이
 * 목적이 아니라, 서로 다른 실무가 서로 다른 결함을 잡아내게 하는 것이 목적이다.
 *
 * 심사자에게는 네 장의 그림과 **측정된 사실**을 함께 준다 — 앵커 수를 눈대중으로 세게
 * 하면 숫자를 지어낸다.
 *
 *   npx tsx server/review/evaluate.ts <샘플...> [--personas=p01,p02]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { gemini, parseJson } from "./gemini.js";
import { buildBundle, type Bundle } from "./bundle.js";
import { PERSONA_PATH, type Persona } from "./personas.js";

export interface Score {
  편집성: number;
  원본반영: number;
  레이어구성: number;
  실무투입가능성: number;
  기대충족: number;
}

export interface Review {
  personaId: string;
  sample: string;
  점수: Score;
  총평: string;
  점수이유: Record<string, string>;
  좋은점: string[];
  문제점: { 무엇: string; 왜문제: string; 심각도: "치명" | "중간" | "사소" }[];
  고쳐야할것: string[];
  이대로_실무에_쓸수있나: "그대로 쓴다" | "손보면 쓴다" | "못 쓴다";
}

const RUBRIC = `점수는 1~10 정수다. 후하게 주지 마라. 기준:
  10  이 분야 상용 벡터 파일과 구별이 안 된다
  8   실무에 그대로 투입 가능, 사소한 손질만
  6   쓸 만하지만 손볼 데가 뚜렷하다
  4   기초는 됐으나 다시 그리는 게 빠를 수도
  2   구조가 틀려서 못 쓴다

다섯 항목:
  편집성        앵커를 잡고 끌 수 있는가. 앵커가 필요 이상으로 많거나 뭉쳐 있지 않은가.
                패스를 나누고 합치기 쉬운가. 색을 빨리 바꿀 수 있는가.
  원본반영      원본 사진의 형태·비례·디테일이 살아 있는가. 없는 것을 지어내지 않았는가.
                도면 단계에서 이미 틀린 것과, 벡터화에서 틀린 것을 **구분해서** 보라.
  레이어구성    레이어 이름과 중첩이 당신의 작업 방식에 맞는가. 부품이 제 레이어에 있는가.
  실무투입가능성 당신의 실제 업무(테크팩·자수·인쇄·CAD 등)에 넣을 수 있는가.
  기대충족      "이미지를 .ai 로 바꿔 주는 도구"에 당신이 기대하는 바를 채웠는가.`;

function factsBlock(b: Bundle): string {
  return `[측정된 사실 — 눈대중으로 세지 말고 이 값을 쓰라]\n${JSON.stringify(b.facts, null, 1)}`;
}

async function reviewOne(p: Persona, b: Bundle): Promise<Review> {
  const parts: { text?: string; image?: string }[] = [
    {
      text:
        `너는 아래 인물이다. 이 사람의 눈으로만 판단하라. 다른 직군이 신경 쓸 것을 대신 걱정하지 마라.\n\n` +
        `${JSON.stringify(p, null, 1)}\n\n` +
        `당신에게 "제품 사진을 넣으면 레이어 분리된 .ai 를 뱉는 도구"의 결과물이 왔다.\n` +
        `대상: ${b.category} · 샘플 ${b.name}\n\n` +
        `그림 네 장을 차례로 보여 준다.\n`,
    },
  ];
  for (const img of b.images) {
    parts.push({ text: `\n[${img.label}]` });
    parts.push({ image: img.file });
  }
  parts.push({
    text:
      `\n${factsBlock(b)}\n\n${RUBRIC}\n\n` +
      `주의:\n` +
      `- **도면(2번)이 이미 틀린 것**과 **벡터화(3·4번)가 틀린 것**을 구분해서 지적하라.\n` +
      `  도면이 원본과 다르면 그건 벡터화 탓이 아니다. 다만 최종 사용자에게는 똑같이 문제이므로 적기는 하라.\n` +
      `- 문제점은 **구체적으로**. "품질이 아쉽다" 대신 "뒤꿈치 곡선에 앵커가 6개 붙어 있어 한 번에 못 끈다".\n` +
      `- 좋은 점도 반드시 적어라. 트집만 잡는 심사는 쓸모가 없다.\n` +
      `- 당신의 \`까다로운_정도\`가 "깐깐"이면 8점 이상을 아껴 주고, "관대"면 잘된 것을 인정하라.\n\n` +
      `JSON 으로만 답하라:\n` +
      `{"점수":{"편집성":0,"원본반영":0,"레이어구성":0,"실무투입가능성":0,"기대충족":0},` +
      `"점수이유":{"편집성":"","원본반영":"","레이어구성":"","실무투입가능성":"","기대충족":""},` +
      `"좋은점":[""],"문제점":[{"무엇":"","왜문제":"","심각도":"중간"}],"고쳐야할것":[""],` +
      `"이대로_실무에_쓸수있나":"손보면 쓴다","총평":""}`,
  });

  const txt = await gemini(parts, { json: true, temperature: 0.8, maxTokens: 24000 });
  const r = parseJson<Omit<Review, "personaId" | "sample">>(txt);
  return { ...r, personaId: p.id, sample: b.name };
}

// ── CLI ─────────────────────────────────────────────────────
if (process.argv[1]?.replace(/\\/g, "/").endsWith("review/evaluate.ts")) {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith("--"));
  const only = args.find((a) => a.startsWith("--personas="))?.slice(11).split(",");
  const personas = (JSON.parse(await fs.readFile(PERSONA_PATH, "utf8")) as Persona[])
    .filter((p) => !only || only.includes(p.id));

  console.log(`\n자료 묶는 중 — 샘플 ${names.length}개`);
  const bundles: Bundle[] = [];
  for (const n of names) {
    const b = await buildBundle(n);
    if (!b) { console.log(`  ! ${n} 없음`); continue; }
    bundles.push(b);
    console.log(`  ${n}: 그림 ${b.images.length}장 · 앵커 ${b.facts.총_앵커}`);
  }

  // **심사자별로 서로 다른 샘플을 준다.** 스무 명에게 같은 한 장을 보이면 같은 말이
  // 스무 번 나온다. 역할과 카테고리를 맞춰 돌려 가며 배정한다.
  const pick = (p: Persona, i: number): Bundle => {
    const cat = /주얼리|jewel/i.test(p.주력카테고리) ? "jewelry"
      : /신발|footwear|슈즈|스니커/i.test(p.주력카테고리) ? "footwear"
        : /가방|백|leather|잡화/i.test(p.주력카테고리) ? "bag" : "";
    const fit = cat ? bundles.filter((b) => b.category === cat) : bundles;
    const pool = fit.length ? fit : bundles;
    return pool[i % pool.length];
  };

  const out: Review[] = [];
  const fails: string[] = [];
  console.log(`\n심사 ${personas.length}명 시작`);
  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    const b = pick(p, i);
    try {
      const r = await reviewOne(p, b);
      out.push(r);
      const avg = Object.values(r.점수).reduce((a, c) => a + c, 0) / 5;
      console.log(
        `  ${p.id} ${p.이름.padEnd(11)} ${p.역할.slice(0, 16).padEnd(17)} ${b.name.padEnd(14)} ` +
        `평균 ${avg.toFixed(1)} · ${r.이대로_실무에_쓸수있나} · 문제 ${r.문제점?.length ?? 0}건`,
      );
    } catch (e) {
      fails.push(`${p.id}: ${(e as Error).message.slice(0, 80)}`);
      console.log(`  ${p.id} 실패 — ${(e as Error).message.slice(0, 70)}`);
    }
  }

  const dst = path.join("outputs", "_review", "reviews.json");
  await fs.writeFile(dst, JSON.stringify(out, null, 1), "utf8");
  console.log(`\n심사 ${out.length}건 저장 → ${dst}`);
  if (fails.length) console.log(`실패 ${fails.length}건:\n  ${fails.join("\n  ")}`);
}
