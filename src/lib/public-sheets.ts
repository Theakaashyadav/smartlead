import type { Sheet } from '@/generated/mongo';
import type { SheetProvider, SourceRow } from './google';
import { AppError, hash } from './security';
import { phoneSchema } from './validation';
import { detectColumns, sourceQuestions } from './simple-shared';
import { simpleOutputValues } from './sheet-output';
import { writePublicSheet } from './public-sheet-editor';

const sharingHelp='Cannot read this sheet. In Google Sheets, set Share → General access → Anyone with the link, then paste its link again.';
const maxBytes=10*1024*1024;
function sheetId(id:string){if(!/^[\w-]{20,200}$/.test(id))throw new AppError(400,'Paste a valid Google Sheets link.');return id;}

async function publicText(id:string,suffix:string,csv=false){
  let response:Response;
  try{response=await fetch(`https://docs.google.com/spreadsheets/d/${sheetId(id)}${suffix}`,{cache:'no-store',signal:AbortSignal.timeout(30000)});}
  catch(error){if(error instanceof AppError)throw error;throw new AppError(502,'Google Sheets could not be reached. Please try again.');}
  if(response.status===429)throw new AppError(429,'Google Sheets is busy. Please try again shortly.');
  if(response.status>=500)throw new AppError(502,'Google Sheets is temporarily unavailable. Please try again.');
  if(!response.ok||response.url.includes('accounts.google.com'))throw new AppError(400,sharingHelp);
  if(Number(response.headers.get('content-length'))>maxBytes)throw new AppError(413,'This sheet is too large. Connect a smaller worksheet.');
  const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new AppError(413,'This sheet is too large. Connect a smaller worksheet.');}chunks.push(value);}}finally{reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8');
  if(csv&&(/text\/html/i.test(response.headers.get('content-type')||'')||/^\s*<(?:!doctype|html)/i.test(text)))throw new AppError(400,sharingHelp);
  return text;
}

// Preserve phone numbers as text, including leading zeroes and country codes.
export function parseSheetCSV(input:string){
  const text=input.replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;}
    else if(c==='"'&&!cell)quoted=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'||c==='\r'){row.push(cell);rows.push(row);row=[];cell='';if(c==='\r'&&text[i+1]==='\n')i++;}
    else cell+=c;
  }
  if(quoted)throw new AppError(502,'Google returned an incomplete sheet. Please try again.');
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}

function htmlText(value:string){return value.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n:string)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code<=0x10ffff?String.fromCodePoint(code):'';}).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
function jsString(value:string){return JSON.parse(`"${value.replace(/\\x([\da-f]{2})/gi,'\\u00$1')}"`) as string;}

export async function publicCSV(id:string,gid:number){
  if(!Number.isSafeInteger(gid)||gid<0)throw new AppError(400,'Choose a valid sheet tab.');
  return parseSheetCSV(await publicText(id,`/export?format=csv&gid=${gid}`,true));
}

export async function inspectPublicSpreadsheet(id:string,gid?:number){
  const html=await publicText(id,'/htmlview');
  const title=htmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'Google Sheet').replace(/ - Google (?:Drive|Sheets)$/,'').slice(0,200);
  const tabs:{id:number;name:string;headers:string[]}[]=[];
  // Read only tab names and IDs from Google's public viewer; never execute its scripts.
  const pattern=/items\.push\(\{\s*name:\s*"((?:\\.|[^"\\])*)"\s*,\s*pageUrl:\s*"(?:\\.|[^"\\])*"\s*,\s*gid:\s*"(\d+)"/g;
  for(const match of html.matchAll(pattern)){const tabId=Number(match[2]);if(Number.isSafeInteger(tabId)&&!tabs.some(t=>t.id===tabId))tabs.push({id:tabId,name:jsString(match[1]),headers:[]});}
  if(!tabs.length)throw new AppError(400,sharingHelp);
  if(gid!==undefined&&!tabs.some(t=>t.id===gid))throw new AppError(400,'The worksheet in this link was not found. Copy the link from the tab you want to connect.');
  // Limit parallel downloads when a workbook contains many tabs.
  for(let i=0;i<tabs.length;i+=5)await Promise.all(tabs.slice(i,i+5).map(async tab=>{tab.headers=(await publicCSV(id,tab.id))[0]?.map(h=>h.trim())||[];}));
  return {title,tabs};
}

export class PublicSheetsProvider implements SheetProvider{
  async read(sheet:Sheet):Promise<SourceRow[]>{
    const rows=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);if(!rows.length)return [];
    const headers=rows[0].map(h=>h.trim());const mapping={...detectColumns(headers),...sheet.columnMapping as Record<string,string>};
    const original=sheet.columnMapping as Record<string,string>;
    if(!original.leadId)delete mapping.leadId;
    if(!original.leadDate)delete mapping.leadDate;
    if(new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length)throw new AppError(409,'Duplicate column headings found. Give each mapped column a unique heading.');
    for(const key of ['customerName','mobile'])if(!headers.includes(mapping[key]))throw new AppError(409,`Mapped column ${mapping[key]} is missing`);
    const seen=new Set<string>();const result:SourceRow[]=[];
    for(let index=1;index<rows.length;index++){
      const values=Object.fromEntries(Object.entries(mapping).map(([field,column])=>[field,(rows[index][headers.indexOf(column)]||'').trim()]));
      Object.assign(values,simpleOutputValues(headers,rows[index]));
      if(!values.customerName&&!values.mobile)continue;
      const number=phoneSchema.safeParse(values.mobile);
      // Prefer its Lead ID, otherwise use phone + lead date when available.
      const stableId=values.leadId?`public-id:${values.leadId}`:`public:${hash(JSON.stringify([number.success?number.data:values.mobile||values.customerName,values.leadDate||'']))}`;
      if(seen.has(stableId)){if(values.leadId)throw new AppError(409,'Duplicate source Lead IDs found; fix them before synchronization');continue;}
      seen.add(stableId);result.push({stableId,row:index+1,values:{...values,leadId:stableId},questions:sourceQuestions(headers,rows[index])});
    }
    return result;
  }
  async write(sheet:Sheet,stableId:string,_metadataId:number|null,values:Record<string,string>){
    return writePublicSheet(sheet,stableId,values);
  }
}
