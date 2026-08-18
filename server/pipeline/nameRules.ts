import type { LayerPlan } from "../types.js";

/**
 * 규칙 기반 파트 명명 — GPT 명명의 폴백이자 검증자.
 *
 * GPT 비전 명명은 두 가지 약점이 있었다: 실행마다 흔들리고(비결정), 크레딧이
 * 소진되면 전부 `Region N`이 된다(실측). 여기서는 API 없이 조각의
 * **위치·크기·색**만으로 Layer Plan의 파트에 배정한다.
 *
 * 원리: 카테고리별로 파트가 "어디에 있어야 하는지"를 정규화 좌표(0~1)로
 * 알고 있다. 신발 측면뷰에서 미드솔은 하단, 토캡은 앞쪽 하단, 힐카운터는
 * 뒤쪽 중단 식이다. 조각의 중심이 그 위치에 가깝고 크기가 맞으면 배정한다.
 * 위치가 애매한 파트(로고·스티치)는 배정하지 않고 남긴다 — 틀린 이름보다
 * 없는 이름이 낫다.
 *
 * 색 사전(prior): Layer Plan의 파트 id/segPrompt에는 GPT가 본 색이 들어
 * 있다("black_mesh_quarter", "pink ribbed heel counter"). 이걸 안 쓰면 흰
 * 미드솔 조각이 "Quarter"가 되고 핑크 에어유닛이 "black_rubber_outsole"이
 * 된다(실측: shoe_1 — 그 결과 검정 몸통이 흰 이름을 물려받아 재합성 ΔE 244).
 * 색 단어가 있는 파트는 조각의 색 계열이 맞아야만 배정한다.
 */

export interface CompGeom {
  index: number;
  cx: number; // 0~1
  cy: number; // 0~1
  areaPct: number; // 캔버스 대비 %
  color: string; // #rrggbb — 플랫에서 실제로 보이는 색
  /** 리본 근사 폭이 스트로크 한계 미만(체인·스트랩·파이핑). 모르면 undefined */
  thin?: boolean;
}

export interface RuleOptions {
  /** 측면뷰에서 뒤꿈치가 있는 쪽. 모르면 x 조건은 무시한다 */
  heelSide?: "left" | "right";
  /**
   * 조각 index → 그 조각이 충분히 겹치는 SAM 3 개념들 (예: {"sole","shoelace"}).
   * 개념이 검출된 파트(끈·텅·솔)는 그 마스크와 겹치는 조각이어야 이름을 받는다.
   * 개념 자체가 검출되지 않았으면(맵에 없음) 제약하지 않는다.
   */
  concepts?: { detected: Set<string>; ofComp: Map<number, Set<string>> };
  /** 배정 최소 점수 (기본 0.55). 2차 명명(잔차 조각)은 더 엄격하게 쓴다 */
  minScore?: number;
}

/** 파트 키워드 → SAM 3 개념. 검출된 개념만 제약에 쓴다 */
const PART_CONCEPT: [string[], string][] = [
  [["lace", "shoelace"], "shoelace"],
  [["tongue"], "tongue"],
  [["outsole"], "sole"], // 미드솔은 SAM 3 "sole"에 안 잡히는 일이 있어 제외
  [["handle"], "handle"],
  [["strap"], "strap"],
  [["zipper"], "zipper"],
  [["buckle"], "buckle"],
  [["stone", "gem", "diamond"], "gemstone"],
];

interface Rule {
  /** plan.parts[].id 또는 name과 매칭할 키워드 (소문자, 부분 일치) */
  match: string[];
  /** 기대 중심 (0~1) — 측면뷰 기준. undefined면 그 축은 무시 */
  cx?: [number, number];
  cy?: [number, number];
  /** 기대 면적 범위 (%) */
  area?: [number, number];
  /** 어두운(true)/밝은(false) 색만 허용. undefined면 무시 */
  dark?: boolean;
  /** 뒤꿈치 쪽(heel)/앞코 쪽(toe)에 있어야 하는 파트 — heelSide를 알 때만 적용 */
  side?: "heel" | "toe";
  /** 가늘어야 하는 파트(체인·끈) / 뭉툭해야 하는 파트(클래스프·버클) */
  shape?: "thin" | "compact";
}

