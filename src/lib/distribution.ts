export type Candidate = {id:string; weight:number; daily:number; pending:number; dailyLimit:number; capacity:number; active:boolean};
export function chooseRecipients(mode: string, candidates: Candidate[], cursor: number): {owner:string;notify:string[];cursor:number}|null {
  const available = candidates.filter(c=>c.active && c.daily<c.dailyLimit && c.pending<c.capacity);
  if(mode==='MANUAL' || !available.length) return null;
  let owner: Candidate;
  if(mode==='SINGLE') { owner=candidates[0]; if(!available.includes(owner)) return null; }
  else if(mode==='CAPACITY') owner=[...available].sort((a,b)=>a.pending/a.capacity-b.pending/b.capacity || a.daily-b.daily)[0];
  else if(mode==='WEIGHTED'||mode==='BATCH') {
    const weighted=available.filter(c=>c.weight>0);
    if(!weighted.length) return null;
    // Contiguous slots give each recipient their configured count before moving on.
    const total=weighted.reduce((s,c)=>s+c.weight,0);
    let point=cursor%total;
    owner=weighted[weighted.length-1];
    for(const c of weighted) {if(point<c.weight) {owner=c;break;} point-=c.weight;}
  } else {
    owner=available[0];
    for(let i=0;i<candidates.length;i++) {const c=candidates[(cursor+i)%candidates.length]; if(available.includes(c)) {owner=c;cursor=(cursor+i)%candidates.length;break;}}
  }
  const nextCursor=mode==='BATCH'?(cursor+1)%available.reduce((sum,c)=>sum+c.weight,0):cursor+1;
  return {owner:owner.id,notify:mode==='ALL'?candidates.filter(c=>c.active).map(c=>c.id):[owner.id],cursor:nextCursor};
}
