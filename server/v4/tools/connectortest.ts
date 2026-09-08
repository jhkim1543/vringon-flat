/**
 * `requiredConnectors` 자기 검사 — `npx tsx server/v4/tools/connectortest.ts`
 *
 * 리포트 v0.6 이 지적한 실패 형태(다단 연결선의 중간 조각)를 포함해, 지켜야 할 것과
 * 지키지 말아야 할 것을 손으로 만든 그래프로 확인한다.
 */
import { requiredConnectors, type ConnectorEdge } from "../../vector/connectors.js";

let pass = 0, fail = 0;
function check(name: string, got: number[], want: number[]): void {
  const g = [...got].sort((a, b) => a - b).join(",");
  const w = [...want].sort((a, b) => a - b).join(",");
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  [${g}]\n       want [${w}]`); }
}
const run = (edges: ConnectorEdge[], anchors: number[]) =>
  [...requiredConnectors(edges, new Set(anchors)).required];

// 1) 다단 연결 — A(1) …s1… 2 …s2… 3 …s3… B(4). 셋 다 지켜야 한다.
//    지금 코드는 s1·s3 만 지키고 s2 를 질감으로 버린다 — 이것이 리포트의 지적.
check("다단 연결선 셋", run(
  [{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }, { id: 2, u: 3, v: 4 }], [1, 4]), [0, 1, 2]);

// 2) 접점 하나에서 뻗다 끊긴 곁가지 — 사이 경로가 아니므로 요구하지 않는다
//    (기존 "긴 끝점에 닿으면 보존" 규칙이 따로 지키므로 실제로 지워지지 않는다)
check("막다른 곁가지", run(
  [{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }], [1]), []);

// 3) 경로 + 곁가지 — 경로만 요구
check("경로 + 곁가지", run(
  [{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }, { id: 2, u: 2, v: 9 }], [1, 3]), [0, 1]);

// 4) 두 갈래 고리 — 어느 쪽도 임의로 고르지 않고 블록을 통째로 남긴다
check("대체 경로 고리", run(
  [{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }, { id: 2, u: 2, v: 4 }, { id: 3, u: 3, v: 5 },
   { id: 4, u: 4, v: 5 }, { id: 5, u: 5, v: 6 }], [1, 6]), [0, 1, 2, 3, 4, 5]);

// 5) 접점이 하나뿐 — 사이 경로가 없다
check("접점 하나", run([{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }], [2]), []);

// 6) 자기고리는 경로가 될 수 없다
check("자기고리", run([{ id: 0, u: 1, v: 1 }, { id: 1, u: 1, v: 2 }], [1, 2]), [1]);

// 7) 서로 떨어진 두 덩어리 — 각자 접점 둘씩이면 각자 지켜진다
check("분리된 두 덩어리", run(
  [{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }, { id: 2, u: 10, v: 11 }, { id: 3, u: 11, v: 12 }],
  [1, 3, 10, 12]), [0, 1, 2, 3]);

// 8) 접점을 잇지 않는 질감 뭉치 — 요구하지 않는다
check("질감 뭉치", run(
  [{ id: 0, u: 20, v: 21 }, { id: 1, u: 21, v: 22 }, { id: 2, u: 22, v: 20 }], [1, 4]), []);

// 9) 접점이 경로 한가운데 있어도 그 너머까지 요구하지는 않는다
check("가운데 접점", run(
  [{ id: 0, u: 1, v: 2 }, { id: 1, u: 2, v: 3 }, { id: 2, u: 3, v: 4 }], [1, 3]), [0, 1]);

// 10) 긴 사슬 — 스택 재귀였다면 넘쳤을 크기
{
  const edges: ConnectorEdge[] = [];
  for (let i = 0; i < 20000; i++) edges.push({ id: i, u: i, v: i + 1 });
  const got = requiredConnectors(edges, new Set([0, 20000])).required;
  check("2만 간선 사슬", [got.size], [20000]);
}

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