// 좌우 대칭 뷰(측면)에서 "앞/뒤"는 이미지마다 다르므로 x 조건은 side로만 준다.
//
// NOTE: 규칙의 면적 상한이 넓으면 **몸통 전체 조각**이 세부 파트 이름을 가져간다.
// 실측: Air Max에서 검정 몸통(면적 ~35%)이 Vamp 규칙(3~40%)에 걸려 "Vamp"가
// 붙었다. Vamp 같은 부분 파트는 상한을 낮추고, 몸통급 조각은 Quarter/Upper
// (측면뷰에서 가장 큰 갑피 파트)로 보낸다 — 색 사전이 있으니 이제 안전하다.
const RULES: Record<string, Rule[]> = {
  footwear: [
    { match: ["outsole", "tread"], cy: [0.78, 1.0], area: [2, 25] },
    { match: ["midsole"], cy: [0.62, 0.9], area: [3, 30] },
    { match: ["air unit", "air_unit", "air bag", "airbag", "cushion"], cy: [0.6, 0.92], area: [1, 20] },
    { match: ["toe", "toecap", "toe_cap", "mudguard"], cy: [0.45, 0.85], area: [1, 12], side: "toe" },
    { match: ["heel", "counter"], cy: [0.25, 0.75], area: [0.6, 12], side: "heel" },
    { match: ["collar", "topline", "ankle"], cy: [0.0, 0.4], area: [0.5, 10] },
    { match: ["tongue"], cy: [0.0, 0.45], area: [0.5, 10] },
    { match: ["lace", "shoelace"], cy: [0.05, 0.55], area: [0.2, 8], shape: "thin" },
    { match: ["eyestay", "eyelet"], cy: [0.1, 0.55], area: [0.3, 12] },
    { match: ["vamp"], cy: [0.3, 0.75], area: [2, 18] },
    { match: ["quarter", "side panel", "upper"], cy: [0.15, 0.7], area: [3, 50] },
    // 측면 로고(스우시 등)는 몸통 중앙부에 있는 중간 크기 조각
    { match: ["logo", "branding", "swoosh", "emblem", "badge"], cx: [0.3, 0.75], cy: [0.2, 0.75], area: [0.3, 5] },
  ],
  bag: [
    { match: ["base", "bottom"], cy: [0.75, 1.0], area: [2, 30] },
    { match: ["chain", "strap", "cord", "drawstring"], cy: [0.0, 0.4], area: [0.3, 15], shape: "thin" },
    { match: ["handle"], cy: [0.0, 0.32], area: [0.3, 15] },
    { match: ["flap", "lid"], cy: [0.1, 0.5], area: [3, 40] },
    { match: ["closure", "clasp", "lock", "buckle", "turnlock"], cy: [0.2, 0.6], area: [0.2, 4], shape: "compact" },
    { match: ["frame", "trim", "piping", "binding"], cy: [0.05, 0.6], area: [0.3, 15] },
    { match: ["zipper", "zip"], cy: [0.1, 0.7], area: [0.2, 6] },
    { match: ["gusset", "side"], area: [1, 25] },
    { match: ["front", "body", "panel", "main"], cy: [0.3, 0.9], area: [8, 70] },
    { match: ["logo", "branding", "emblem", "plaque", "monogram"], cy: [0.2, 0.8], area: [0.1, 6] },
    { match: ["stone", "stud", "bead", "rivet", "crystal", "gem", "pearl"], area: [0.05, 8] },
  ],
  jewelry: [
    { match: ["stone", "gem", "diamond", "center"], area: [0.5, 25], dark: false },
    { match: ["prong", "claw"], area: [0.05, 3] },
    { match: ["bezel", "setting", "head"], area: [0.5, 15] },
    { match: ["shank", "band", "hoop", "ring"], area: [3, 60] },
    { match: ["engrav", "detail", "hallmark"], area: [0.05, 5] },
  ],
};

