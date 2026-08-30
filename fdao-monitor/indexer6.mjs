import fs from "node:fs";
import { pathToFileURL } from "node:url";
const rpcUrl = process.env.NODEREAL_RPC_URL;
if (!rpcUrl) throw Error("NODEREAL_RPC_URL is required");
const srcPath = "fdao-monitor/indexer5.mjs";
let src = fs.readFileSync(srcPath, "utf8");
const start = src.indexOf("async function batch("),
  end = src.indexOf("const latest=", start);
if (start < 0 || end < 0) throw Error("template changed");
const replacement = `async function logsRange(from,to){let out=[];const url=${JSON.stringify(rpcUrl)};for(let a=from;a<=to;a+=50000){let b=Math.min(to,a+49999),filter={address:A.FDAO,fromBlock:hx(a),toBlock:hx(b),topics:[ALL]};let x=await rpc('eth_getLogs',[filter],url,3);out.push(...x);await wait(350)}return out;}\n`;
src = src.slice(0, start) + replacement + src.slice(end);
src = src.replaceAll("bsc-batch-v1", "nodereal-index-v1");
src = src.replace("const BACK=50000", "const BACK=200000");
src = src.replace(
  "merge(s.dayEvents,await logsRange(from,to));s.dayBackfillCursor",
  `{let __ls=await logsRange(from,to);if(from===s.dayStartBlock&&to>=s.dayStartBlock+50000&&__ls.length===0)throw Error('SANITY: NodeReal returned zero FDAO logs for known-active day');merge(s.dayEvents,__ls)}s.dayBackfillCursor`,
);
const target = "/tmp/fdao-indexer-runtime.mjs";
fs.writeFileSync(target, src);
await import(pathToFileURL(target).href + "?v=" + Date.now());
