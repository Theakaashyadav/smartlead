import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { closePublicSheetEditor, columnName, nextOutputMove, outputColumns, sheetPasteText, writePublicSheet } from '@/lib/public-sheet-editor';

const mocks=vi.hoisted(()=>({launch:vi.fn()}));vi.mock('puppeteer',()=>({launch:mocks.launch}));
beforeEach(async()=>{for(const name of ['Lead','Sheet'])await db.$executeRawUnsafe(`DELETE FROM "${name}"`);});
afterEach(async()=>{await closePublicSheetEditor();vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(()=>db.$disconnect());
async function fixture(existing=false){
  const sheet=await db.sheet.create({data:{id:'editor-sheet',name:'Public source',project:'Plots',spreadsheetId:'public-editor-test-sheet-12345',worksheetId:0,connectionType:'SIMPLE_PUBLIC',columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone'}}});
  await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'public-id:source-a',sourceRow:2,sourceFingerprint:'test',customerName:'Original',mobile:'+919876543210',project:'Plots',managedSnapshot:{status:existing?'New':'',assignedEmployee:existing?'Person':'',feedback:''}}});
  const rows=[['ID','Name','Phone','Unrelated',...(existing?['lead_status','shared to','Feedback']:[])],['source-b','Other','9876543211','keep-b'],['source-a','Original','9876543210','keep-a',...(existing?['Converted','Person','External feedback']:[])]];
  let range='';let clipboard='';
  const paste=vi.fn(()=>{
    const [,letters,number]=range.match(/^([A-Z]+)(\d+)$/)!;let index=0;for(const c of letters)index=index*26+c.charCodeAt(0)-64;index--;
    const row=Number(number)-1;clipboard.split('\t').forEach((value,i)=>{rows[row][index+i]=value;});
  });
  const page={setViewport:vi.fn(),goto:vi.fn(),waitForSelector:vi.fn(),bringToFront:vi.fn(),click:vi.fn(),waitForFunction:vi.fn(),evaluate:vi.fn(async(_fn,arg)=>{if(typeof arg==='string')clipboard=arg;else return false;}),keyboard:{down:vi.fn(),up:vi.fn(),type:vi.fn(async value=>{range=value;}),press:vi.fn(async key=>{if(key==='KeyV')paste();})}};
  const context={overridePermissions:vi.fn(),newPage:vi.fn(async()=>page),close:vi.fn()};mocks.launch.mockResolvedValue({createBrowserContext:async()=>context,once:vi.fn(),close:vi.fn(async()=>{})});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(rows.map(row=>row.map(c=>`"${c.replace(/"/g,'""')}"`).join(',')).join('\n'),{headers:{'content-type':'text/csv'}})));
  return {sheet,rows,paste};
}
describe('public Google Sheet writeback',()=>{
  it('adds exactly the requested headers and locates a moved lead without altering other cells',async()=>{
    const {sheet,rows}=await fixture();const originals=rows.slice(1).map(row=>row.slice());
    await writePublicSheet(sheet,'public-id:source-a',{status:'Interested',assignedEmployee:'Person',feedback:'Please call tomorrow'});
    expect(rows[0]).toEqual(['ID','Name','Phone','Unrelated','lead_status','shared to','Feedback']);
    expect(rows[2].slice(4)).toEqual(['Interested','Person','Please call tomorrow']);
    expect(rows[1]).toEqual(originals[0]);expect(rows[2].slice(0,4)).toEqual(originals[1]);
  });
  it('preserves external edits instead of silently overwriting feedback',async()=>{
    const {sheet,rows,paste}=await fixture(true);const before=structuredClone(rows);
    await expect(writePublicSheet(sheet,'public-id:source-a',{status:'Interested',assignedEmployee:'Person',feedback:'New feedback'})).rejects.toThrow(/changed outside/);
    expect(paste).not.toHaveBeenCalled();expect(rows).toEqual(before);
  });
  it('does not write to another lead when the original row is missing',async()=>{
    const {sheet,rows}=await fixture();rows.splice(2,1);
    await expect(writePublicSheet(sheet,'public-id:source-a',{status:'New',assignedEmployee:'Person',feedback:''})).rejects.toThrow(/deleted or duplicated/);
    expect(rows[1]).toEqual(['source-b','Other','9876543211','keep-b']);
  });
  it('recreates a broken editor browser before retrying queued writes',async()=>{
    const {sheet,rows}=await fixture();const broken={createBrowserContext:vi.fn().mockRejectedValue(new Error('Protocol error: browser disconnected')),once:vi.fn(),close:vi.fn(async()=>{})};
    mocks.launch.mockResolvedValueOnce(broken);vi.spyOn(console,'error').mockImplementation(()=>{});
    const values={status:'Interested',assignedEmployee:'Person',feedback:'Please call tomorrow'};
    await expect(writePublicSheet(sheet,'public-id:source-a',values)).rejects.toMatchObject({code:'PUBLIC_EDITOR'});expect(broken.close).toHaveBeenCalledOnce();
    await writePublicSheet(sheet,'public-id:source-a',values);expect(rows[2].slice(4)).toEqual(['Interested','Person','Please call tomorrow']);
    expect(mocks.launch.mock.calls.at(-1)?.[0].userDataDir).not.toBe(mocks.launch.mock.calls.at(-2)?.[0].userDataDir);
  });
  it('reuses existing headings and escapes feedback as literal cell text',()=>{
    expect(outputColumns([['Name','lead_status','shared_to','Feedback']]).map(c=>[c.field,c.index,c.missing])).toEqual([['status',1,false],['assignedEmployee',2,false],['feedback',3,false]]);
    expect(()=>outputColumns([['lead_status','Lead Status']])).toThrow(/Duplicate/);
    expect(columnName(26)).toBe('AA');expect(columnName(701)).toBe('ZZ');
    expect(sheetPasteText('=HYPERLINK("https://example.com")')).toBe('"\'=HYPERLINK(""https://example.com"")"');
    expect(sheetPasteText('First line\nSecond\t"quoted"')).toBe('"First line\nSecond\t""quoted"""');
  });
  it('places the three outputs together while retaining every source column and cell',()=>{
    for(const headers of [['Name','lead_status','Source A','Source B','shared to','Feedback'],['Feedback','Name','shared to','Source A','lead_status'],['shared to','Feedback','Name','lead_status','Source A']]){
      const rows=[headers.map(h=>h),headers.map(h=>`value for ${h}`)];const source=headers.filter(h=>!['lead_status','shared to','Feedback'].includes(h));let move=nextOutputMove(rows);let steps=0;
      while(move&&steps++<30){for(const row of rows){const cells=row.splice(move.start,move.count);row.splice(move.start+(move.direction==='left'?-1:1),0,...cells);}move=nextOutputMove(rows);}
      expect(move).toBeNull();const columns=outputColumns(rows);expect(columns.map(c=>c.index)).toEqual([columns[0].index,columns[0].index+1,columns[0].index+2]);
      expect(rows[0].filter(h=>source.includes(h))).toEqual(source);for(let i=0;i<rows[0].length;i++)expect(rows[1][i]).toBe(`value for ${rows[0][i]}`);
    }
  });
});
