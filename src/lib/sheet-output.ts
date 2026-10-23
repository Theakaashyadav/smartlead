import { AppError } from './security';
import { SIMPLE_OUTPUT_COLUMNS } from './simple-shared';

export const outputHeading=(value:string)=>value.toLowerCase().replace(/[\s_]+/g,'');
export function columnName(index:number){
  let name='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;
}
// The old layout stored free-text remarks in Feedback beside lead_status.
// Rename that heading before adding the new Feedback column; keep every cell.
export function legacyRemarkColumn(headers:string[]){
  const normalized=headers.map(outputHeading);
  return normalized.includes('leadstatus')&&!normalized.includes('remark')?normalized.indexOf('feedback'):-1;
}
export function simpleOutputValues(headers:string[],cells:string[]){
  const legacy=legacyRemarkColumn(headers)>=0;
  const read=(label:string)=>{const index=headers.findIndex(h=>outputHeading(h)===outputHeading(label));return index<0?'':cells[index]||'';};
  return {...Object.fromEntries(Object.entries(SIMPLE_OUTPUT_COLUMNS).map(([field,label])=>[field,read(label)])),status:legacy?read('lead_status'):read('Feedback')||read('lead_status'),feedback:legacy?read('Feedback'):read('Remark')};
}
export function outputColumns(rows:string[][],fields:string[]=Object.keys(SIMPLE_OUTPUT_COLUMNS)){
  const headers=rows[0]?.map(h=>h.trim())||[];
  let next=Math.max(0,...rows.map(row=>row.length));
  if(fields.some(field=>!Object.hasOwn(SIMPLE_OUTPUT_COLUMNS,field)))throw new AppError(400,'Only SmartLead output columns may be updated.');
  return Object.entries(SIMPLE_OUTPUT_COLUMNS).filter(([field])=>fields.includes(field)).map(([field,label])=>{
    const found=headers.map((h,i)=>outputHeading(h)===outputHeading(label)?i:-1).filter(i=>i>=0);
    if(found.length>1)throw new AppError(409,`Duplicate ${label} columns found. Keep one column with that heading.`);
    return {field,label,index:found[0]??next++,missing:!found.length};
  });
}
export function nextOutputMove(rows:string[][]){
  const columns=outputColumns(rows);if(columns.some(c=>c.missing))return null;
  const last=Math.max(...rows.map(row=>row.length))-1;
  // Settle the suffix from right to left. Each move carries the entire column,
  // preserving all original source columns, including ones without a heading.
  for(let i=columns.length-1;i>=0;i--){
    const target=last-(columns.length-1-i);
    if(columns[i].index!==target)return {start:columns[i].index,count:1,direction:columns[i].index<target?'right' as const:'left' as const};
  }
  return null;
}
export function expectedOutputValue(snapshot:Record<string,string>,field:string,actual:string){
  // The new Feedback column starts empty when upgrading the legacy layout.
  if(field==='status'&&!snapshot.__publicOutputV2&&!actual)return '';
  return snapshot[field]??(field==='sharedTo'?snapshot.assignedEmployee:'')??'';
}
