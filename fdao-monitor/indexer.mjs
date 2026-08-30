import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('fdao-monitor/data');
fs.mkdirSync(OUT,{recursive:true});

const C = {
  FDAO:'0xc5424eb1061bd9e147788c527c95ac27710bfa41',
  META:'0x98f0421fcb5129b352cc35c1ed15ae9081deb700',
  SENTIS:'0x8fd0d741e09a98e82256c63f25f90301ea71a83e',
  PAIR:'0x4f49ad237a81ad403a88f34a12a8d1d53c2d7d89',
  USER:'0x0e39420fcdb05c5378c7d1f955dc546b5f5a85b6',
  DEAD:'0x000000000000000000000000000000000000dead'
};
const RPC='https://bsc-dataseed.binance.org/';
const LOG_RPC='https://bsc.drpc.org';
const PAIR_API='https://api.dexscreener.com/latest/dex/pairs/bsc/'+C.PAIR;
const TOPICS={
  stake:'0x3e451024d3d4ca4a6f8985802ef8887d16b5f1b2c495e5ace458437b21d18505',
  stake1:'0x05a5b88949c1b7e7b6f52ca8bb014e695c3f9bc8893e0f75a3699a1519507e5c',
  stakeAcp:'0x95b92b7b8f8d5c56d72e536e955714d166392387f565da17b314fbb8e73280a1',
  unstake:'0x9d4ddcf7be95a56327247eeb36efb79783c00d13defcd5a572d1e3e0d8bf57d5',
  unstake1:'0x7baf0db25f935f5cb985caf351c40c4ecfd6a3b4ee3c8e3360183b8f051ed97e',
  unstakeAcp:'0xc4915ee1bfb9fe5fca0991eeb563dea7da3fe05fb9265ffc22a49c16cc9ff58e'
};
const stakeTopics=[TOPICS.stake,TOPICS.stake1,TOPICS.stakeAcp];
const allTopics=[...stakeTopics,TOPICS.unstake,TOPICS.unstake1,TOPICS.unstakeAcp];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hex=n=>'0x'+BigInt(n).toString(16);
const num=h=>Number(BigInt(h));
const unit=h=>Number(BigInt(h))/1e18;
const words=d=>{const s=d.slice(2);const a=[];for(let i=0;i<s.length;i+=64)a.push('0x'+s.slice(i,i+64));return a};
const userFromTopic=t=>'0x'+t.slice(-40).toLowerCase();

async function rpc(method,params=[],url=RPC,retries=4){
  let last;
  for(let i=0;i<retries;i++){
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      const j=await r.json();
      if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
      return j.result;
    }catch(e){last=e;await sleep(700*(i+1));}
  }
  throw last;
}
async function latestBlock(){return num(await rpc('eth_blockNumber'))}
async function block(n){return rpc('eth_getBlockByNumber',[hex(n),false])}
async function findBlockAt(ts){
  let hi=await latestBlock(), lo=Math.max(1,hi-500000);
  while(lo<hi){const mid=Math.floor((lo+hi)/2);const b=await block(mid);if(!b){lo=mid+1;continue}const t=num(b.timestamp);if(t<ts)lo=mid+1;else hi=mid;}
  return lo;
}
async function logs(from,to,topics){
  const out=[]; const CHUNK=5000;
  for(let a=from;a<=to;a+=CHUNK){
    const b=Math.min(to,a+CHUNK-1);
    const x=await rpc('eth_getLogs',[{address:C.FDAO,fromBlock:hex(a),toBlock:hex(b),topics:[topics]}],LOG_RPC);
    out.push(...x); await sleep(180);
  }
  return out;
}
async function call(to,data,from=C.USER){return rpc('eth_call',[{to,from,data},'latest'])}
const sel={viewStakeingInfo:'0xb46fb85f',totalSupply:'0x18160ddd',getReserves:'0x0902f1ac'};
function balanceOfData(addr){return '0x70a08231'+'0'.repeat(24)+addr.slice(2).toLowerCase()}
function decodeStakeInfo(raw){const w=words(raw);return {myStaked:unit(w[0]),myReward:unit(w[1]),totalStakedRaw:unit(w[2]),apy:unit(w[3]),tvl:unit(w[4])}}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(path.join(OUT,file),'utf8'))}catch{return fallback}}
function writeJson(file,v){fs.writeFileSync(path.join(OUT,file),JSON.stringify(v,null,2)+'\n')}
function dayKey(d=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function hkMidnightEpoch(){const now=new Date();const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).split('-');return Date.parse(`${parts[0]}-${parts[1]}-${parts[2]}T00:00:00+08:00`)/1000}
function eventId(l){return l.transactionHash+':'+l.logIndex}
function parseEvent(l){
  const topic=l.topics[0].toLowerCase(), w=words(l.data), user=userFromTopic(l.topics[1]);
  if(stakeTopics.includes(topic)) return {kind:'stake',id:eventId(l),user,block:num(l.blockNumber),tx:l.transactionHash,lp:unit(w[0]),meta:unit(w[1]),ts:num(w[w.length-1])};
  return {kind:'unstake',id:eventId(l),user,block:num(l.blockNumber),tx:l.transactionHash,lp:unit(w[0]),rtype:num(w[1]),token:unit(w[2]),fee:unit(w[3]),ts:num(w[w.length-1])};
}

