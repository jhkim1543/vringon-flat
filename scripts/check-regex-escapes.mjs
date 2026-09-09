/**
 * **문자열이 삼킨 정규식 이스케이프를 찾는다.**
 *
 * `new RegExp("-?\d*\.?\d+")` 은 문법 오류가 아니다. JS 문자열 리터럴이 `\d` 를 `d` 로
 * 삼켜 `/-?d*.?d+/` 가 되고, 예외 없이 **매치가 0건**이 되어 결과가 기본값으로 조용히
 * 떨어진다. 실측(vringon-flat): `bboxOfPath` 가 모든 bbox 를 캔버스 전체로 냈고, 그 탓에
 * 연속성 구제가 통째로 꺼지고 라인 모드 골격 점수가 0 이 됐다 — 며칠 뒤에야 드러났다.
 *
 * 정규식은 리터럴 `/…/` 로 쓰는 것이 원칙이고, 문자열이 불가피하면 `\\d` 로 두 번 쓴다.
 *
 *   node scripts/check-regex-escapes.mjs
 *
 * 하나라도 찾으면 종료 코드 1 — CI 에 걸어 두면 재발을 막는다.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["server", "scripts", "src"];
const bad = [];

const walk = (d) => {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") walk(p); continue; }
    if (!/\.(ts|tsx|mts|mjs|js|jsx)$/.test(e.name)) continue;
    // 주석은 뺀다 — 이 함정을 설명하는 주석 자체가 걸리면 검사가 늑대 소년이 된다.
    // 줄 수는 보존해야 하므로 주석 자리를 같은 길이의 공백으로 바꾼다.
    const blank = (s) => s.replace(/[^\n]/g, " ");
    const src = fs.readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
    const re = /new RegExp\(\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(src))) {
      const lit = m[1];
      // 리터럴 단계에서 살아남지 못하는 클래스 이스케이프 — 홀수 개 백슬래시 뒤에 붙은 것
      if (!/(^|[^\\])(\\\\)*\\[dwsbWSDB]/.test(lit)) continue;
      let actual;
      try { actual = JSON.parse('"' + lit + '"'); } catch { actual = "(파싱 불가)"; }
      const line = src.slice(0, m.index).split("\n").length;
      bad.push(`${p}:${line}\n    적은 것  new RegExp("${lit}")\n    실제로는 /${actual}/`);
    }
  }
};

for (const r of ROOTS) walk(r);

if (bad.length) {
  console.log(`\n삼켜진 정규식 이스케이프 ${bad.length}건\n`);
  console.log(bad.join("\n\n"));
  console.log("\n정규식 리터럴 /…/ 로 바꾸거나 백슬래시를 두 번 쓴다.\n");
  process.exit(1);
}
console.log("삼켜진 정규식 이스케이프 없음");
