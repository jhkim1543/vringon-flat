import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const pending=new Map<string,Promise<unknown>>();
/** One request per process; across workers an atomic hard link commits the
 * first complete answer. Every contender reads that SAME winner. Never expose
 * a half-written JSON or silently return an uncached stochastic answer. */
export async function atomicMemo<T>(file:string,compute:()=>Promise<T>,valid:(x:unknown)=>x is T):Promise<T> {
  file=path.resolve(file);
  if(pending.has(file))return pending.get(file) as Promise<T>;
  const run=(async()=>{
    const read=async()=>{const x=JSON.parse(await fs.readFile(file,"utf8"));if(!valid(x))throw new Error("Invalid memo schema: "+path.basename(file));return x as T;};
    try{return await read();}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const value=await compute();if(!valid(value))throw new Error("Invalid model assignment schema");
    await fs.mkdir(path.dirname(file),{recursive:true});
    const tmp=file+"."+crypto.randomUUID()+".tmp";
    try {
      await fs.writeFile(tmp,JSON.stringify(value),{flag:"wx"});
      try{await fs.link(tmp,file);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
      return await read();
    } finally {await fs.rm(tmp,{force:true});}
  })();
  pending.set(file,run);
  try{return await run;}finally{pending.delete(file);}
}
