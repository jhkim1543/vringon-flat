import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { mountApi } from "./api.js";

const app = express();
app.use(
  cors(
    config.corsOrigins.length
      ? { origin: config.corsOrigins, allowedHeaders: ["Content-Type", "X-API-Key", "Authorization"] }
      : { origin: true, allowedHeaders: ["Content-Type", "X-API-Key", "Authorization"] },
  ),
);
// 사설 네트워크 접근(PNA) — https 페이지(GitHub Pages 데모)가 로컬 서버를 부를 때
// 브라우저가 프리플라이트로 이 헤더를 요구한다. 없으면 데모에서 호출이 막힌다.
app.use((req, res, next) => {
  if (req.header("access-control-request-private-network")) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});
app.use(express.json());
app.use("/outputs", express.static(config.outputsDir));

// 공개 REST API (v1) + 웹 UI 하위호환 경로
mountApi(app);

// OpenAPI 명세 — 클라이언트 생성기·Swagger UI가 바로 먹는다
app.get("/v1/openapi.yaml", (_req, res) => {
  res.type("text/yaml").sendFile(path.join(config.root, "docs", "openapi.yaml"));
});

// 데모/문서 정적 페이지 — 자체 호스팅해도 GitHub Pages와 같은 화면이 뜬다
app.use("/demo", express.static(path.join(config.root, "docs")));

// 개발용 벡터 뷰어
app.get("/viewer", (_req, res) => {
  res.sendFile(path.join(config.root, "web", "viewer.html"));
});

/** 디스크에 남아 있는 완료된 잡 목록 (서버 재시작 후에도 뷰어에서 열 수 있게) */
app.get("/api/jobs", async (_req, res) => {
  try {
    const dirs = await fs.readdir(config.outputsDir, { withFileTypes: true });
    const out: { id: string; ir: string; svg: string; mtime: number }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const dir = path.join(config.outputsDir, d.name);
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      const ir = files.find((f) => f.endsWith(".ir.json"));
      if (!ir) continue;
      const st = await fs.stat(path.join(dir, ir));
      out.push({
        id: d.name,
        ir: `/outputs/${d.name}/${ir}`,
        svg: `/outputs/${d.name}/${ir.replace(".ir.json", ".svg")}`,
        mtime: st.mtimeMs,
      });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/", (_req, res) => res.redirect("/demo/"));

app.listen(config.apiPort, () => {
  console.log(`[vringon-flat] v${config.version} API on http://localhost:${config.apiPort}`);
  console.log(`  데모/문서  http://localhost:${config.apiPort}/demo/`);
  console.log(`  OpenAPI    http://localhost:${config.apiPort}/v1/openapi.yaml`);
  console.log(
    `  keys: openai=${!!config.openaiKey} gemini=${!!config.geminiKey} fal=${config.hasSam3} vectorizer=${config.hasVectorizerAI}`,
  );
  console.log(
    `  인증=${config.apiKeys.length ? `API_KEYS ${config.apiKeys.length}개` : "없음(공개)"} · 동시잡 ${config.maxConcurrentJobs}`,
  );
});
