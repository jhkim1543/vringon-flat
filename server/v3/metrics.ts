/**
 * 충실도 지표 — **사용자가 보는 도면**을 기준으로 잰다.
 *
 * 기존 QA는 기준을 `whole.aligned.png`(파이프라인이 스스로 축소·왜곡한 입력)로 잡았다.
 * 그래서 "자기가 망가뜨린 입력을 얼마나 잘 따라 그렸나"만 재고, 사용자가 화면에서 보는
 * 원본 도면이 얼마나 보존됐는지는 재지 않았다. 실측 격차:
 *
 *   9종 평균 — 보고 F 0.872 · aligned 대비 F@2px 0.917 · **raw 대비 F@2px 0.620**
 *   bag_1    — 보고 F 0.939 · aligned 대비 0.952 · **raw 대비 0.465**
 *
 * 여기서는 기준을 raw 도면으로 고정하고, 허용오차를 0·1·2px로 나눠 본다. 2px 하나만
 * 보면 선이 굵어지거나 1px 밀린 것이 가려진다.
 */
import sharp from "sharp";

export interface Mask {
  data: Uint8Array;
  width: number;
  height: number;
}

/** 어두운 픽셀 = 잉크. 도면은 흰/회 배경에 검은 선이므로 루미넌스로 충분하다. */
export async function inkMask(src: string | Buffer, W: number, H: number, threshold = 160): Promise<Mask> {
  const g = await sharp(src)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(W, H, { fit: "fill" })
    .raw()
    .toBuffer();
  const data = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) data[i] = g[i] < threshold ? 1 : 0;
  return { data, width: W, height: H };
}

/** SVG를 지정 크기로 래스터화해 잉크 마스크를 뽑는다 */
export async function svgInkMask(svg: string | Buffer, W: number, H: number, threshold = 160): Promise<Mask> {
  // density를 올려야 얇은 stroke가 사라지지 않는다 — 96dpi로 굽고 축소하면
  // 1px 선이 옅어져 임계 아래로 떨어진다.
  const png = await sharp(Buffer.from(svg as never), { density: 288 })
    .resize(W, H, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  return inkMask(png, W, H, threshold);
}

/** 체비셰프/유클리드 근사 거리변환 (2-pass chamfer 3-4) */
export function distanceTransform(m: Mask): Float32Array {
  const { data, width: W, height: H } = m;
  const d = new Float32Array(W * H).fill(1e9);
  for (let i = 0; i < W * H; i++) if (data[i]) d[i] = 0;
  const D1 = 1, D2 = 1.41421356;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (y > 0) v = Math.min(v, d[i - W] + D1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + D2);
      if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + D2);
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + D1);
      if (y < H - 1) v = Math.min(v, d[i + W] + D1);
      if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + D2);
      if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + D2);
      d[i] = v;
    }
  }
  return d;
}

export interface Fidelity {
  /** 허용오차별 양방향 F1 */
  f: Record<string, number>;
  precision2: number;
  recall2: number;
  /** 대칭 chamfer 거리 (px) */
  chamfer: number;
  /** 대칭 거리의 95 백분위 (px) — 국소적으로 크게 어긋난 곳을 잡는다 */
  p95: number;
  refInk: number;
  vecInk: number;
  /** 벡터 잉크 / 기준 잉크. 1보다 크면 선이 굵어진 것이다. */
  inkRatio: number;
}

/**
 * 기준(ref)과 대상(vec)의 양방향 tolerance F1.
 *   recall    = ref 픽셀 중 vec의 t px 안에 대응이 있는 비율
 *   precision = vec 픽셀 중 ref의 t px 안에 대응이 있는 비율
 */
export function fidelity(ref: Mask, vec: Mask, tolerances = [0, 1, 2]): Fidelity {
  const W = ref.width, H = ref.height, N = W * H;
  const dRef = distanceTransform(ref);
  const dVec = distanceTransform(vec);

  let refN = 0, vecN = 0;
  for (let i = 0; i < N; i++) { if (ref.data[i]) refN++; if (vec.data[i]) vecN++; }

  const f: Record<string, number> = {};
  let precision2 = 0, recall2 = 0;
  for (const t of tolerances) {
    let rHit = 0, vHit = 0;
    for (let i = 0; i < N; i++) {
      if (ref.data[i] && dVec[i] <= t) rHit++;
      if (vec.data[i] && dRef[i] <= t) vHit++;
    }
    const r = refN ? rHit / refN : 0;
    const p = vecN ? vHit / vecN : 0;
    f[`f${t}`] = p + r ? +((2 * p * r) / (p + r)).toFixed(4) : 0;
    if (t === 2) { precision2 = +p.toFixed(4); recall2 = +r.toFixed(4); }
  }

  // chamfer / p95 — 양방향 거리의 합집합 분포
  const dist: number[] = [];
  for (let i = 0; i < N; i++) {
    if (ref.data[i]) dist.push(dVec[i]);
    if (vec.data[i]) dist.push(dRef[i]);
  }
  dist.sort((a, b) => a - b);
  const chamfer = dist.length ? dist.reduce((a, b) => a + b, 0) / dist.length : 0;
  const p95 = dist.length ? dist[Math.min(dist.length - 1, Math.floor(dist.length * 0.95))] : 0;

  return {
    f,
    precision2,
    recall2,
    chamfer: +chamfer.toFixed(3),
    p95: +p95.toFixed(2),
    refInk: refN,
    vecInk: vecN,
    inkRatio: refN ? +(vecN / refN).toFixed(3) : 0,
  };
}

