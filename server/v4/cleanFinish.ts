import { CODE_VERSION } from "./version.js";
import { cleanContours, type CleanReport } from "./cleanContours.js";
import { separateGlyphs, type GlyphReport } from "./glyphClearance.js";
import type { VectorScene } from "./types.js";
import { repairSceneJunctions, type SceneTopologyReport } from "./junctionRepair.js";
import { auditLineQuality } from "./lineQuality.js";

export interface CleanFinishReport { scale:number; widthChanges:number; topology:SceneTopologyReport; contours:CleanReport; glyphs:GlyphReport; postGlyphJoins:CleanReport["joined"]; finalAudit:ReturnType<typeof auditLineQuality> }

/** This is called by buildScene itself and by the offline sample reprocessor. */
export async function cleanFinish(scene:VectorScene,workDir:string,say?:(m:string)=>void):Promise<CleanFinishReport> {
  const baseline=structuredClone(scene);
  const scale=scene.canvas.width/scene.canvas.sourceWidth;
  if(!(scale>0)||Math.abs(scene.canvas.height/scene.canvas.sourceHeight-scale)>0.01*scale)
    throw new Error("cleanFinish requires a uniformly registered source coordinate system");
  let widthChanges=0;
  const n=Number(process.env.V4_CLEAN_OUTLINE_PX??1.4),cap=(Number.isFinite(n)&&n>0?n:1.4)*scale;
  for(const p of scene.primitives) {
    if(!(p.cls==="STRUCTURAL_STROKE"||(p.cls==="GEOMETRIC_PRIMITIVE"&&p.paint==="stroke")))continue;
    if(!(p.width>cap))continue;
    // **얇은 마감이 이미 정한 굵기는 상한하지 않는다.** `qaWidth` 가 있으면 `width` 는 실측
    // 잉크 폭이 아니라 **표시용 굵기 등급**이다(굵기 사다리 1.2 · 2 · 3.2 · 4.5px). 그걸 1.4 로
    // 누르면 외곽이 굵고 디테일이 얇은 위계가 사라져 도면이 평평해진다 — 실측 shoe_1:
    // width 가 {1.2:61, 2:115, 3.2:74, 4.5:21} 에서 {1.2:81, 1.4:119} 로 뭉갰다. 선 F@2 는
    // qaWidth 로 재므로 이 손실을 못 잡는다(오히려 올랐다). 눈으로만 잡히는 회귀였다.
    // 실측 잉크 폭이 그대로 들어 있는 경우(qaWidth 미설정)만 상한한다.
    if((p as {qaWidth?:number}).qaWidth!==undefined&&process.env.V4_CLEAN_CAP_GRADED!=="1")continue;
    (p as {qaWidth?:number}).qaWidth??=p.width;p.width=cap;widthChanges++;
  }
  const topology=repairSceneJunctions(scene,scale);
  say?.(`접합 고리 — 순환 ${topology.cyclesBefore} → ${topology.cyclesAfter} · 복원 ${topology.repaired.length}`);
  const contours=cleanContours(scene,{scale},say);
  // Joining a fragmented main stroke can expose outside support that was too
  // short for the first topology decision. Rebuild the graph, do not relax the
  // classifier. Bound the settling passes and stop as soon as nothing changes.
  for(let pass=0;pass<2;pass++) {
    const next=repairSceneJunctions(scene,scale);
    topology.cyclesAfter=next.cyclesAfter;topology.deferred=next.deferred;
    if(!next.repaired.length)break;
    topology.repaired.push(...next.repaired);
    const c=cleanContours(scene,{scale},say);
    contours.spurIds.push(...c.spurIds);contours.trimmedHookIds.push(...c.trimmedHookIds);contours.speckIds.push(...c.speckIds);
    contours.joined.push(...c.joined);contours.smoothed.push(...c.smoothed);contours.deferred=c.deferred;contours.anchorsAfter=c.anchorsAfter;
  }
  const glyphs=await separateGlyphs(scene,workDir,scale,say);
  // New text-border curves already meet the existing endpoint coordinates.
  const {joinMicroGaps}=await import("./cleanContours.js");
  const configuredGap=Number(process.env.V4_CLEAN_GAP_PX??12);
  const postGlyphJoins=joinMicroGaps(scene.primitives,scale,Number.isFinite(configuredGap)&&configuredGap>=0?configuredGap:12);
  scene.sharedBoundaries=scene.primitives.filter(p=>p.partId&&p.shared?.length)
    .map(p=>({primitiveId:p.id,between:[p.partId!,...p.shared!]}));
  const finalAudit=auditLineQuality(scene,scale,baseline);
  scene.provenance.cleanup={codeVersion:CODE_VERSION,glyphReview:glyphs.deferred,lineReview:finalAudit.review};
  return {scale,widthChanges,topology,contours,glyphs,postGlyphJoins,finalAudit};
}
