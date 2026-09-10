import { CODE_VERSION } from "./version.js";
import type { VectorScene, ScenePrimitive } from "./types.js";

/** Public editor documents omit masks, route evidence and qaWidth. Import only
 * the geometry and presentation they actually contain; never fabricate QA. */
export function sceneFromEditor(doc:any,canvas?:VectorScene["canvas"]):VectorScene {
  const prims:ScenePrimitive[]=[];
  for(const p of doc.paths) {
    const base={id:p.id,cls:p.cls,d:p.d,partId:p.partId,shared:p.shared,area:0,bbox:[0,0,0,0] as [number,number,number,number],
      route:{chosen:p.cls,features:{glyph:p.bucket==="REVIEW_TEXT"},why:"Imported live editor geometry; upstream evidence unavailable",confidence:0}};
    if(p.cls==="STRUCTURAL_STROKE"||p.cls==="DASH_OR_STITCH")prims.push({...base,width:p.width,color:p.stroke??"#111111",dashArray:p.dashArray} as ScenePrimitive);
    else if(p.cls==="GEOMETRIC_PRIMITIVE")prims.push({...base,kind:p.kind??"line",params:{},anchorsSaved:0,residual:{rms:0,max:0},
      ...(p.stroke?{paint:"stroke",stroke:p.stroke,width:p.width}:{paint:"fill",fill:p.fill})} as ScenePrimitive);
    else prims.push({...base,fill:p.fill??"#111111"} as ScenePrimitive);
  }
  for(const p of doc.patterns??[])prims.push({...p,area:0,bbox:[0,0,0,0] as [number,number,number,number],pathsSaved:0,
    route:{chosen:p.cls,features:{},why:"Imported live editor pattern",confidence:0}});
  return {canvas:canvas??{...doc.canvas,sourceWidth:doc.canvas.width,sourceHeight:doc.canvas.height,supersample:1},
    primitives:prims,parts:doc.parts.map((p:any,i:number)=>({...p,z:i,kind:"imported",confidence:0,occludedBy:[]})),
    sharedBoundaries:[],correspondence:{method:"none",aspectRatio:1,confident:false,note:"Offline editor geometry replay; not full pipeline QA"},
    provenance:{pipeline:"v4.offline-editor-replay",schematic:{backend:"existing",prompt:"",seed:null},
      createdAt:new Date().toISOString(),lowConfidence:0,
      // pipeline 은 이름이고(본 경로는 "v4.semantic-topology") 판은 run.codeVersion 이 든다.
      // 재생이라 실행 설정도 입력 해시도 없지만, 판은 있어야 이 씬이 어느 코드에서 나왔는지 짚는다.
      run:{codeVersion:CODE_VERSION,options:{},env:{},inputSha256:null}}};
}
