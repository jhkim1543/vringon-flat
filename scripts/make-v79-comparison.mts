import fs from "node:fs/promises";
import sharp from "sharp";

const W=1320,H=1660;
let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#eef1f4"/><g font-family="DejaVu Sans, sans-serif" fill="#17232c"><text x="28" y="42" font-size="27" font-weight="bold">Flat Sketch — actual vector output comparison</text><text x="28" y="74" font-size="16">Fixed inputs. Native SVG renders. Local server processing; no model regeneration.</text>`;
for(const [i,t] of ["v7.7","v7.8","v7.9"].entries())svg+=`<text x="${32+i*440}" y="118" font-size="23" font-weight="bold">${t}</text>`;
const rows=[{id:"jewelry",name:"Jewelry junction",y:145,h:380},{id:"shoe",name:"Shoe contour",y:545,h:390}];
for(const row of rows) {
 const dirs=[`results/crops/${row.id}-before`,`results/v7.8-reference/crops/${row.id}-after`,`results/v7.9/crops/${row.id}`];
 for(let i=0;i<3;i++) {
   const stats=JSON.parse(await fs.readFile(`${dirs[i]}/stats.json`,"utf8"));
   const image=await sharp(await fs.readFile(`${dirs[i]}/production.svg`)).resize({width:395,height:row.h-65,fit:"inside"}).flatten({background:"white"}).png().toBuffer();
   const m=await sharp(image).metadata(),x=20+i*440;
   svg+=`<rect x="${x}" y="${row.y}" width="410" height="${row.h}" rx="8" fill="white"/><image href="data:image/png;base64,${image.toString("base64")}" x="${x+(410-m.width!)/2}" y="${row.y+12}" width="${m.width}" height="${m.height}"/><text x="${x+15}" y="${row.y+row.h-35}" font-size="18" font-weight="bold">${row.name}</text><text x="${x+15}" y="${row.y+row.h-12}" font-size="16">${stats.anchors} anchors / ${stats.paths} paths</text>`;
 }
}
for(let i=0;i<3;i++) {
 const file=i===2?"results/v7.9/jewelry_1/production.svg":"results/v7.8-reference/v7.8/jewelry_1/"+(i===0?"before.svg":"production.svg");
 const image=await sharp(await fs.readFile(file)).flatten({background:"white"}).extract({left:730,top:480,width:285,height:740}).resize({height:620}).png().toBuffer();
 const m=await sharp(image).metadata(),x=20+i*440;
 svg+=`<rect x="${x}" y="955" width="410" height="675" rx="8" fill="white"/><image href="data:image/png;base64,${image.toString("base64")}" x="${x+(410-m.width!)/2}" y="965" width="${m.width}" height="${m.height}"/><text x="${x+15}" y="1607" font-size="17" font-weight="bold">${i===2?"Thin border + glyph clearance":"Fused lettering and border"}</text>`;
}
svg+="</g></svg>";
await fs.mkdir("deliverables",{recursive:true});
await sharp(Buffer.from(svg)).png().toFile("deliverables/vringon-flat-v7.9-comparison.png");
