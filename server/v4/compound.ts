/**
 * 컴파운드 패스 쪼개기 — **구멍은 자기 바깥과 함께 남긴다.**
 *
 * 그물·니트 도면의 윤곽은 셀 하나마다 서브패스가 생겨 한 `<path>` 에 수백 개가 들어간다
 * (실측: bag_3 773개 · shoe_3 334개). Illustrator 에서 그 패스는 통째로만 선택되므로
 * 셀 하나를 못 고친다.
 *
 * 그냥 잘라서는 안 된다. even-odd 채움에서 **구멍은 자기 바깥 윤곽과 같은 패스에 있어야**
 * 구멍으로 남는다 — 떼어 놓으면 까맣게 메워진다. 그래서 bbox 포함 관계로 "바깥 + 그 안의
 * 구멍"을 한 덩이(unit)로 묶고, 덩이 단위로만 쪼갠다.
 */

const NUM = new RegExp("-?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?", "g");

interface Sub {
  d: string;
  x0: number; y0: number; x1: number; y1: number;
  area: number;
}

function parseSubs(d: string): Sub[] {
  const parts = d.split(/(?=[Mm])/).filter((p) => p.trim());
  const out: Sub[] = [];
  for (const p of parts) {
    const n = (p.match(NUM) ?? []).map(Number);
    if (n.length < 4) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < n.length; i += 2) {
      if (n[i] < x0) x0 = n[i];
      if (n[i] > x1) x1 = n[i];
      if (n[i + 1] < y0) y0 = n[i + 1];
      if (n[i + 1] > y1) y1 = n[i + 1];
    }
    out.push({ d: p, x0, y0, x1, y1, area: Math.max(1, (x1 - x0) * (y1 - y0)) });
  }
  return out;
}

const contains = (a: Sub, b: Sub) =>
  a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1 && a.area > b.area;

/**
 * `d` 를 서브패스 `maxSub` 개 이하의 조각들로 나눈다. 나눌 필요가 없으면 원본 하나를 준다.
 */
export function splitCompound(d: string, maxSub = 160): string[] {
  const subs = parseSubs(d);
  if (subs.length <= maxSub) return [d];

  // 바깥 → 구멍. 각 서브패스를 자기를 감싸는 **가장 작은** 서브패스에 붙인다.
  const order = subs.map((_, i) => i).sort((a, b) => subs[b].area - subs[a].area);
  const parent = new Int32Array(subs.length).fill(-1);
  for (const i of order) {
    let best = -1, bestArea = Infinity;
    for (const j of order) {
      if (j === i) continue;
      if (!contains(subs[j], subs[i])) continue;
      if (subs[j].area < bestArea) { bestArea = subs[j].area; best = j; }
    }
    parent[i] = best;
  }

  // 뿌리(바깥)마다 덩이를 만든다. 중첩이 더 깊어도 최상위 뿌리로 모은다 —
  // 한 덩이 안에 있기만 하면 even-odd 가 알아서 처리한다.
  const rootOf = (i: number): number => {
    let cur = i, guard = 0;
    while (parent[cur] >= 0 && guard++ < 64) cur = parent[cur];
    return cur;
  };
  const units = new Map<number, number[]>();
  for (let i = 0; i < subs.length; i++) {
    const r = rootOf(i);
    (units.get(r) ?? units.set(r, []).get(r)!).push(i);
  }

  const chunks: string[] = [];
  let cur: string[] = [];
  let curN = 0;
  for (const [, members] of units) {
    // 덩이 하나가 상한보다 크면 어쩔 수 없이 그대로 둔다 — 쪼개면 구멍이 메워진다
    if (curN && curN + members.length > maxSub) {
      chunks.push(cur.join(""));
      cur = []; curN = 0;
    }
    for (const i of members) cur.push(subs[i].d);
    curN += members.length;
  }
  if (cur.length) chunks.push(cur.join(""));
  return chunks.length ? chunks : [d];
}
