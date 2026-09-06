/**
 * 심사 페르소나 20명을 만든다.
 *
 * **이들은 실제 사람이 아니다.** 실무 조사 자료를 근거로 Gemini 가 지어낸 인물이고,
 * 결과는 "실사용자 조사"가 아니라 **직업적 관점을 구조화한 비평**으로만 쓴다.
 * 그 한계를 보고서에도 그대로 적는다.
 *
 *   npx tsx server/review/personas.ts [--force]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { gemini, parseJson } from "./gemini.js";

export interface Persona {
  id: string;
  이름: string;
  역할: string;
  연차: number;
  시장: string;
  회사형태: string;
  주력카테고리: string;
  도구: string[];
  하루작업: string;
  파일을받으면_가장먼저_보는것: string;
  이_파일이_쓸모없어지는_조건: string;
  까다로운_정도: "관대" | "보통" | "깐깐";
}

export const PERSONA_PATH = path.join("outputs", "_review", "personas.json");

const PROMPT = (research: string) => `너는 패션·잡화·주얼리 업계의 실무 조사 자료를 받아, **심사 페르소나 20명**을 만드는 일을 맡았다.

아래는 실제 조사 자료다. 여기 나온 역할·업무·평가 기준에 **근거해서만** 만들어라.

<조사자료>
${research}
</조사자료>

이 페르소나들은 "제품 사진 → 플랫 스케치 도면 → 레이어 분리된 Adobe Illustrator .ai" 변환기를 심사한다.

요구사항:
1. **20명이 서로 겹치지 않아야 한다.** 역할·연차·시장·회사형태·카테고리를 골고루 흩어라.
   같은 역할이 둘 이상이면 시장이나 회사 규모가 확실히 달라야 한다.
2. 조사 자료에 나온 역할을 우선 쓰되, 자료에 없는 역할을 지어내지 마라.
3. **까다로운 정도**를 흩어라 — 깐깐 8명, 보통 8명, 관대 4명 정도. 전부 후하거나 전부
   박한 심사는 쓸모가 없다.
4. \`파일을받으면_가장먼저_보는것\` 과 \`이_파일이_쓸모없어지는_조건\` 은 그 역할이
   실제로 하는 일에서 나와야 한다. 두루뭉술한 말("퀄리티가 좋아야 한다") 금지.
   구체적으로: "앵커 잡고 끌었을 때 옆 선까지 딸려오는지", "레이어 잠그고 색만 바꿀 수 있는지" 같이.
5. 이름은 각 시장에 어울리게. 실존 인물 이름은 쓰지 마라.

JSON 배열로만 답하라. 각 원소:
{"id":"p01","이름":"","역할":"","연차":0,"시장":"","회사형태":"","주력카테고리":"","도구":[""],"하루작업":"","파일을받으면_가장먼저_보는것":"","이_파일이_쓸모없어지는_조건":"","까다로운_정도":"깐깐"}`;

if (process.argv[1]?.replace(/\\/g, "/").endsWith("review/personas.ts")) {
  const force = process.argv.includes("--force");
  if (!force) {
    try {
      const cur = JSON.parse(await fs.readFile(PERSONA_PATH, "utf8")) as Persona[];
      console.log(`이미 있음 — ${cur.length}명 (${PERSONA_PATH}). 다시 만들려면 --force`);
      process.exit(0);
    } catch { /* 새로 만든다 */ }
  }
  const research = await fs.readFile(path.join("outputs", "_review", "research.md"), "utf8");
  console.log(`조사 자료 ${research.length}자 → 페르소나 20명 생성 중…`);
  const txt = await gemini([{ text: PROMPT(research) }], { json: true, temperature: 1.0, maxTokens: 40000 });
  const list = parseJson<Persona[]>(txt);
  if (!Array.isArray(list) || list.length < 15) throw new Error(`페르소나가 ${list?.length ?? 0}명뿐이다`);
  await fs.mkdir(path.dirname(PERSONA_PATH), { recursive: true });
  await fs.writeFile(PERSONA_PATH, JSON.stringify(list, null, 1), "utf8");
  console.log(`\n${list.length}명 생성 → ${PERSONA_PATH}\n`);
  for (const p of list) {
    console.log(`  ${p.id} ${p.이름.padEnd(12)} ${p.역할} · ${p.연차}년 · ${p.시장} · ${p.회사형태} · ${p.까다로운_정도}`);
  }
}
