/**
 * 최종 산출물 묶기 — `.ai` 파일을 한 폴더에 모아 zip 으로 낸다.
 *
 * 파일명은 잡 이름 그대로 쓰되, 어떤 게이트를 통과했는지 함께 담은 목록(README)을
 * 넣는다. 받는 쪽이 "이 파일은 믿어도 되나"를 파일을 열기 전에 알 수 있어야 한다.
 *
 *   npx tsx server/v4/package-ai.ts <출력이름> [접두사...]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const outName = process.argv[2] ?? "vringon-flat-ai";
const prefixes = process.argv.slice(3);
const root = "outputs/v4";
const stage = path.join("outputs", `_pkg_${outName}`);

await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

const dirs = (await fs.readdir(root))
  .filter((d) => d.startsWith("v4_") && !d.startsWith("v4__"))
  .filter((d) => !prefixes.length || prefixes.some((p) => d.startsWith(`v4_${p}`)))
  .sort();

interface Row { name: string; gates: string; anchors: number; layers: number; bytes: number }
const rows: Row[] = [];
let missing = 0;

for (const d of dirs) {
  const name = d.replace(/^v4_/, "");
  const ai = path.join(root, d, "layered.ai");
  try {
    const st = await fs.stat(ai);
    const q = JSON.parse(await fs.readFile(path.join(root, d, "qa_v4.json"), "utf8"));
    const g = q.qa;
    const gates = (["fidelity", "editability", "semantic"] as const)
      .map((k) => (g[k]?.pass ? "O" : "X")).join("");
    // 판(모드)별로 폴더를 나눈다 — 받는 쪽이 어느 것을 쓸지 골라야 한다
    const mode = name.startsWith("s_") ? "stroke-라이브선"
      : name.endsWith("_line") ? "line-선만"
        : "face-면윤곽";
    const sub = path.join(stage, mode);
    await fs.mkdir(sub, { recursive: true });
    await fs.copyFile(ai, path.join(sub, `${name.replace(/^s_/, "")}.ai`));
    rows.push({
      name: `${mode}/${name.replace(/^s_/, "")}`, gates,
      anchors: g.editability?.anchors ?? 0,
      layers: q.counts?.layers ?? (q.plan?.parts?.length ?? 0),
      bytes: st.size,
    });
  } catch {
    missing++;
    console.log(`  ! ${name}: layered.ai 없음`);
  }
}

if (!rows.length) {
  console.log("\n담을 .ai 가 없다. 먼저 rebuild-exports 를 돌려라.");
  process.exit(1);
}

const kb = (b: number) => `${(b / 1024).toFixed(0)}KB`;
const pass = rows.filter((r) => !r.gates.includes("X")).length;
const lines = [
  "# VRINGON FLAT — 레이어 분리 .ai 묶음",
  "",
  `총 ${rows.length}개 · 3게이트 전부 통과 ${pass}개`,
  "",
  "게이트는 왼쪽부터 **충실도 / 편집성 / 의미**다. O 는 통과, X 는 검토 필요를 뜻한다.",
  "X 가 있어도 파일은 열리고 편집된다 — 자동 판정이 기준선에 못 미쳤다는 표시다.",
  "",
  "## 세 가지 판",
  "",
  "| 폴더 | 선의 표현 | 면 | 누구에게 |",
  "| --- | --- | --- | --- |",
  "| `stroke-라이브선` | **라이브 스트로크** (중심선 한 줄, 굵기 등급화) | 채울 수 있음 | 테크니컬 디자이너, 일러스트레이터, 자수 — 선 굵기를 일괄로 바꿔야 하는 쪽 |",
  "| `face-면윤곽` | 확장된 면 (선의 안·바깥 두 겹) | 채울 수 있음 | 사진의 선 굵기 변화를 그대로 보존해야 할 때 |",
  "| `line-선만` | 라이브 스트로크 | **없음** | 선만 필요한 경우 |",
  "",
  "**기본으로 권하는 것은 `stroke-라이브선`** 이다. 선 하나가 패스 하나이고, 앵커가",
  "중심선 위에 한 줄로 놓이며, 굵기가 숫자 몇 개로 통일되어 있다. `face-면윤곽` 은",
  "같은 그림을 선의 양쪽 윤곽으로 떠서 앵커가 두 배 가까이 되고 굵기를 못 바꾼다.",
  "",
  "| 파일 | 게이트 | 앵커 | 크기 |",
  "| --- | --- | ---: | ---: |",
  ...rows.map((r) => `| ${r.name}.ai | ${r.gates} | ${r.anchors.toLocaleString()} | ${kb(r.bytes)} |`),
  "",
  "## 여는 법",
  "",
  "Illustrator 에서 그대로 연다. 레이어 패널에 기능 레이어(FILLS · OUTLINES · PATTERNS ·",
  "STITCH · STRUCTURE)가 있고, 그 아래 부품별 하위 레이어가 붙어 있다.",
  "",
];
await fs.writeFile(path.join(stage, "README.md"), lines.join("\n"), "utf8");

const zip = path.resolve("outputs", `${outName}.zip`);
await fs.rm(zip, { force: true });
// PowerShell 압축 — 별도 도구 없이 Windows 에서 바로 된다
await run("powershell", [
  "-NoProfile", "-Command",
  `Compress-Archive -Path '${path.resolve(stage)}\\*' -DestinationPath '${zip}' -Force`,
]);

const zs = await fs.stat(zip);
console.log(`\n${zip}`);
console.log(`  .ai ${rows.length}개 · 3게이트 통과 ${pass}개 · 누락 ${missing}개 · ${(zs.size / 1024 / 1024).toFixed(1)}MB`);
