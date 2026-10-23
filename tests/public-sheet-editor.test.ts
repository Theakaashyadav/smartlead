import { clearTestModels } from './database-fixture';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { closePublicSheetEditor, columnName, nextOutputMove, outputColumns, sheetPasteText, writePublicSheet } from '@/lib/public-sheet-editor';
import { legacyRemarkColumn, simpleOutputValues } from '@/lib/sheet-output';
import { writebackLead } from '@/lib/engine';

const mocks=vi.hoisted(()=>({launch:vi.fn()}));vi.mock('puppeteer',()=>({launch:mocks.launch}));
vi.mock('@/lib/browser-executable',()=>({browserExecutablePath:async()=>'/test/chromium'}));
beforeEach(async()=>{vi.stubEnv('SHEET_EDITOR_LOW_RESOURCE','false');await clearTestModels(['Job','SyncLog','Lead','Sheet']);});
afterEach(async()=>{await closePublicSheetEditor();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
afterAll(()=>db.$disconnect());
async function fixture(existing=false){
  const sheet=await db.sheet.create({data:{organizationId:'legacy',id:'editor-sheet',name:'Public source',project:'Plots',spreadsheetId:'public-editor-test-sheet-12345',worksheetId:0,connectionType:'SIMPLE_PUBLIC',columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone'}}});
  const lead=await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'public-id:source-a',sourceRow:2,sourceFingerprint:'test',customerName:'Original',mobile:'+919876543210',project:'Plots',managedSnapshot:{status:'New',sharedTo:existing?'Person':'',sentStatus:existing?'Sent':'',feedback:''}}});
  const rows=[['ID','Name','Phone','Unrelated',...(existing?['Sent Status','Shared To','Feedback','Remark']:[])],['source-b','Other','9876543211','keep-b'],['source-a','Original','9876543210','keep-a',...(existing?['Sent','Person','Converted','External feedback']:[])]];
  let range='';let clipboard='';
  const paste=vi.fn(()=>{
    const [,letters,number]=range.match(/^([A-Z]+)(\d+)$/)!;let index=0;for(const c of letters)index=index*26+c.charCodeAt(0)-64;index--;
    const row=Number(number)-1;clipboard.split('\t').forEach((value,i)=>{rows[row][index+i]=value;});
  });
  const access={mode:'',restricted:false};
  const page={close:vi.fn(async()=>{}),setViewport:vi.fn(),goto:vi.fn(),waitForSelector:vi.fn(),bringToFront:vi.fn(),click:vi.fn(),waitForFunction:vi.fn(),evaluate:vi.fn(async(_fn,arg)=>{if(typeof arg==='string')clipboard=arg;else return access;}),keyboard:{down:vi.fn(),up:vi.fn(),type:vi.fn(async value=>{range=value;}),press:vi.fn(async key=>{if(key==='KeyV')paste();})}};
  const context={overridePermissions:vi.fn(),newPage:vi.fn(async()=>page),close:vi.fn()};
  const instance={defaultBrowserContext:vi.fn(()=>context),createBrowserContext:vi.fn(async()=>context),once:vi.fn(),close:vi.fn(async()=>{})};mocks.launch.mockResolvedValue(instance);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(rows.map(row=>row.map(c=>`"${c.replace(/"/g,'""')}"`).join(',')).join('\n'),{headers:{'content-type':'text/csv'}})));
  return {sheet,rows,paste,lead,access,page,context,instance};
}
describe('public Google Sheet writeback',()=>{
  it('saves successive public rows in the compact browser without creating extra contexts or leaking pages',async()=>{
    vi.stubEnv('SHEET_EDITOR_LOW_RESOURCE','true');
    const {sheet,rows,page,context,instance}=await fixture();
    await writePublicSheet(sheet,'public-id:source-a',{sentStatus:'Sent',sharedTo:'Person'});
    await writePublicSheet(sheet,'public-id:source-a',{sentStatus:'Sent',sharedTo:'Person',status:'Interested',feedback:'Call tomorrow'});
    expect(rows[2].slice(-4)).toEqual(['Sent','Person','Interested','Call tomorrow']);
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({args:expect.arrayContaining(['--renderer-process-limit=1','--no-zygote'])}));
    expect(instance.createBrowserContext).not.toHaveBeenCalled();expect(page.close).toHaveBeenCalledTimes(2);expect(context.close).not.toHaveBeenCalled();
  });
  it.each(['View only','Comment only'])('stops before editing when Google labels its access control Mode with caption %s',async mode=>{
    const {sheet,rows,paste,access,page}=await fixture();const before=structuredClone(rows);
    access.mode=mode;
    vi.stubGlobal('document',{querySelector:(selector:string)=>selector==='#docs-access-level-indicator'?{textContent:mode}:null});
    // Run the actual browser callback against the current Google control shape.
    page.evaluate.mockImplementationOnce(async fn=>fn());
    await expect(writePublicSheet(sheet,'public-id:source-a',{sentStatus:'Sent',sharedTo:'Person'})).rejects.toMatchObject({code:'SHEET_READ_ONLY',status:403});
    expect(paste).not.toHaveBeenCalled();expect(rows).toEqual(before);
  });
  it('adds exactly the requested headers and locates a moved lead without altering other cells',async()=>{
    const {sheet,rows}=await fixture();const originals=rows.slice(1).map(row=>row.slice());
    await writePublicSheet(sheet,'public-id:source-a',{sentStatus:'Sent',sharedTo:'Person'});
    expect(rows[0]).toEqual(['ID','Name','Phone','Unrelated','Sent Status','Shared To','Feedback','Remark']);
    expect(rows[2].slice(4)).toEqual(['Sent','Person']);
    expect(rows[1]).toEqual(originals[0]);expect(rows[2].slice(0,4)).toEqual(originals[1]);
  });
  it('preserves external edits instead of silently overwriting feedback',async()=>{
    const {sheet,rows,paste}=await fixture(true);const before=structuredClone(rows);
    await expect(writePublicSheet(sheet,'public-id:source-a',{status:'Interested',sharedTo:'Person',sentStatus:'Sent',feedback:'New feedback'})).rejects.toThrow(/changed outside/);
    expect(paste).not.toHaveBeenCalled();expect(rows).toEqual(before);
  });
  it('saves later feedback after a delivery update created empty output columns',async()=>{
    const {rows,lead}=await fixture();
    await writebackLead(lead.id);
    expect(await db.lead.findUnique({where:{id:lead.id}})).toMatchObject({managedSnapshot:{status:'',feedback:'',__publicOutputV2:'1'}});
    await db.lead.update({where:{id:lead.id},data:{status:'Interested',lastFeedback:'Arrange a site visit',version:{increment:1}}});
    await writebackLead(lead.id);
    expect(rows[2].slice(-4)).toEqual(['','','Interested','Arrange a site visit']);
    expect(await db.lead.findUnique({where:{id:lead.id}})).toMatchObject({writebackStatus:'SYNCED'});
  });
  it('does not write to another lead when the original row is missing',async()=>{
    const {sheet,rows}=await fixture();rows.splice(2,1);
    await expect(writePublicSheet(sheet,'public-id:source-a',{sentStatus:'Sent',sharedTo:'Person'})).rejects.toThrow(/deleted or duplicated/);
    expect(rows[1]).toEqual(['source-b','Other','9876543211','keep-b']);
  });
  it('recreates a broken editor browser before retrying queued writes',async()=>{
    const {sheet,rows}=await fixture();const broken={createBrowserContext:vi.fn().mockRejectedValue(new Error('Protocol error: browser disconnected')),once:vi.fn(),close:vi.fn(async()=>{})};
    mocks.launch.mockResolvedValueOnce(broken);vi.spyOn(console,'error').mockImplementation(()=>{});
    const values={sentStatus:'Sent',sharedTo:'Person'};
    await expect(writePublicSheet(sheet,'public-id:source-a',values)).rejects.toMatchObject({code:'PUBLIC_EDITOR'});expect(broken.close).toHaveBeenCalledOnce();
    await writePublicSheet(sheet,'public-id:source-a',values);expect(rows[2].slice(4)).toEqual(['Sent','Person']);
    expect(mocks.launch.mock.calls.at(-1)?.[0].userDataDir).not.toBe(mocks.launch.mock.calls.at(-2)?.[0].userDataDir);
  });
  it('reuses existing headings and escapes feedback as literal cell text',()=>{
    expect(outputColumns([['Name','lead_status','Feedback','sent_status','shared_to','Remark']]).map(c=>[c.field,c.index,c.missing])).toEqual([['sentStatus',3,false],['sharedTo',4,false],['status',2,false],['feedback',5,false]]);
    expect(()=>outputColumns([['Feedback','feedback']])).toThrow(/Duplicate/);
    expect(columnName(26)).toBe('AA');expect(columnName(701)).toBe('ZZ');
    expect(sheetPasteText('=HYPERLINK("https://example.com")')).toBe('"\'=HYPERLINK(""https://example.com"")"');
    expect(sheetPasteText('First line\nSecond\t"quoted"')).toBe('"First line\nSecond\t""quoted"""');
  });
  it('places all four outputs last in order while retaining every other column and cell',()=>{
    for(const headers of [['Name','Sent Status','Source A','Source B','Shared To','Feedback','Remark'],['Remark','Feedback','Name','Shared To','Source A','Sent Status'],['Shared To','Feedback','Name','Sent Status','Source A','Remark']]){
      const rows=[headers.map(h=>h),headers.map(h=>`value for ${h}`)];const source=headers.filter(h=>!['Sent Status','Shared To','Feedback','Remark'].includes(h));let move=nextOutputMove(rows);let steps=0;
      while(move&&steps++<30){for(const row of rows){const cells=row.splice(move.start,move.count);row.splice(move.start+1,0,...cells);}move=nextOutputMove(rows);}
      expect(move).toBeNull();const columns=outputColumns(rows);expect(columns.map(c=>c.index)).toEqual([headers.length-4,headers.length-3,headers.length-2,headers.length-1]);
      expect(rows[0].filter(h=>source.includes(h))).toEqual(source);for(let i=0;i<rows[0].length;i++)expect(rows[1][i]).toBe(`value for ${rows[0][i]}`);
    }
  });
  it('reads the previous feedback layout without mistaking remarks for a selected status',()=>{
    const headers=['Name','lead_status','Feedback','Sent Status','Shared To'];
    expect(legacyRemarkColumn(headers)).toBe(2);
    expect(simpleOutputValues(headers,['Customer','Interested','Call tomorrow','Sent','A'])).toEqual({sentStatus:'Sent',sharedTo:'A',status:'Interested',feedback:'Call tomorrow'});
    headers[2]='Remark';headers.push('Feedback');
    expect(legacyRemarkColumn(headers)).toBe(-1);
    expect(simpleOutputValues(headers,['Customer','New','Call tomorrow','Sent','A','Interested'])).toEqual({sentStatus:'Sent',sharedTo:'A',status:'Interested',feedback:'Call tomorrow'});
  });
});
