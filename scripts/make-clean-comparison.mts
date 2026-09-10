import fs from 'node:fs/promises';
import sharp from 'sharp';
const W=1320,H=980;
const rows=[{id:'shoe',file:'shoe-spurs.png',name:'Shoe contour',y:142},{id:'jewelry',file:'jewelry-junction.png',name:'Jewelry junction',y:573}];
let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f0f3f6"/><g font-family="DejaVu Sans, sans-serif" fill="#17232c"><text x="30" y="43" font-size="28" font-weight="bold">Actual server comparison · fixed uploaded crops</text><text x="30" y="77" font-size="17">Same raster input and settings. v7.8 is the modified buildScene implementation.</text>`;
for(const [i,title] of ['Uploaded crop','v7.7 server output','v7.8 server output'].entries())svg+=`<text x="${30+i*440}" y="118" font-size="21" font-weight="bold">${title}</text>`;
for(const r of rows) {
  const before=JSON.parse(await fs.readFile(`results/crops/${r.id}-before/stats.json`,'utf8'));
  const after=JSON.parse(await fs.readFile(`results/crops/${r.id}-after/stats.json`,'utf8'));
  const files=[`fixtures/user-crops/${r.file}`,`results/crops/${r.id}-before/production.svg`,`results/crops/${r.id}-after/production.svg`];
  for(let i=0;i<3;i++) {
    const raw=await fs.readFile(files[i]),buf=await sharp(raw).resize({width:390,height:340,fit:'inside'}).flatten({background:'white'}).png().toBuffer();
    const meta=await sharp(buf).metadata(),x=i*440+20,y=r.y;
    svg+=`<rect x="${x}" y="${y}" width="400" height="406" rx="8" fill="white"/><image href="data:image/png;base64,${buf.toString('base64')}" x="${x+(400-meta.width!)/2}" y="${y+16+(340-meta.height!)/2}" width="${meta.width}" height="${meta.height}"/>`;
    const caption=i===0?r.name:i===1?`${before.anchors} anchors · ${before.paths} paths`:`${after.anchors} anchors · ${after.paths} paths`;
    svg+=`<text x="${x+18}" y="${y+386}" font-size="21" font-weight="bold" fill="${i===2?'#126754':'#17232c'}">${caption}</text>`;
  }
}
svg+='</g></svg>';
await fs.mkdir('deliverables',{recursive:true});
await sharp(Buffer.from(svg)).png().toFile('deliverables/vringon-flat-v7.8-comparison.png');