/** 4-이웃 연결성분 (마스크 없이 크기·bbox만) */
function componentSizes(m: Mask): { area: number; x0: number; y0: number; x1: number; y1: number }[] {
  const { data, width: W, height: H } = m;
  const N = W * H;
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  const out: { area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let s = 0; s < N; s++) {
    if (!data[s] || seen[s]) continue;
    let sp = 0, area = 0;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const c = stack[--sp];
      area++;
      const x = c % W, y = (c / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && data[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
      if (x < W - 1 && data[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
      if (y > 0 && data[c - W] && !seen[c - W]) { seen[c - W] = 1; stack[sp++] = c - W; }
      if (y < H - 1 && data[c + W] && !seen[c + W]) { seen[c + W] = 1; stack[sp++] = c + W; }
    }
    out.push({ area, x0, y0, x1, y1 });
  }
  return out;
}

export interface DetailRecall {
  /** 기준에서 센 작은 성분 개수 (해프톤 영역 제외) */
  total: number;
  /** 벡터가 실제로 그린 것 */
  kept: number;
  recall: number;
  /** 사라진 것들의 위치 (디버깅·시각화용, 최대 40개) */
  missing: { x: number; y: number; area: number }[];
}

/**
 * 작은 디테일 보존율 — 스티치·지퍼 이빨·로고 문자·짧은 접합선이 살아남았는가.
 *
 * 기존 파이프라인은 작은 연결성분을 전부 `speck`으로 지웠기 때문에 이 지표가 없으면
 * 그 손실이 전체 F1에 묻혀 보이지 않는다(작은 성분은 픽셀 수가 적어 F1을 거의 못 움직인다).
 */
export function detailRecall(ref: Mask, vec: Mask, maxArea: number, tol = 2, exclude?: Uint8Array): DetailRecall {
  const dVec = distanceTransform(vec);
  const comps = componentSizes(ref).filter((c) => c.area <= maxArea);
  const W = ref.width;
  const missing: { x: number; y: number; area: number }[] = [];
  let kept = 0;
  let skipped = 0;
  for (const c of comps) {
    // 해프톤으로 판정해 톤 면으로 바꾼 자리는 **의도적으로** 선을 안 그린 것이다.
    // 그것까지 소실로 세면 실제 디테일 손실이 묻힌다(실측: 28% 로 보이던 것이 실제로는 다른 값).
    if (exclude) {
      let inTex = 0, tot = 0;
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
        const i = y * ref.width + x;
        if (!ref.data[i]) continue;
        tot++;
        if (exclude[i]) inTex++;
      }
      if (tot && inTex / tot >= 0.5) { skipped++; continue; }
    }
    // 성분의 픽셀 중 절반 이상이 벡터 근처에 있으면 살아남은 것으로 본다
    let hit = 0, n = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const i = y * W + x;
        if (!ref.data[i]) continue;
        n++;
        if (dVec[i] <= tol) hit++;
      }
    }
    if (n && hit / n >= 0.5) kept++;
    else if (missing.length < 40) missing.push({ x: ((c.x0 + c.x1) / 2) | 0, y: ((c.y0 + c.y1) / 2) | 0, area: c.area });
  }
  const total = comps.length - skipped;
  return { total, kept, recall: total ? +(kept / total).toFixed(4) : 1, missing };
}

export interface TopologyDelta {
  refComponents: number;
  vecComponents: number;
  /** 큰 성분(전체 잉크의 0.5% 이상)만 센 것 — 잡티에 흔들리지 않는다 */
  refMajor: number;
  vecMajor: number;
}

export function topology(ref: Mask, vec: Mask): TopologyDelta {
  const rc = componentSizes(ref), vc = componentSizes(vec);
  const rInk = rc.reduce((a, c) => a + c.area, 0);
  const vInk = vc.reduce((a, c) => a + c.area, 0);
  return {
    refComponents: rc.length,
    vecComponents: vc.length,
    refMajor: rc.filter((c) => c.area >= rInk * 0.005).length,
    vecMajor: vc.filter((c) => c.area >= vInk * 0.005).length,
  };
}
