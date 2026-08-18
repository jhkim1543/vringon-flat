/**
 * SVG path data 파서/직렬화.
 * 내부 표현은 절대좌표 M/L/C/Z만 사용하는 서브패스 목록.
 * (potrace·Vectorizer.AI 출력의 상대좌표, Q/S/T/H/V/A를 모두 정규화)
 */

export type Pt = [number, number];
export interface Seg {
  // L: c1=c2=end 로 두고 cubic으로 통일하지 않고, 타입 보존
  type: "L" | "C";
  c1?: Pt;
  c2?: Pt;
  end: Pt;
}
export interface SubPath {
  start: Pt;
  segs: Seg[];
  closed: boolean;
}

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

export function parsePath(d: string): SubPath[] {
  const tokens: (string | number)[] = [];
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(d))) tokens.push(m[1] ?? Number(m[2]));

  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let x = 0, y = 0;
  let startX = 0, startY = 0;
  let prevC2: Pt | null = null;
  let prevQ: Pt | null = null;
  let i = 0;
  let cmd = "";

  const num = () => tokens[i++] as number;

  while (i < tokens.length) {
    if (typeof tokens[i] === "string") cmd = tokens[i++] as string;
    const rel = cmd === cmd.toLowerCase() && cmd !== "z" && cmd !== "Z";
    const C = cmd.toUpperCase();

    switch (C) {
      case "M": {
        let nx = num(), ny = num();
        if (rel) { nx += x; ny += y; }
        x = nx; y = ny; startX = x; startY = y;
        cur = { start: [x, y], segs: [], closed: false };
        subs.push(cur);
        cmd = rel ? "l" : "L"; // 후속 좌표쌍은 lineto
        prevC2 = prevQ = null;
        break;
      }
      case "L": case "H": case "V": {
        let nx = x, ny = y;
        if (C === "L") { nx = num(); ny = num(); if (rel) { nx += x; ny += y; } }
        else if (C === "H") { nx = num(); if (rel) nx += x; }
        else { ny = num(); if (rel) ny += y; }
        x = nx; y = ny;
        cur?.segs.push({ type: "L", end: [x, y] });
        prevC2 = prevQ = null;
        break;
      }
      case "C": {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
        if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
        cur?.segs.push({ type: "C", c1: [x1, y1], c2: [x2, y2], end: [nx, ny] });
        prevC2 = [x2, y2]; prevQ = null;
        x = nx; y = ny;
        break;
      }
      case "S": {
        let x2 = num(), y2 = num(), nx = num(), ny = num();
        if (rel) { x2 += x; y2 += y; nx += x; ny += y; }
        const c1: Pt = prevC2 ? [2 * x - prevC2[0], 2 * y - prevC2[1]] : [x, y];
        cur?.segs.push({ type: "C", c1, c2: [x2, y2], end: [nx, ny] });
        prevC2 = [x2, y2]; prevQ = null;
        x = nx; y = ny;
        break;
      }
      case "Q": case "T": {
        let qx: number, qy: number, nx: number, ny: number;
        if (C === "Q") {
          qx = num(); qy = num(); nx = num(); ny = num();
          if (rel) { qx += x; qy += y; nx += x; ny += y; }
        } else {
          nx = num(); ny = num();
          if (rel) { nx += x; ny += y; }
          qx = prevQ ? 2 * x - prevQ[0] : x;
          qy = prevQ ? 2 * y - prevQ[1] : y;
        }
        // quadratic → cubic 승격
        const c1: Pt = [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y)];
        const c2: Pt = [nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny)];
        cur?.segs.push({ type: "C", c1, c2, end: [nx, ny] });
        prevQ = [qx, qy]; prevC2 = null;
        x = nx; y = ny;
        break;
      }
      case "A": {
        // 호는 직선으로 근사(레이어 PNG 벡터화 결과에는 사실상 등장하지 않음)
        num(); num(); num(); num(); num();
        let nx = num(), ny = num();
        if (rel) { nx += x; ny += y; }
        cur?.segs.push({ type: "L", end: [nx, ny] });
        x = nx; y = ny;
        prevC2 = prevQ = null;
        break;
      }
      case "Z": {
        if (cur) cur.closed = true;
        x = startX; y = startY;
        prevC2 = prevQ = null;
        break;
      }
    }
  }
  return subs;
}

const fmt = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

export function serializePath(subs: SubPath[]): string {
  const parts: string[] = [];
  for (const sp of subs) {
    parts.push(`M${fmt(sp.start[0])} ${fmt(sp.start[1])}`);
    for (const s of sp.segs) {
      if (s.type === "L") parts.push(`L${fmt(s.end[0])} ${fmt(s.end[1])}`);
      else
        parts.push(
          `C${fmt(s.c1![0])} ${fmt(s.c1![1])} ${fmt(s.c2![0])} ${fmt(s.c2![1])} ${fmt(s.end[0])} ${fmt(s.end[1])}`,
        );
    }
    if (sp.closed) parts.push("Z");
  }
  return parts.join("");
}

/** 서브패스의 부호 있는 면적 (베지어는 폴리곤 근사) */
export function subPathArea(sp: SubPath): number {
  const pts: Pt[] = [sp.start];
  for (const s of sp.segs) {
    if (s.type === "C") {
      // 곡선을 4점 샘플링
      const p0 = pts[pts.length - 1];
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const mt = 1 - t;
        pts.push([
          mt ** 3 * p0[0] + 3 * mt * mt * t * s.c1![0] + 3 * mt * t * t * s.c2![0] + t ** 3 * s.end[0],
          mt ** 3 * p0[1] + 3 * mt * mt * t * s.c1![1] + 3 * mt * t * t * s.c2![1] + t ** 3 * s.end[1],
        ]);
      }
    } else pts.push(s.end);
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
