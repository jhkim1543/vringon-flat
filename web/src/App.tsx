import React, { useEffect, useRef, useState } from "react";

type Stage = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  detail?: string;
};
type Candidate = {
  id: string;
  model: string;
  kind: "lineart" | "colorflat";
  imageUrl: string;
  score?: { total: number; silhouetteIoU: number; edgeQuality: number; bilevelPurity: number };
};
type JobView = {
  id: string;
  status: "running" | "done" | "error";
  error?: string;
  stages: Stage[];
  inputUrl: string;
  plan?: { category: string; view: string; parts: { id: string; name: string; parent: string }[] };
  candidates?: Candidate[];
  winner?: { lineart?: string; colorflat?: string };
  outputs?: { ai?: string; jsx?: string; svg?: string; layerPngs?: string[] };
  engines: { segment: string; vectorize: string };
};
type Health = {
  engines: Record<string, string>;
  keys: Record<string, boolean>;
};

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [style, setStyle] = useState("color");
  const [detail, setDetail] = useState("standard");
  const [category, setCategory] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    fetch("/v1/health").then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);

  const pickFile = (f: File | null) => {
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setJob(null);
    const form = new FormData();
    form.append("image", file);
    form.append("style", style);
    form.append("layerDetail", detail);
    if (category) form.append("categoryHint", category);
    const res = await fetch("/v1/jobs", { method: "POST", body: form });
    const json = await res.json();
    if (!res.ok) {
      alert(json.error || "요청 실패");
      setBusy(false);
      return;
    }
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const j: JobView = await (await fetch(`/api/jobs/${json.id}`)).json();
      setJob(j);
      if (j.status !== "running") {
        clearInterval(pollRef.current);
        setBusy(false);
      }
    }, 1500);
  };

  const winnerOf = (kind: "lineart" | "colorflat") =>
    job?.candidates?.find((c) => c.id === job.winner?.[kind]);

  const groupedParts = () => {
    const map = new Map<string, string[]>();
    job?.plan?.parts.forEach((p) => {
      map.set(p.parent, [...(map.get(p.parent) ?? []), p.name]);
    });
    return [...map.entries()];
  };

  return (
    <div className="wrap">
      <header>
        <h1>
          VRINGON <span>FLAT</span>
        </h1>
        <p>이미지 → 플랫 스케치 → 레이어 분리 → 편집 가능한 .ai</p>
        {health && (
          <div className="engines">
            {Object.entries(health.engines).map(([k, v]) => (
              <span key={k} className="chip">
                {k}: <b>{v}</b>
              </span>
            ))}
          </div>
        )}
      </header>

      <section className="panel">
        <div className="uploader">
          <label className="drop">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {preview ? <img src={preview} alt="input" /> : <span>제품 이미지 업로드 (사진/렌더/스케치)</span>}
          </label>
          <div className="controls">
            <fieldset>
              <legend>Style</legend>
              {[
                ["bw", "B/W Technical"],
                ["color", "Color Flat"],
                ["design", "Design Flat"],
              ].map(([v, label]) => (
                <label key={v}>
                  <input type="radio" checked={style === v} onChange={() => setStyle(v)} /> {label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Layer Detail</legend>
              {[
                ["simple", "Simple"],
                ["standard", "Standard"],
                ["detailed", "Detailed"],
              ].map(([v, label]) => (
                <label key={v}>
                  <input type="radio" checked={detail === v} onChange={() => setDetail(v)} /> {label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Category</legend>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">자동 감지</option>
                <option value="footwear">신발</option>
                <option value="jewelry">주얼리</option>
                <option value="bag">가방</option>
              </select>
            </fieldset>
            <button disabled={!file || busy} onClick={start}>
              {busy ? "변환 중…" : "Convert to Editable AI"}
            </button>
          </div>
        </div>
      </section>

      {job && (
        <>
          <section className="panel">
            <h2>파이프라인</h2>
            <ol className="stages">
              {job.stages.map((s) => (
                <li key={s.id} className={s.status}>
                  <i />
                  <div>
                    <b>{s.label}</b>
                    {s.detail && <small>{s.detail}</small>}
                  </div>
                </li>
              ))}
            </ol>
            {job.status === "error" && <p className="error">{job.error}</p>}
          </section>

          {job.plan && (
            <section className="panel">
              <h2>
                Layer Plan <small>({job.plan.category} · {job.plan.view})</small>
              </h2>
              <div className="tree">
                {groupedParts().map(([parent, names]) => (
                  <div key={parent} className="tree-group">
                    <b>{parent}</b>
                    <ul>
                      {names.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          {job.candidates && job.candidates.length > 0 && (
            <section className="panel">
              <h2>Candidates &amp; 자동 평가</h2>
              <div className="grid">
                {job.candidates.map((c) => {
                  const isWinner = c.id === job.winner?.lineart || c.id === job.winner?.colorflat;
                  return (
                    <figure key={c.id} className={isWinner ? "winner" : ""}>
                      <img src={c.imageUrl} alt={c.id} loading="lazy" />
                      <figcaption>
                        <b>
                          {c.model} · {c.kind}
                        </b>
                        {c.score && (
                          <small>
                            total {c.score.total} · IoU {c.score.silhouetteIoU}
                          </small>
                        )}
                        {isWinner && <em>WINNER</em>}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          )}

          {job.status === "done" && job.outputs && (
            <section className="panel result">
              <h2>산출물</h2>
              <div className="downloads">
                <a
                  className="dl primary"
                  href={`/viewer?job=${job.id.slice(0, 8)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  벡터 뷰어 열기 <small>레이어 토글 · 외곽선 · 앵커 검사</small>
                </a>
                <a className="dl" href={job.outputs.ai} download>
                  .ai 다운로드 <small>PDF-OCG 레이어 — Illustrator에서 열면 레이어 유지</small>
                </a>
                <a className="dl" href={job.outputs.jsx} download>
                  .jsx 다운로드 <small>Illustrator에서 실행 → 네이티브 .ai 재생성</small>
                </a>
                <a className="dl" href={job.outputs.svg} download>
                  .svg 다운로드 <small>레이어 그룹 유지</small>
                </a>
              </div>
              <div className="compare">
                {winnerOf("lineart") && (
                  <figure>
                    <img src={winnerOf("lineart")!.imageUrl} alt="line art" />
                    <figcaption>B/W Line Art (내부 canonical)</figcaption>
                  </figure>
                )}
                {winnerOf("colorflat") && (
                  <figure>
                    <img src={winnerOf("colorflat")!.imageUrl} alt="color flat" />
                    <figcaption>Color Flat (내부 canonical)</figcaption>
                  </figure>
                )}
                <figure>
                  <object data={job.outputs.svg} type="image/svg+xml" aria-label="vector preview" />
                  <figcaption>벡터 결과 미리보기 (SVG)</figcaption>
                </figure>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