let state=readJson('state.json',{version:2,date:null,dayStartBlock:null,lastBlock:null,dayEvents:[],historicalWallets:[],backfillCursor:null,backfillFloor:null});
const today=dayKey();
if(state.date!==today){
  const hist=new Set(state.historicalWallets||[]);
  for(const e of state.dayEvents||[]) if(e.kind==='stake') hist.add(e.user);
  state={version:2,date:today,dayStartBlock:null,lastBlock:null,dayEvents:[],historicalWallets:[...hist],backfillCursor:null,backfillFloor:null};
}
if(!state.dayStartBlock){
  state.dayStartBlock=await findBlockAt(hkMidnightEpoch());
  state.lastBlock=state.dayStartBlock-1;
  state.backfillCursor=state.dayStartBlock-1;
  state.backfillFloor=Math.max(1,state.dayStartBlock-6000000); // gradual ~month-scale backfill
}
const latest=await latestBlock();
if(state.lastBlock<latest){
  const ls=await logs(state.lastBlock+1,latest,allTopics);
  const seen=new Set((state.dayEvents||[]).map(x=>x.id));
  for(const l of ls){const e=parseEvent(l);if(!seen.has(e.id)){state.dayEvents.push(e);seen.add(e.id)}}
  state.lastBlock=latest;
}
// Backfill older stake wallets separately so "new wallet" becomes more accurate every run.
if(state.backfillCursor>state.backfillFloor){
  const span=50000;
  const from=Math.max(state.backfillFloor,state.backfillCursor-span+1),to=state.backfillCursor;
  try{
    const old=await logs(from,to,stakeTopics);const hist=new Set(state.historicalWallets||[]);for(const l of old)hist.add(userFromTopic(l.topics[1]));state.historicalWallets=[...hist];state.backfillCursor=from-1;
  }catch(e){console.warn('backfill skipped:',e.message)}
}

const [stakeRaw,pairSupplyRaw,pairBalRaw,burnRaw,reservesRaw,marketResp]=await Promise.all([
  call(C.FDAO,sel.viewStakeingInfo),call(C.PAIR,sel.totalSupply),call(C.PAIR,balanceOfData(C.FDAO)),call(C.META,balanceOfData(C.DEAD)),call(C.PAIR,sel.getReserves),fetch(PAIR_API).then(r=>r.json())
]);
const stakeInfo=decodeStakeInfo(stakeRaw);
const pairSupply=unit(pairSupplyRaw),pairInFdao=unit(pairBalRaw),burnedMeta=unit(burnRaw);
const rw=words(reservesRaw),reserve0=unit(rw[0]),reserve1=unit(rw[1]);
const p=(marketResp.pairs||[])[0];
const metaIsBase=p?.baseToken?.address?.toLowerCase()===C.META;
let metaPrice=Number(p?.priceUsd||0),sentisPrice=0;
if(metaIsBase){sentisPrice=metaPrice/Number(p.priceNative||1)}else{sentisPrice=metaPrice;metaPrice=sentisPrice/Number(p?.priceNative||1)}
const liquidity=Number(p?.liquidity?.usd||0),volume24=Number(p?.volume?.h24||0),buys=Number(p?.txns?.h24?.buys||0),sells=Number(p?.txns?.h24?.sells||0);

