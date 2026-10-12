import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'puppeteer';
import type { Sheet } from '@/generated/postgres';
import { db } from './db';
import { AppError } from './security';
import { publicCSV, PublicSheetsProvider } from './public-sheets';
import { SIMPLE_OUTPUT_COLUMNS } from './simple-shared';

let browser:Promise<Browser>|undefined;
let writes:Promise<unknown>=Promise.resolve();
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const heading=(value:string)=>value.toLowerCase().replace(/[\s_]+/g,'');
export function columnName(index:number){
  let name='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;
}
export function outputColumns(rows:string[][]){
  const headers=rows[0]?.map(h=>h.trim())||[];
  let next=Math.max(0,...rows.map(row=>row.length));
  return Object.entries(SIMPLE_OUTPUT_COLUMNS).map(([field,label])=>{
    const found=headers.map((h,i)=>heading(h)===heading(label)?i:-1).filter(i=>i>=0);
    if(found.length>1)throw new AppError(409,`Duplicate ${label} columns found. Keep one column with that heading.`);
    return {field,label,index:found[0]??next++,missing:!found.length};
  });
}
export function nextOutputMove(rows:string[][]){
  const columns=outputColumns(rows);if(columns.some(c=>c.missing))return null;
  const status=columns[0].index,owner=columns[1].index,feedback=columns[2].index;
  if(owner!==status+1)return {start:owner,count:feedback===owner+1?2:1,direction:owner>status?'left' as const:'right' as const};
  if(feedback!==owner+1)return {start:feedback,count:1,direction:feedback>owner?'left' as const:'right' as const};
  return null;
}
export function sheetPasteText(value:string){
  const literal=/^[=+\-@]/.test(value)?`'${value}`:value;
  return /[\t\r\n"]/.test(literal)?`"${literal.replace(/"/g,'""')}"`:literal;
}
async function editorBrowser(){
  if(!browser)browser=(async()=>{
    const mod=await import('puppeteer');
    const executablePath=[process.env.CHROME_PATH,...(process.platform==='win32'?['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']:['/usr/bin/chromium','/usr/bin/google-chrome'])].find(p=>p&&existsSync(p));
    const instance=await mod.launch({headless:true,executablePath,userDataDir:path.resolve('data/sheets-editor',String(process.pid),randomUUID()),args:['--disable-dev-shm-usage','--disable-background-timer-throttling',...(process.platform==='linux'?['--no-sandbox','--disable-setuid-sandbox']:[])]});
    instance.once('disconnected',()=>{browser=undefined;const child=instance.process();if(child&&child.exitCode===null&&!child.killed)child.kill();});return instance;
  })().catch(error=>{browser=undefined;throw error;});
  return browser;
}
async function selectRange(page:Page,range:string){
  await page.click('#t-name-box');await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');
  await page.keyboard.type(range);await page.keyboard.press('Enter');
  await pause(120);
}
async function paste(page:Page,range:string,values:string[]){
  await selectRange(page,range);
  await page.evaluate(text=>navigator.clipboard.writeText(text),values.map(sheetPasteText).join('\t'));
  await page.keyboard.down('Control');await page.keyboard.press('KeyV');await page.keyboard.up('Control');await pause(350);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!!document.querySelector('[aria-label*="Document status: Saved"]'),{timeout:20000});
}
async function moveColumns(page:Page,start:number,count:number,direction:'left'|'right'){
  await selectRange(page,`${columnName(start)}:${columnName(start+count-1)}`);
  await page.click('#docs-edit-menu');
  await page.waitForFunction(()=>document.querySelector('#docs-edit-menu')?.getAttribute('aria-expanded')==='true');
  const submenu=await page.evaluate(()=>{const el=Array.from(document.querySelectorAll('.goog-submenu')).find(e=>e.getBoundingClientRect().width>0&&/^Move/.test(e.textContent||''));if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  if(!submenu)throw new AppError(502,'Google Sheets column controls are unavailable. Please retry.');
  await page.mouse.move(submenu.x,submenu.y);
  await page.waitForFunction(direction=>Array.from(document.querySelectorAll('.goog-menuitem')).some(e=>e.getBoundingClientRect().width>0&&new RegExp(`^Columns? ${direction}$`).test(e.textContent?.trim()||'')),{},direction);
  const item=await page.evaluate(direction=>{const el=Array.from(document.querySelectorAll('.goog-menuitem')).find(e=>e.getBoundingClientRect().width>0&&new RegExp(`^Columns? ${direction}$`).test(e.textContent?.trim()||''));if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},direction);
  if(!item)throw new AppError(502,'Google Sheets column controls are unavailable. Please retry.');
  await page.mouse.click(item.x,item.y);await pause(150);
  await page.waitForFunction(()=>!!document.querySelector('[aria-label*="Document status: Saved"]'),{timeout:20000});
}
async function performWrite(sheet:Sheet,stableId:string,values:Record<string,string>){
  const lead=await db.lead.findUniqueOrThrow({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:stableId}}});
  if(lead.sourceDeleted||lead.redactedAt)throw new AppError(409,'The original lead is no longer available for sheet updates.');
  let csv=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);
  let columns=outputColumns(csv);
  const instance=await editorBrowser();const context=await instance.createBrowserContext();
  try{
    await context.overridePermissions('https://docs.google.com',['clipboard-read','clipboard-write','clipboard-sanitized-write']);
    const page=await context.newPage();await page.setViewport({width:1440,height:1000});
    await page.goto(`https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.worksheetId}&hl=en`,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForSelector('#t-name-box',{visible:true,timeout:30000});
    await pause(3000);
    const readOnly=await page.evaluate(()=>!!document.querySelector('[aria-label="View only"], [aria-label="Request edit access"]'));
    if(readOnly)throw new AppError(403,'Set this Google Sheet to Anyone with the link → Editor to save lead feedback.');
    await page.bringToFront();
    for(const column of columns.filter(c=>c.missing))await paste(page,`${columnName(column.index)}1`,[column.label]);
    csv=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);
    if(outputColumns(csv).some(c=>c.missing))throw new AppError(502,'Google has not confirmed the feedback columns yet. The update will be retried.');
    // Move entire output columns through Sheets, preserving all values and
    // source columns, so the requested three headings stay together in order.
    let move=nextOutputMove(csv);let steps=0;
    while(move){
      if(++steps>csv[0].length*3)throw new AppError(502,'Google Sheets could not confirm the output column order. Please retry.');
      const previous=csv[0].join('\t');await moveColumns(page,move.start,move.count,move.direction);
      for(let attempt=0;attempt<10;attempt++){csv=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);if(csv[0].join('\t')!==previous)break;await pause(300);}
      if(csv[0].join('\t')===previous)throw new AppError(502,'Google has not confirmed the column move yet. The update will be retried.');
      move=nextOutputMove(csv);
    }
    columns=outputColumns(csv);
    // Resolve the source identity again after opening the editor. Never use a
    // stale database row number when the source has been sorted or expanded.
    const matches=(await new PublicSheetsProvider().read(sheet)).filter(row=>row.stableId===stableId);
    if(matches.length!==1)throw new AppError(409,'The original lead row was deleted or duplicated. Sheet update stopped.');
    const row=matches[0].row;
    csv=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);
    const snapshot=(lead.managedSnapshot||{}) as Record<string,string>;
    for(const column of columns){
      const actual=csv[row-1]?.[column.index]||'';const expected=snapshot[column.field]||'';const next=values[column.field]||'';
      if(actual!==expected&&actual!==next)throw new AppError(409,`The sheet's ${column.label} changed outside SmartLead. Feedback is saved in the app; review this row before retrying.`,'SYNC_CONFLICT');
    }
    // Group adjacent columns so status, owner and feedback reach Google together.
    const sorted=[...columns].sort((a,b)=>a.index-b.index);
    for(let i=0;i<sorted.length;){
      let end=i+1;while(end<sorted.length&&sorted[end].index===sorted[end-1].index+1)end++;
      await paste(page,`${columnName(sorted[i].index)}${row}`,sorted.slice(i,end).map(c=>values[c.field]||''));i=end;
    }
    let verified=false;
    for(let attempt=0;attempt<10;attempt++){
      const current=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);
      const located=(await new PublicSheetsProvider().read(sheet)).find(r=>r.stableId===stableId);
      if(located&&columns.every(c=>(current[located.row-1]?.[c.index]||'')===(values[c.field]||''))){verified=true;break;}
      await pause(500);
    }
    if(!verified)throw new AppError(502,'Feedback is saved in SmartLead, but Google has not confirmed the sheet update yet. It will be retried.');
  }finally{await context.close();}
}
export async function writePublicSheet(sheet:Sheet,stableId:string,values:Record<string,string>){
  const operation=writes.then(async()=>{
    try{await performWrite(sheet,stableId,values);}
    catch(error){
      if(error instanceof AppError){console.error(JSON.stringify({event:'public_sheet_update_pending',code:error.code,status:error.status}));throw error;}
      console.error(JSON.stringify({event:'public_sheet_editor_retry',type:error instanceof Error?error.constructor.name:'UnknownError',reason:error instanceof Error?error.message.split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]').slice(0,250):'Editor connection failed'}));
      // A broken browser context must not poison every later sheet job.
      await closePublicSheetEditor().catch(()=>{});
      throw new AppError(502,'Google Sheets editor is temporarily unavailable. The sheet update will retry.','PUBLIC_EDITOR');
    }
  });
  writes=operation.catch(()=>{});await operation;
}
export async function closePublicSheetEditor(){const active=browser;browser=undefined;if(active)await(await active).close().catch(()=>{});}
