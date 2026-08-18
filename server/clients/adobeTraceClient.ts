
import { config } from "../config.js";

/**
 * Adobe Firefly Services — Illustrator Image Trace API 클라이언트.
 *
 * ADOBE_CLIENT_ID / ADOBE_CLIENT_SECRET 를 .env에 넣으면 동작한다.
 * 벤치마크용 어댑터이며, 파이프라인 기본 경로는 여전히 로컬 VTracer +
 * 자체 중심선 추출이다.
 *
 * 흐름:
 *   1) IMS에서 client_credentials 토큰 발급
 *   2) 입력 이미지를 Firefly 스토리지에 업로드 → 참조 획득
 *   3) Image Trace 잡 제출 → 상태 폴링 → 결과 SVG 다운로드
 *
 * NOTE: Firefly Services는 엔터프라이즈 계약 대상이고 엔드포인트/스키마가
 * 자주 바뀐다. 첫 호출에서 4xx가 나면 응답 본문의 안내에 맞춰 이 파일만
 * 수정하면 된다 — 호출부는 vectorizeSvg() 하나뿐이다.
 */

// OpenAPI 스펙으로 확정 (AdobeDocs/ffs-illustrator-api · static/illustrator-api.json)
const IMS_TOKEN = "https://ims-na1.adobelogin.com/ims/token/v3";
const TRACE = "https://illustrator-api.adobe.io/v1/trace-image";
/** 상태 경로는 작업 종류별로 다르다 — Image Trace는 접미사가 붙는다 */
const STATUS = "https://illustrator-api.adobe.io/v1/status";

/**
 * `input.source.url`은 **허용 도메인만** 받는다(스펙 명시).
 * 자체 호스팅 URL은 거부되므로 벤치마크하려면 아래 중 하나에 올려야 한다.
 */
export const ALLOWED_SOURCE_HOSTS = [
  "amazonaws.com",
  "windows.net",
  "dropboxusercontent.com",
  "assets.frame.io",
  "storage.googleapis.com",
];

const SCOPES = "openid,AdobeID,firefly_api,ff_apis";

async function getToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.adobeClientId,
    client_secret: config.adobeClientSecret,
    scope: SCOPES,
  });
  const r = await fetch(IMS_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Adobe IMS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).access_token as string;
}

export type TracePreset = "enhanced_general" | "high_fidelity_photo";

/**
 * Image Trace로 벡터화해 SVG 문자열을 돌려준다.
 *
 * 입력은 **어도비 쪽에서 접근 가능한 공개 URL**이어야 한다(`input.source.url`).
 * 로컬 파일 업로드 방식이 아니므로, 벤치마크할 때는 이 프로젝트 서버의
 * `/outputs` 정적 경로를 외부에 노출하고 그 URL을 넘긴다.
 * localhost는 어도비가 접근할 수 없다.
 */
export async function vectorizeSvgFromUrl(
  sourceUrl: string,
  preset: TracePreset = "enhanced_general",
): Promise<string> {
  if (!config.hasAdobe) throw new Error("ADOBE_CLIENT_ID/SECRET 없음");
  // 허용 도메인 밖이면 어도비가 거부하므로 호출 전에 잡아 준다
  if (!ALLOWED_SOURCE_HOSTS.some((h) => new URL(sourceUrl).hostname.endsWith(h))) {
    throw new Error(
      `Adobe Image Trace는 허용 도메인의 URL만 받는다 (${ALLOWED_SOURCE_HOSTS.join(", ")}). ` +
        `받은 값: ${new URL(sourceUrl).hostname}`,
    );
  }
  const token = await getToken();

  const submit = await fetch(TRACE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": config.adobeClientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: { source: { url: sourceUrl }, mediaType: "image/png" },
      settings: { preset },
    }),
  });
  if (!submit.ok)
    throw new Error(`Adobe trace ${submit.status}: ${(await submit.text()).slice(0, 400)}`);
  const job: any = await submit.json();

  const jobId: string | undefined = job.jobId ?? job.id;
  if (!jobId) throw new Error(`Adobe trace: jobId 없음 — ${JSON.stringify(job).slice(0, 200)}`);

  // 상태 URL은 응답이 주면 그걸 쓰고, 없으면 스펙상 경로를 조립한다.
  // Image Trace는 `/v1/status/{jobId}/image-trace` — 접미사를 빠뜨리면 404.
  const statusUrl: string = job.statusUrl ?? `${STATUS}/${jobId}/image-trace`;

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${token}`, "x-api-key": config.adobeClientId },
    });
    if (!s.ok) continue;
    const sj: any = await s.json();
    const st = String(sj.status ?? "").toLowerCase();
    if (st === "succeeded" || st === "done") {
      const url = sj.outputs?.[0]?.destination?.url ?? sj.outputs?.[0]?.url;
      if (!url) throw new Error("Adobe trace: 완료됐으나 산출물 URL 없음");
      return await (await fetch(url)).text(); // presigned URL
    }
    if (st === "failed")
      throw new Error(`Adobe trace 실패: ${JSON.stringify(sj).slice(0, 300)}`);
  }
  throw new Error("Adobe trace: 시간 초과");
}

/** 로컬 outputs/ 경로를 공개 URL로 바꿔 호출하는 편의 래퍼 */
export async function vectorizeSvg(
  pngPath: string,
  preset: TracePreset = "enhanced_general",
): Promise<string> {
  const base = config.publicBaseUrl;
  if (!base)
    throw new Error(
      "Adobe Image Trace는 공개 URL 입력만 받는다. PUBLIC_BASE_URL을 설정할 것 (localhost 불가)",
    );
  const rel = pngPath.split(/[\\/]outputs[\\/]/)[1]?.replace(/\\/g, "/");
  if (!rel) throw new Error("Adobe trace: outputs/ 아래 파일만 지원");
  return vectorizeSvgFromUrl(`${base.replace(/\/$/, "")}/outputs/${rel}`, preset);
}
