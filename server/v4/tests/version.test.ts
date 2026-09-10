/**
 * 판 스탬프는 한 곳에서만 나온다.
 *
 * v7.9.1 에서 정리 단계 동작을 고쳤는데 run4.ts 의 판만 올리고 cleanFinish.ts·stageManifest.ts
 * 가 들고 있던 문자열은 그대로 뒀다 — 한 번의 실행이 낸 산출물 안에서 run 은 v7.9.1, cleanup 은
 * v7.9 로 찍혔다. 판을 박아두는 목적이 "같은 사진인데 결과가 다르다"를 짚는 것인데, 스탬프끼리
 * 어긋나면 무엇을 짚어야 할지 알 수 없다. 손으로 관리하는 사본은 반드시 어긋난다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_VERSION } from "../version.js";

// server/ 전체를 본다 — 판을 새로 박는 자리가 v4 밖에 생겨도 걸리게.
const serverDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test("판 문자열을 손으로 박아둔 곳이 version.ts 말고는 없다", async () => {
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "tests" && e.name !== "tools" && e.name !== "node_modules") await walk(p); continue; }
      if (!e.name.endsWith(".ts") || e.name === "version.ts") continue;
      const src = await fs.readFile(p, "utf8");
      src.split("\n").forEach((line, i) => {
        // "v7.9" / 'v8.0-something' 처럼 판으로 읽히는 리터럴
        if (/["'`]v\d+\.\d+(\.\d+)?\b/.test(line)) offenders.push(`${path.relative(serverDir, p)}:${i + 1}  ${line.trim()}`);
      });
    }
  };
  await walk(serverDir);
  assert.deepEqual(offenders, [],
    `판 문자열은 version.ts 의 CODE_VERSION 만 쓴다. 손으로 박은 곳:\n${offenders.join("\n")}`);
});

test("CODE_VERSION 은 vMAJOR.MINOR[.PATCH] 꼴이다", () => {
  assert.match(CODE_VERSION, /^v\d+\.\d+(\.\d+)?$/);
});
