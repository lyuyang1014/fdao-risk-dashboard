import fs from 'node:fs';
import path from 'node:path';

const DIR=path.resolve('fdao-monitor/data'); fs.mkdirSync(DIR,{recursive:true});
const A={FDAO:'0xc5424eb1061bd9e147788c527c95ac27710bfa41',META:'0x98f0421fcb5129b352cc35c1ed15ae9081deb700',PAIR:'0x4f49ad237a81ad403a88f34a12a8d1d53c2d7d89',USER:'0x0e39420fcdb05c5378c7d1f955dc546b5f5a85b6',DEAD:'0x000000000000000000000000000000000000dead'};
const RPC='https://bsc-dataseed.binance.org/', LOGRPC='https://bsc.drpc.org', DEX='https://api.dexscreener.com/latest/dex/pairs/bsc/'+A.PAIR;
const T={stake:'0x3e451024d3d4ca4a6f8985802ef8887d16b5f1b2c495e5ace458437b21d18505',stake1:'0x05a5b88949c1b7e7b6f52ca8bb014e695c3f9bc8893e0f75a3699a1519507e5c',stakeA:'0x95b92b7b8f8d5c56d72e536e955714d166392387f565da17b314fbb8e73280a1',unstake:'0x9d4ddcf7be95a56327247eeb36efb79783c00d13defcd5a572d1e3e0d8bf57d5',unstake1:'0x7baf0db25f935f5cb985caf351c40c4ecfd6a3b4ee3c8e3360183b8f051ed97e',unstakeA:'0xc4915ee1bfb9fe5fca0991eeb563dea7da3fe05fb9265ffc22a49c16cc9ff58e'};
const ST=[T.stake,T.stake1,T.stakeA], ALL=[...ST,T.unstake,T.unstake1,T.unstakeA];
const sleep=m=>new Promise(r=>setTimeout(r,m)), hx=n=>'0x'+BigInt(n).toString(16), n=h=>Number(BigInt(h)), u=h=>Number(BigInt(h))/1e18;
const words=d=>{let s=d.slice(2),a=[];for(let i=0;i<s.length;i+=64)a.push('0x'+s.slice(i,i+64));return a};
const who=t=>'0x'+t.slice(-40).toLowerCase();
const read=(f,x)=>{try{return JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8'))}catch{return x}}, write=(f,x)=>fs.writeFileSync(path.join(DIR,f),JSON.stringify(x,null,2)+'\n');

async function rpc(method,params=[],url=RPC){
  let err;
  for(let i=0;i<7;i++){
    try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw new Error(j.error.message||'RPC error');return j.result}
    catch(e){err=e;const rate=/rate limit|too many|429/i.test(e.message);await sleep(rate?4000+1500*i:800+600*i)}
  }
  throw err;
}
const latest=async()=>n(await rpc('eth_blockNumber'));
async function getBlock(b){return rpc('eth_getBlockByNumber',[hx(b),false])}
async function blockAt(ts){let hi=await latest(),lo=Math.max(1,hi-500000);while(lo<hi){let m=Math.floor((lo+hi)/2),b=await getBlock(m),t=n(b.timestamp);if(t<ts)lo=m+1;else hi=m}return lo}
async function getLogs(from,to,topics){
  let out=[]; const CH=10000;
  for(let a=from;a<=to;a+=CH){let b=Math.min(to,a+CH-1);let x=await rpc('eth_getLogs',[{address:A.FDAO,fromBlock:hx(a),toBlock:hx(b),topics:[topics]}],LOGRPC);out.push(...x);await sleep(1400)}
  return out;
}
async function call(to,data,from=A.USER){return rpc('eth_call',[{to,from,data},'latest'])}
const bal=addr=>'0x70a08231'+'0'.repeat(24)+addr.slice(2).toLowerCase();
function stakeInfo(raw){let w=words(raw);return {myStaked:u(w[0]),myReward:u(w[1]),totalStakedRaw:u(w[2]),apy:u(w[3]),tvl:u(w[4])}}
function dateHK(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function midnightHK(){return Date.parse(dateHK()+'T00:00:00+08:00')/1000}
function parse(l){let topic=l.topics[0].toLowerCase(),w=words(l.data),user=who(l.topics[1]),id=l.transactionHash+':'+l.logIndex;if(ST.includes(topic))return {kind:'stake',id,user,block:n(l.blockNumber),tx:l.transactionHash,lp:u(w[0]),meta:u(w[1]),ts:n(w.at(-1))};return {kind:'unstake',id,user,block:n(l.blockNumber),tx:l.transactionHash,lp:u(w[0]),rtype:n(w[1]),token:u(w[2]),fee:u(w[3]),ts:n(w.at(-1))}}

let s=read('state.json',{version:3,date:null,dayStartBlock:null,lastBlock:null,dayEvents:[],historicalWallets:[],backfillCursor:null,backfillFloor:null});let today=dateHK();
if(s.date!==today){let h=new Set(s.historicalWallets||[]);for(let e of s.dayEvents||[])if(e.kind==='stake')h.add(e.user);s={version:3,date:today,dayStartBlock:null,lastBlock:null,dayEvents:[],historicalWallets:[...h],backfillCursor:null,backfillFloor:null}}
if(!s.dayStartBlock){s.dayStartBlock=await blockAt(midnightHK());s.lastBlock=s.dayStartBlock-1;s.backfillCursor=s.dayStartBlock-1;s.backfillFloor=Math.max(1,s.dayStartBlock-6000000)}
let head=await latest();
if(s.lastBlock<head){let ls=await getLogs(s.lastBlock+1,head,ALL),ids=new Set(s.dayEvents.map(e=>e.id));for(let l of ls){let e=parse(l);if(!ids.has(e.id)){s.dayEvents.push(e);ids.add(e.id)}}s.lastBlock=head}
// Backfill only 20k blocks per run to avoid public RPC throttling; repeated scheduled runs progressively build true first-time-wallet history.
if(s.backfillCursor>s.backfillFloor){let from=Math.max(s.backfillFloor,s.backfillCursor-19999),to=s.backfillCursor;try{let old=await getLogs(from,to,ST),h=new Set(s.historicalWallets||[]);for(let l of old)h.add(who(l.topics[1]));s.historicalWallets=[...h];s.backfillCursor=from-1}catch(e){console.warn('backfill deferred:',e.message)}}

const [siRaw,supplyRaw,fdaoLpRaw,burnRaw,resRaw,dex]=await Promise.all([call(A.FDAO,'0xb46fb85f'),call(A.PAIR,'0x18160ddd'),call(A.PAIR,bal(A.FDAO)),call(A.META,bal(A.DEAD)),call(A.PAIR,'0x0902f1ac'),fetch(DEX).then(r=>r.json())]);
let si=stakeInfo(siRaw),supply=u(supplyRaw),fdaoLp=u(fdaoLpRaw),burn=u(burnRaw),rw=words(resRaw),p=(dex.pairs||[])[0];
let metaBase=p?.baseToken?.address?.toLowerCase()===A.META,metaPrice=Number(p?.priceUsd||0),sentisPrice=0;if(metaBase)sentisPrice=metaPrice/Number(p.priceNative||1);else{sentisPrice=metaPrice;metaPrice=sentisPrice/Number(p?.priceNative||1)}
let market={metaPrice,sentisPrice,liquidity:Number(p?.liquidity?.usd||0),volume24:Number(p?.volume?.h24||0),buys:Number(p?.txns?.h24?.buys||0),sells:Number(p?.txns?.h24?.sells||0),priceChange24:Number(p?.priceChange?.h24||0)};
let stakes=s.dayEvents.filter(e=>e.kind==='stake'),un=s.dayEvents.filter(e=>e.kind==='unstake'),wallets=[...new Set(stakes.map(e=>e.user))],hist=new Set(s.historicalWallets||[]),newWallets=wallets.filter(w=>!hist.has(w));
let stakeMeta=stakes.reduce((a,e)=>a+e.meta,0),exitToken=un.reduce((a,e)=>a+e.token,0),stakeUsd=stakeMeta*metaPrice,exitUsd=exitToken*metaPrice,netUsd=stakeUsd-exitUsd,rewardLow=si.tvl*.006,rewardHigh=si.tvl*.012,feeMax=market.volume24*.02;
let current={updatedAt:new Date().toISOString(),timezone:'Asia/Hong_Kong',block:head,date:today,market,protocol:{apy:si.apy,tvl:si.tvl,totalStakedRaw:si.totalStakedRaw,pairSupply:supply,pairInFdao:fdaoLp,custodyPct:supply?fdaoLp/supply:0,burnedMeta:burn,reserveSentis:u(rw[0]),reserveMeta:u(rw[1])},today:{uniqueStakeWallets:wallets.length,newWallets:newWallets.length,stakeCount:stakes.length,stakeMeta,stakeUsd,unstakeCount:un.length,unstakeToken:exitToken,unstakeUsd:exitUsd,netUsd},pressure:{rewardLow,rewardHigh,feeMax,feeCoverLow:rewardLow?feeMax/rewardLow:0,rewardToVolumeLow:market.volume24?rewardLow/market.volume24:0,rewardToVolumeHigh:market.volume24?rewardHigh/market.volume24:0},indexing:{dayStartBlock:s.dayStartBlock,lastBlock:s.lastBlock,backfillCursor:s.backfillCursor,backfillFloor:s.backfillFloor,backfillDone:s.backfillCursor<=s.backfillFloor,historicalWallets:s.historicalWallets.length,newWalletMeaning:s.backfillCursor<=s.backfillFloor?'历史首次质押钱包':'历史回填中：目前表示已回填范围内未见旧质押'},user:{address:A.USER,myStakedLp:si.myStaked,myReward:si.myReward}};
let daily=read('daily.json',[]).filter(x=>x.date!==today);daily.push({date:today,updatedAt:current.updatedAt,...current.today,tvl:si.tvl,apy:si.apy,liquidity:market.liquidity,volume24:market.volume24,burnedMeta:burn});daily=daily.slice(-120);
write('state.json',s);write('current.json',current);write('daily.json',daily);console.log(JSON.stringify({ok:true,updatedAt:current.updatedAt,today:current.today,protocol:current.protocol,indexing:current.indexing},null,2));
