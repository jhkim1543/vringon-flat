/**
 * 심사 결과를 **고칠 것 목록**으로 바꾼다 — GPT 에게 코드 맥락과 함께 던진다.
 *
 * 심사자는 "앵커가 많다"까지만 말한다. 그것이 파이프라인 어느 단계의 문제인지,
 * 애초에 고칠 수 있는 것인지(도면 생성 탓인지), 고치면 무엇이 깨지는지는 코드를 아는
 * 쪽이 판단해야 한다. 그래서 지적을 그대로 받아 적지 않고 한 번 걸러 낸다.
 *
 *   npx tsx server/review/triage.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Review } from "./evaluate.js";
import type { Persona } from "./personas.js";

const OPENAI_MODEL = process.env.REVIEW_MODEL ?? "gpt-5.2";

async function openaiKey(): Promise<string> {
  for (const p of [".env", path.join("..", "blueocean-agent", ".env")]) {
    try {
      const t = await fs.readFile(p, "utf8");
      const m = /^\s*OPENAI_API_KEY\s*=\s*(.+)$/m.exec(t);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* 다음 */ }
  }
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  throw new Error("OPENAI_API_KEY 를 못 찾았다");
}

async function ask(prompt: string): Promise<string> {
  const key = await openaiKey();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "너는 래스터→벡터 변환 파이프라인을 만든 엔지니어다. 디자이너 심사평을 받아 " +
              "**고칠 수 있는 것**과 **고칠 수 없는 것**을 가른다. 지적을 그대로 받아 적지 마라. " +
              "근거가 약하거나 이미 의도된 거래인 항목은 그렇게 말하라.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (res.ok) {
      const j = await res.json() as { choices?: { message?: { content?: string } }[] };
      const t = j.choices?.[0]?.message?.content;
      if (t?.trim()) return t;
    }
    if (res.status === 400 || res.status === 401) {
      throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error("OpenAI 응답 실패");
}

const ARCH = `# 파이프라인 구조 (고칠 수 있는 지점)

사진 → [도면 생성: 외부 이미지 모델] → 플랫 스케치 도면(래스터)
     → [evidence.ts] 잉크 마스크 · 해프톤→톤 치환 · 굵은 잉크를 "검게 채운 면"으로 분리 · 보석 반사 제거
     → [segSchematic/SAM] 부품 마스크
     → [scene.ts] 닫힌 면 찾기 → 파트 배정 → 패턴 군집화 → 윤곽 추적(vtracer) → 재피팅
     → [fitCurve.ts] Schneider 최소자승 큐빅 · 코너 검출(꺾인각+NMS)
     → [refit.ts] 전역 DP 앵커 병합(Potrace 식) · 퇴화 조각 제거
     → [continuity.ts] 끊긴 진한 선 재주입
     → [export.ts / aiExport.ts] SVG 3종 + 중첩 OCG 를 가진 .ai(PDF 1.6)

**고칠 수 없는 것**
- 도면이 원본 사진과 다른 것(비례·없는 부품·종횡비). 도면 생성 단계의 문제다.
- 촘촘한 질감(코바늘·니트)의 앵커 수. 구멍이 실제로 수천 개다.
- SVG 에는 가변 폭 스트로크가 없다. 한 패스는 굵기 하나다.

**바꿀 수 있는 것**
- 선 굵기 등급화, 레이어 이름·중첩 규칙, 스트로크 vs 확장 윤곽 선택,
  앵커 허용오차·코너 임계, 면/선 분류 기준, 패턴 압축 정도, 배경 면 판정,
  파트 배정 규칙, 색 병합 기준, 산출물 종류(편집용/생산용 분리)`;

if (process.argv[1]?.replace(/\\/g, "/").endsWith("review/triage.ts")) {
  const dir = path.join("outputs", "_review");
  const reviews = JSON.parse(await fs.readFile(path.join(dir, "reviews.json"), "utf8")) as Review[];
  const personas = JSON.parse(await fs.readFile(path.join(dir, "personas.json"), "utf8")) as Persona[];
  const byId = new Map(personas.map((p) => [p.id, p]));

  const keys = ["편집성", "원본반영", "레이어구성", "실무투입가능성", "기대충족"] as const;
  const avg = (k: typeof keys[number]) =>
    reviews.reduce((a, r) => a + (r.점수?.[k] ?? 0), 0) / Math.max(1, reviews.length);

  const digest = reviews.map((r) => {
    const p = byId.get(r.personaId);
    return `## ${r.personaId} ${p?.이름 ?? ""} — ${p?.역할 ?? ""} (${p?.연차 ?? "?"}년, ${p?.시장 ?? ""}, ${p?.까다로운_정도 ?? ""})
샘플 ${r.sample} · 점수 ${keys.map((k) => `${k} ${r.점수?.[k]}`).join(" · ")} · 판정 "${r.이대로_실무에_쓸수있나}"
좋은점: ${(r.좋은점 ?? []).join(" / ")}
문제점:
${(r.문제점 ?? []).map((x) => `  - [${x.심각도}] ${x.무엇} — ${x.왜문제}`).join("\n")}
고쳐야할것: ${(r.고쳐야할것 ?? []).join(" / ")}
총평: ${r.총평 ?? ""}`;
  }).join("\n\n");

  const prompt = `${ARCH}

# 심사 결과 ${reviews.length}건

평균 점수 (10점 만점): ${keys.map((k) => `${k} ${avg(k).toFixed(1)}`).join(" · ")}
판정 분포: ${["그대로 쓴다", "손보면 쓴다", "못 쓴다"].map((v) =>
    `${v} ${reviews.filter((r) => r.이대로_실무에_쓸수있나 === v).length}`).join(" · ")}

${digest}

# 할 일

1. 지적들을 **묶어라**. 서로 다른 말로 같은 것을 가리키는 것이 많을 것이다.
   몇 명이 말했는지, 어떤 역할이 말했는지 적어라 (한 명만 말한 것도 중요할 수 있다 —
   그 역할만 아는 것일 수 있으므로 "소수"라고 버리지 마라).
2. 각 묶음을 판정하라:
   - **고친다**: 파이프라인에서 바꿀 수 있고, 바꾸면 실제로 나아진다
   - **못 고친다**: 도면 생성 단계나 포맷의 한계다 (이유를 적어라)
   - **거래다**: 고칠 수는 있으나 다른 것을 잃는다 (무엇을 잃는지 적어라)
   - **오해다**: 심사자가 잘못 봤다 (근거를 적어라)
3. "고친다" 항목만 **구현 난이도와 기대 효과**로 순위를 매겨라. 각 항목에
   어느 파일 어느 단계를 건드려야 하는지 적어라.
4. 마지막에 **가장 먼저 할 3가지**를 골라라. 왜 그 셋인지 한 줄씩.

한국어 산문으로. 표를 남발하지 말고, 근거를 붙여 단정적으로 쓰라.`;

  console.log(`\n심사 ${reviews.length}건 → GPT(${OPENAI_MODEL}) 로 분류 중…\n`);
  const out = await ask(prompt);
  const dst = path.join(dir, "triage.md");
  await fs.writeFile(dst, out, "utf8");
  console.log(out);
  console.log(`\n→ ${dst}`);
}
