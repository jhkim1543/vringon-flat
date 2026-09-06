import { parsePath } from "../../vector/pathdata.js";
import { thinAnchors, pathDeviation } from "../refit.js";
const rect = "M 461 1224 L 468 1224 L 468 1353 L 461 1353 Z";
const subs = parsePath(rect);
console.log("segs:", subs[0].segs.map((g) => `${g.type}(${g.end})`).join(" "), "closed:", subs[0].closed);
const nd = thinAnchors(rect, 0.6);
console.log("nd:", nd);
console.log("dev:", pathDeviation(rect, nd, 1.0).toFixed(2));