function lum(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// ── 색 사전 ─────────────────────────────────────────────────

/** 파트 텍스트에 나올 법한 색 단어 → 색 계열 */
const COLOR_WORDS: Record<string, string> = {
  black: "black", jet: "black", charcoal: "black", onyx: "black",
  white: "white", ivory: "white", cream: "white", "off-white": "white", offwhite: "white",
  gray: "gray", grey: "gray", graphite: "gray", slate: "gray", gunmetal: "gray",
  silver: "silver", steel: "silver", chrome: "silver", platinum: "silver", metallic: "silver",
  red: "red", crimson: "red", scarlet: "red", burgundy: "red", maroon: "red", wine: "red",
  pink: "pink", rose: "pink", magenta: "pink", fuchsia: "pink", coral: "pink", blush: "pink",
  orange: "orange", tangerine: "orange", copper: "orange", rust: "orange",
  yellow: "yellow", mustard: "yellow", lemon: "yellow",
  gold: "gold", golden: "gold", brass: "gold", bronze: "gold", amber: "gold",
  green: "green", olive: "green", khaki: "green", lime: "green", mint: "green", emerald: "green", sage: "green",
  teal: "teal", turquoise: "teal", cyan: "teal", aqua: "teal",
  blue: "blue", navy: "blue", cobalt: "blue", denim: "blue", indigo: "blue", royal: "blue",
  purple: "purple", violet: "purple", lavender: "purple", lilac: "purple", plum: "purple",
  brown: "brown", chocolate: "brown", cognac: "brown", espresso: "brown", mahogany: "brown", chestnut: "brown",
  tan: "tan", beige: "tan", camel: "tan", nude: "tan", sand: "tan", taupe: "tan", caramel: "tan",
};

/** 파트 텍스트에서 첫 색 계열을 찾는다. 없으면 undefined (제약 없음) */
export function colorFamilyOfText(text: string): string | undefined {
  const words = text.toLowerCase().split(/[^a-z-]+/).filter(Boolean);
  for (const w of words) {
    if (COLOR_WORDS[w]) return COLOR_WORDS[w];
    // "rosegold", "goldtone", "grayish" 처럼 색 단어로 시작하는 합성어.
    // 접두 일치만 본다 — 부분 일치는 "stand"→tan 같은 오탐을 낸다.
    for (const [k, fam] of Object.entries(COLOR_WORDS))
      if (k.length >= 4 && w.length > k.length && w.startsWith(k)) return fam;
  }
  return undefined;
}

/**
 * hex 색이 속할 수 있는 계열들. 경계는 넉넉히 겹치게 둔다 — 색 사전은
 * "확실히 다른 색"을 걸러내는 용도지 정밀 분류가 아니다.
 */
export function colorFamiliesOfHex(hex: string): Set<string> {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  // 무채색 판정은 HSL 채도가 아니라 크로마(max-min)로 한다 — HSL 채도는 아주
  // 밝은 색에서 부풀려져 크림(#f1ece1)이 "노랑"으로 분류된다(실측: bag_2 몸통).
  const out = new Set<string>();
  if (l < 0.24) out.add("black");
  if (l > 0.82 && d < 0.2) out.add("white");
  if (d < 0.12 && l >= 0.18 && l <= 0.88) out.add("gray");
  // 은·스틸·크롬은 플랫에서 밝은 무채색(#f0f0f0 ~ #a0a0a0)으로 그려진다
  if (d < 0.15 && l > 0.5) out.add("silver");
  if (d < 0.12) {
    // 무채색은 여기까지 — 단, 아주 어둡거나 밝은 무채색은 위에서 처리됨
    if (!out.size) out.add("gray");
    return out;
  }
  // 유채색 (채도 있음)
  const hueIn = (a: number, b2: number) => (a <= b2 ? h >= a && h <= b2 : h >= a || h <= b2);
  if (hueIn(345, 12)) { out.add("red"); if (l > 0.5) out.add("pink"); }
  if (hueIn(300, 350)) out.add("pink");
  if (hueIn(320, 12) && l > 0.42) out.add("pink");
  if (hueIn(8, 40)) {
    if (l < 0.42) out.add("brown");
    else if (s < 0.5 || l > 0.7) out.add("tan");
    else out.add("orange");
    if (l >= 0.35 && l <= 0.62 && s >= 0.45) out.add("orange");
  }
  if (hueIn(38, 70)) { out.add("yellow"); if (l < 0.4) out.add("brown"); if (s < 0.5 && l > 0.6) out.add("tan"); }
  // 금·황동은 플랫에서 탁한 황갈색(#96774a)부터 밝은 노랑까지 폭넓게 그려진다
  if (hueIn(18, 70) && l >= 0.2) out.add("gold");
  if (hueIn(70, 165)) out.add("green");
  if (hueIn(160, 200)) out.add("teal");
  if (hueIn(195, 260)) out.add("blue");
  if (hueIn(255, 305)) out.add("purple");
  // 크로마가 낮은 색은 black/gray/white로도 통과 (실측: 검정 메시가 #2a2b2c)
  if (l < 0.3 && d < 0.2) out.add("black");
  if (d < 0.22 && l >= 0.25 && l <= 0.8) out.add("gray");
  if (d < 0.22 && l > 0.5) out.add("silver");
  if (l > 0.85 && d < 0.25) out.add("white");
  return out;
}

/**
 * 조각 → 파트 배정. 각 파트는 최대 한 번만 쓴다.
 * 점수 = 위치 적합도 × 면적 적합도 × 색 적합도. 임계 미만이면 배정하지 않는다.
 */
export function assignByRules(
  plan: LayerPlan,
  comps: CompGeom[],
  opts: RuleOptions = {},
): { index: number; partId: string }[] {
  const rules = RULES[plan.category] ?? [];
  if (!rules.length) return [];

  // 파트마다 적용할 규칙 + 색 계열 + SAM 3 개념 찾기
  const partRule = new Map<string, Rule>();
  const partColor = new Map<string, string | undefined>();
  const partConcept = new Map<string, string>();
  for (const p of plan.parts) {
    const key = `${p.id} ${p.name}`.toLowerCase();
    const r = rules.find((rule) => rule.match.some((m) => key.includes(m)));
    if (r) partRule.set(p.id, r);
    partColor.set(p.id, colorFamilyOfText(`${p.id} ${p.name} ${p.segPrompt ?? ""}`));
    const pc = PART_CONCEPT.find(([kws]) => kws.some((k) => key.includes(k)));
    if (pc && opts.concepts?.detected.has(pc[1])) partConcept.set(p.id, pc[1]);
  }
  if (!partRule.size) return [];

  const inRange = (v: number, r?: [number, number]) =>
    !r ? 1 : v >= r[0] && v <= r[1] ? 1 : Math.max(0, 1 - Math.min(Math.abs(v - r[0]), Math.abs(v - r[1])) / 0.25);

  // 모든 (조각, 파트) 쌍의 점수 → 탐욕 배정
  const pairs: { i: number; partId: string; score: number }[] = [];
  for (const c of comps) {
    const fams = colorFamiliesOfHex(c.color);
    const myConcepts = opts.concepts?.ofComp.get(c.index);
    for (const [partId, r] of partRule) {
      let s = inRange(c.cx, r.cx) * inRange(c.cy, r.cy);
      if (r.side && opts.heelSide) {
        // 힐카운터·토캡은 양 끝 1/3 안에 있다. 중앙 파트(로고 바·스우시)는
        // 허용 오차 없이 제외한다 — 여유를 주면 cx 0.37의 로고 바가 힐카운터가 된다.
        const onHeelSide = (opts.heelSide === "left") === c.cx < 0.5;
        const nearEnd = c.cx < 0.36 || c.cx > 0.64;
        if ((r.side === "heel") !== onHeelSide || !nearEnd) s = 0;
      }
      if (r.area) {
        const [lo, hi] = r.area;
        s *= c.areaPct >= lo && c.areaPct <= hi ? 1 : c.areaPct < lo ? c.areaPct / lo : Math.max(0, 1 - (c.areaPct - hi) / hi);
      }
      if (r.dark !== undefined) {
        const isDark = lum(c.color) < 0.5;
        if (isDark !== r.dark) s *= 0.3;
      }
      const want = partColor.get(partId);
      if (want) s *= fams.has(want) ? 1 : 0.15;
      // 형상 힌트: 체인·끈은 가늘고, 클래스프·버클은 뭉툭하다
      if (r.shape && c.thin !== undefined) {
        if ((r.shape === "thin") !== c.thin) s *= 0.4;
      }
      // SAM 3이 그 개념을 찾았는데 이 조각이 거기 없으면 그 이름이 아니다
      // (실측: 앞코의 0.2% 검정 조각이 "Laces"로 — 진짜 끈은 SAM3 shoelace 안에 있었다)
      // 0.6: 위치·면적·색이 전부 맞는 조각은 통과시키되(SAM 3이 미드솔을 sole로 안
      // 잡는 일이 있다), 조금이라도 어긋난 조각은 걸러낸다.
      const concept = partConcept.get(partId);
      if (concept) s *= myConcepts?.has(concept) ? 1 : 0.6;
      if (s > (opts.minScore ?? 0.55)) pairs.push({ i: c.index, partId, score: s });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedComp = new Set<number>(), usedPart = new Set<string>();
  const out: { index: number; partId: string }[] = [];
  for (const p of pairs) {
    if (usedComp.has(p.i) || usedPart.has(p.partId)) continue;
    usedComp.add(p.i); usedPart.add(p.partId);
    out.push({ index: p.i, partId: p.partId });
  }
  // 2차: 아주 확실한(만점) 쌍은 이미 쓰인 파트라도 같은 이름을 준다 —
  // 미드솔이 에어유닛에 잘려 두 조각일 때 "Midsole" + "Midsole 2"가 된다.
  // 호출 측이 같은 partId의 두 번째 조각에 접미어를 붙인다.
  for (const p of pairs) {
    if (usedComp.has(p.i) || p.score < 0.999) continue;
    usedComp.add(p.i);
    out.push({ index: p.i, partId: p.partId });
  }
  return out;
}
