import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import type { Sheet } from '@/generated/postgres';
import { db } from './db';
import { AppError, decrypt, hash, opaqueToken } from './security';
import { MANAGED } from './validation';
import { PublicSheetsProvider } from './public-sheets';
import { LEGACY_ORGANIZATION } from './organizations';

type Metadata = {metadataId:number;metadataKey:string;metadataValue:string;location:{dimensionRange?:{sheetId:number;startIndex:number;endIndex:number}}};
export type SourceRow = {stableId:string;row:number;metadataId?:number;values:Record<string,string>;questions?:Array<{question:string;answer:string}>};
export interface SheetProvider {
  read(sheet: Sheet): Promise<SourceRow[]>;
  write(sheet: Sheet, stableId: string, metadataId: number|null, values: Record<string,string>): Promise<void>;
}
export async function googleToken(credentialId?: string|null,organizationId=LEGACY_ORGANIZATION) {
  if (credentialId) {
    const credential = await db.googleCredential.findFirst({where:{id:credentialId,organizationId}});
    if (!credential) throw new AppError(400,'Google credential no longer exists');
    const tokens=JSON.parse(decrypt(credential.encryptedValue));
    if(credential.type==='SERVICE_ACCOUNT'){
      const auth=new GoogleAuth({credentials:tokens,scopes:['https://www.googleapis.com/auth/spreadsheets']});
      const token=await auth.getAccessToken();if(!token)throw new AppError(400,'Google authorization failed');return token;
    }
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI);
    client.setCredentials(tokens);
    const result=await client.getAccessToken();
    if(!result.token) throw new AppError(400,'Reconnect your Google account');
    return result.token;
  }
  if(organizationId!==LEGACY_ORGANIZATION||!process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) throw new AppError(400,'Connect your organisation\'s Google account or service account first');
  const credentials=JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64,'base64').toString());
  const auth = new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/spreadsheets']});
  const token = await auth.getAccessToken();
  if(!token) throw new AppError(400,'Google authorization failed');
  return token;
}
async function googleRequest(spreadsheetId: string, suffix: string, token: string, body?: unknown) {
  if(!/^[\w-]+$/.test(spreadsheetId)) throw new AppError(400,'Invalid spreadsheet ID');
  const response=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${suffix}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  if(!response.ok) {
    const reason=response.status===403?'Share this spreadsheet with the connected account as Editor':response.status===429?'Google API quota reached; synchronization will retry':response.status===404?'Spreadsheet not found; verify its URL':'Google Sheets is temporarily unavailable';
    throw new AppError(response.status===429?429:502,reason);
  }
  return response.json();
}
export async function inspectSpreadsheet(spreadsheetId:string, credentialId?:string|null,organizationId=LEGACY_ORGANIZATION) {
  const token=await googleToken(credentialId,organizationId);
  const info=await googleRequest(spreadsheetId,'?fields=spreadsheetId,properties(title),sheets(properties)',token);
  const tabs = await Promise.all(info.sheets.map(async (s:{properties:{sheetId:number;title:string}})=>{
    const name=s.properties.title;
    const range=encodeURIComponent(`'${name.replaceAll("'","''")}'!1:1`);
    const data=await googleRequest(spreadsheetId,`/values/${range}`,token);
    return {id:s.properties.sheetId,name,headers:(data.values?.[0]||[]).map(String)};
  }));
  return {title:info.properties.title,tabs};
}
function mapping(sheet:Sheet) {return sheet.columnMapping as Record<string,string>;}
const metadataKey=(sheet:Sheet)=>sheet.organizationId===LEGACY_ORGANIZATION?`smartlead_${sheet.worksheetId}`:`smartlead_${sheet.organizationId}_${sheet.worksheetId}`;
const tabRange=(sheet:Sheet)=>`'${sheet.worksheetName.replaceAll("'","''")}'`;
function columnLetter(n:number) {let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
export class GoogleSheetsProvider implements SheetProvider {
  async read(sheet: Sheet): Promise<SourceRow[]> {
    const token=await googleToken(sheet.credentialId,sheet.organizationId);
    let map={...mapping(sheet)};
    let data=await googleRequest(sheet.spreadsheetId,`/values/${encodeURIComponent(tabRange(sheet))}`,token);
    let rows: string[][]=(data.values||[]).map((r:unknown[])=>r.map(v=>String(v??'')));
    if(!rows.length) return [];
    let headers=rows[0];
    if(new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length) throw new AppError(409,'Duplicate column headings found. Give each mapped column a unique heading.');
    for(const key of ['customerName','mobile']) if(!headers.includes(map[key])) throw new AppError(409,`Mapped column ${map[key]} is missing`);
    const required={...(sheet.connectionType.startsWith('SIMPLE_')?{}:MANAGED),...(!map.leadId?{leadId:'SmartLead ID'}:{})};
    const newHeaders=[...headers];
    for(const [field,label] of Object.entries(required)) {
      if(map[field] && headers.includes(map[field])) continue;
      if(!sheet.managedColumnsApproved) continue;
      if(headers.includes(label)) {map[field]=label;continue;}
      map[field]=label;newHeaders.push(label);
    }
    if(newHeaders.length!==headers.length) {
      // Only append explicitly approved new columns, never rewrite source headers.
      await googleRequest(sheet.spreadsheetId,'/values:batchUpdate',token,{valueInputOption:'RAW',data:[{range:`${tabRange(sheet)}!${columnLetter(headers.length)}1:${columnLetter(newHeaders.length-1)}1`,values:[newHeaders.slice(headers.length)]}]});
      headers=newHeaders;
    }
    if(!map.leadId) throw new AppError(409,'A stable Lead ID mapping or approved SmartLead ID column is required');
    if(new Set(Object.values(map).filter(Boolean)).size!==Object.values(map).filter(Boolean).length)throw new AppError(409,'Managed columns conflict with source mappings. Choose distinct column headings.');
    if(JSON.stringify(map)!==JSON.stringify(mapping(sheet))) await db.sheet.update({where:{id:sheet.id},data:{columnMapping:map}});
    const info=await googleRequest(sheet.spreadsheetId,'?fields=developerMetadata',token);
    const existing:Metadata[]=(info.developerMetadata||[]).filter((m:Metadata)=>m.metadataKey===metadataKey(sheet) && m.location.dimensionRange?.sheetId===sheet.worksheetId);
    const requests: unknown[]=[];
    const result:SourceRow[]=[];
    const seen=new Set<string>();
    for(let index=1;index<rows.length;index++) {
      const row=rows[index];
      const values=Object.fromEntries(Object.entries(map).map(([field,col])=>[field,row[headers.indexOf(col)]||'']));
      if(!values.customerName && !values.mobile) continue;
      const tags=existing.filter(m=>m.location.dimensionRange?.startIndex===index);
      if(tags.length>1) throw new AppError(409,'Multiple SmartLead row identities found; resolve duplicate row metadata');
      const tagged=tags[0];
      let stableId=values.leadId;
      if(!stableId) {
        if(!sheet.managedColumnsApproved) throw new AppError(409,`Row ${index+1} is missing its stable Lead ID`);
        stableId=tagged?.metadataValue || opaqueToken();
      }
      if(seen.has(stableId)) throw new AppError(409,'Duplicate source Lead IDs found; fix them before synchronization');
      seen.add(stableId);
      if(tagged && tagged.metadataValue!==stableId) throw new AppError(409,`Row identity changed at row ${index+1}; inspect source IDs before retrying`);
      if(!tagged) requests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:metadataKey(sheet),metadataValue:stableId,visibility:'DOCUMENT',location:{dimensionRange:{sheetId:sheet.worksheetId,dimension:'ROWS',startIndex:index,endIndex:index+1}}}}});
      result.push({stableId,row:index+1,metadataId:tagged?.metadataId,values:{...values,leadId:stableId}});
    }
    // Refuse to attach identities if data moved while the import was being prepared.
    if(requests.length) {
      const fresh=await googleRequest(sheet.spreadsheetId,`/values/${encodeURIComponent(tabRange(sheet))}`,token);
      if(JSON.stringify(fresh.values||[])!==JSON.stringify(data.values||[])) {
        // Newly appended headers are expected; compare only source body rows.
        if(JSON.stringify((fresh.values||[]).slice(1))!==JSON.stringify((data.values||[]).slice(1))) throw new AppError(409,'Sheet changed during import. Retry when row editing is complete.');
      }
      for(let start=0;start<requests.length;start+=100) await googleRequest(sheet.spreadsheetId,':batchUpdate',token,{requests:requests.slice(start,start+100)});
    }
    const taggedInfo=await googleRequest(sheet.spreadsheetId,'?fields=developerMetadata',token);
    const allTags:Metadata[]=taggedInfo.developerMetadata||[];
    for(const row of result) {
      const matches=allTags.filter(m=>m.metadataKey===metadataKey(sheet) && m.metadataValue===row.stableId && m.location.dimensionRange?.sheetId===sheet.worksheetId);
      if(matches.length!==1) throw new AppError(409,'Source row identity is ambiguous; synchronization stopped');
      row.metadataId=matches[0].metadataId;
      if(!rows[row.row-1][headers.indexOf(map.leadId)]) {
        const anchored=await googleRequest(sheet.spreadsheetId,'/values:batchGetByDataFilter',token,{dataFilters:[{developerMetadataLookup:{metadataId:row.metadataId}}]});
        const check=anchored.valueRanges?.[0]?.valueRange?.values?.[0]||[];
        if(check[headers.indexOf(map.customerName)]!==row.values.customerName||check[headers.indexOf(map.mobile)]!==row.values.mobile)throw new AppError(409,'Rows moved while identities were being attached. No customer values were changed.');
        // Identity is now anchored; use metadata to add the ID without touching other cells.
        const values:Array<string|null>=Array(headers.length).fill(null);
        values[headers.indexOf(map.leadId)]=row.stableId;
        await googleRequest(sheet.spreadsheetId,'/values:batchUpdateByDataFilter',token,{valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:row.metadataId}},values:[values]}]});
      }
    }
    return result;
  }
  async write(sheet:Sheet, stableId:string, metadataId:number|null, values:Record<string,string>) {
    if(!metadataId) throw new AppError(409,'Row metadata is missing. Synchronize the source first.');
    const token=await googleToken(sheet.credentialId,sheet.organizationId);
    const map=mapping(sheet);
    const headerData=await googleRequest(sheet.spreadsheetId,`/values/${encodeURIComponent(`${tabRange(sheet)}!1:1`)}`,token);
    const headers:string[]=headerData.values?.[0]||[];
    const filter={developerMetadataLookup:{metadataId}};
    const current=await googleRequest(sheet.spreadsheetId,'/values:batchGetByDataFilter',token,{dataFilters:[filter]});
    if(current.valueRanges?.length!==1) throw new AppError(409,'The original row was deleted or its identity is missing. No cells were updated.');
    const source=current.valueRanges[0].valueRange.values?.[0]||[];
    if(source[headers.indexOf(map.leadId)]!==stableId) throw new AppError(409,'Source Lead ID changed. No cells were updated.');
    const lead=await db.lead.findUnique({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:stableId}}});
    const snapshot=(lead?.managedSnapshot||{}) as Record<string,string>;
    const output:Array<string|null>=Array(headers.length).fill(null);
    for(const [field,value] of Object.entries(values)) {
      if(!Object.hasOwn(MANAGED,field)) throw new AppError(400,'Only application-managed fields may be written');
      const index=headers.indexOf(map[field]);
      if(index<0) throw new AppError(409,`Map or approve the managed ${field} column before writeback`);
      if(Object.hasOwn(snapshot,field)&&String(source[index]||'')!==snapshot[field]&&String(source[index]||'')!==value)throw new AppError(409,`The source ${field} was edited outside SmartLead. Review the conflict before writing back.`,'SYNC_CONFLICT');
      output[index]=value;
    }
    const written=await googleRequest(sheet.spreadsheetId,'/values:batchUpdateByDataFilter',token,{valueInputOption:'RAW',data:[{dataFilter:filter,values:[output]}]});
    if(written.totalUpdatedRows!==1) throw new AppError(409,'The source row could not be updated safely');
  }
}