const stakes=state.dayEvents.filter(e=>e.kind==='stake'),unstakes=state.dayEvents.filter(e=>e.kind==='unstake');
const dayWallets=[...new Set(stakes.map(e=>e.user))],hist=new Set(state.historicalWallets||[]);
const newWallets=dayWallets.filter(x=>!hist.has(x));
const stakeMeta=stakes.reduce((s,e)=>s+e.meta,0),unstakeToken=unstakes.reduce((s,e)=>s+e.token,0);
const stakeUsd=stakeMeta*metaPrice,unstakeUsd=unstakeToken*metaPrice,netUsd=stakeUsd-unstakeUsd;
const rewardLow=stakeInfo.tvl*.006,rewardHigh=stakeInfo.tvl*.012;
const feeMax=volume24*.02,feeCoverLow=rewardLow?feeMax/rewardLow:0;
const rewardToVolumeLow=volume24?rewardLow/volume24:0,rewardToVolumeHigh=volume24?rewardHigh/volume24:0;
const custodyPct=pairSupply?pairInFdao/pairSupply:0;
const backfillDone=state.backfillCursor<=state.backfillFloor;
const current={
  updatedAt:new Date().toISOString(),timezone:'Asia/Hong_Kong',block:latest,date:today,
  source:{mode:'background-indexer',fdao:C.FDAO,pair:C.PAIR,market:'DexScreener',rpc:'BNB Chain public RPC + dRPC'},
  market:{metaPrice,sentisPrice,liquidity,volume24,buys,sells,priceChange24:Number(p?.priceChange?.h24||0)},
  protocol:{apy:stakeInfo.apy,tvl:stakeInfo.tvl,totalStakedRaw:stakeInfo.totalStakedRaw,pairSupply,pairInFdao,custodyPct,burnedMeta,reserveSentis:reserve0,reserveMeta:reserve1},
  today:{uniqueStakeWallets:dayWallets.length,newWallets:newWallets.length,stakeCount:stakes.length,stakeMeta,stakeUsd,unstakeCount:unstakes.length,unstakeToken,unstakeUsd,netUsd},
  pressure:{rewardLow,rewardHigh,feeMax,feeCoverLow,rewardToVolumeLow,rewardToVolumeHigh},
  indexing:{dayStartBlock:state.dayStartBlock,lastBlock:state.lastBlock,backfillCursor:state.backfillCursor,backfillFloor:state.backfillFloor,backfillDone,historicalWallets:state.historicalWallets.length,newWalletMeaning:backfillDone?'历史首次进入FDAO的钱包':'回填完成范围内未见历史质押的钱包（全历史回填中）'},
  user:{address:C.USER,myStakedLp:stakeInfo.myStaked,myReward:stakeInfo.myReward}
};
let history=readJson('daily.json',[]);history=history.filter(x=>x.date!==today);history.push({date:today,updatedAt:current.updatedAt,uniqueStakeWallets:dayWallets.length,newWallets:newWallets.length,stakeCount:stakes.length,stakeUsd,unstakeCount:unstakes.length,unstakeUsd,netUsd,tvl:stakeInfo.tvl,apy:stakeInfo.apy,liquidity,volume24,burnedMeta});history=history.slice(-120);
writeJson('state.json',state);writeJson('current.json',current);writeJson('daily.json',history);
console.log(JSON.stringify({updatedAt:current.updatedAt,block:latest,today:current.today,protocol:{apy:stakeInfo.apy,tvl:stakeInfo.tvl,custodyPct,burnedMeta},indexing:current.indexing},null,2));