// Demo rows are durable fixtures in the same local database, isolated from live providers.
export class DemoSheetsProvider implements SheetProvider {
  async read(sheet:Sheet) {
    const setting=await db.setting.findUnique({where:{key:`demo-source:${sheet.id}`}});
    return (setting?.value||[]) as unknown as SourceRow[];
  }
  async write(sheet:Sheet, stableId:string, _metadataId:number|null, values:Record<string,string>) {
    const rows=await this.read(sheet);
    const matches=rows.filter(r=>r.stableId===stableId);
    if(matches.length!==1) throw new AppError(409,'The original demo row was deleted or duplicated');
    const lead=await db.lead.findUnique({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:stableId}}});
    const snapshot=(lead?.managedSnapshot||{}) as Record<string,string>;
    for(const [field,value]of Object.entries(values))if(Object.hasOwn(snapshot,field)&&(matches[0].values[field]||'')!==snapshot[field]&&(matches[0].values[field]||'')!==value)throw new AppError(409,`The source ${field} changed outside SmartLead. Review the conflict.`,'SYNC_CONFLICT');
    matches[0].values={...matches[0].values,...values};
    await db.setting.upsert({where:{key:`demo-source:${sheet.id}`},create:{key:`demo-source:${sheet.id}`,value:JSON.parse(JSON.stringify(rows))},update:{value:JSON.parse(JSON.stringify(rows))}});
  }
}
export const sheetProvider=(sheet:Sheet):SheetProvider=>sheet.connectionType==='DEMO'?new DemoSheetsProvider():sheet.connectionType==='SIMPLE_PUBLIC'?new PublicSheetsProvider():new GoogleSheetsProvider();
export const sourceFingerprint=(values:Record<string,string>)=>hash(JSON.stringify(Object.fromEntries(['customerName','mobile','email','project','location','budget','source','requirement','leadDate'].map(k=>[k,values[k]||'']))));
