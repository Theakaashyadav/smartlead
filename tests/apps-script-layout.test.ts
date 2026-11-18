import {createContext,runInContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';
import {appsScriptCode} from '@/lib/apps-script-code';

const spreadsheetId='layout-regression-spreadsheet';
const token='layout-regression-private-key-123456789';
const outputs=['Sent Status','Shared To','Feedback','Remark'];

function fixture(initialRows:string[][],initialMaxColumns=26){
  const rows=initialRows.map(row=>[...row]);
  let maxColumns=initialMaxColumns;
  const maxRows=10;
  const controls={insertError:false};
  const protectedCells=new Set<string>();
  const writes:Array<{row:number;column:number;value:string}>=[];
  const lastColumn=()=>Math.max(1,...rows.map(row=>row.reduce((last,value,index)=>value!==''?index+1:last,0)));
  const editable=(row:number,column:number,height:number,width:number)=>{
    for(let i=row;i<row+height;i++)for(let j=column;j<column+width;j++)if(protectedCells.has(`${i}:${j}`))return false;
    return true;
  };
  const moveColumns=vi.fn(()=>{throw new Error('Cannot move columns in a table or through a merged or protected source range');});
  const insertColumnsAfter=vi.fn((index:number,count:number)=>{
    if(controls.insertError)throw new Error('Sensitive sheet details in Google insertion failure');
    if(index!==maxColumns||count<1)throw new Error('Invalid column insertion');
    maxColumns+=count;
  });
  const range=(row:number|string,column=1,height=1,width=1)=>{
    const rowNumber=typeof row==='string'?Number(row.split(':')[0]):row;
    if(rowNumber<1||rowNumber+height-1>maxRows||column<1||column+width-1>maxColumns)throw new Error('Range exceeds sheet grid');
    const save=(r:number,c:number,value:string)=>{
      if(!editable(r,c,1,1))throw new Error('Protected cell');
      rows[r-1]??=[];
      rows[r-1][c-1]=value;
      writes.push({row:r,column:c,value});
    };
    return {
      getRow:()=>rowNumber,
      canEdit:()=>editable(rowNumber,column,height,width),
      getDisplayValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>rows[rowNumber-1+i]?.[column-1+j]||'')),
      setValue:(value:string)=>save(rowNumber,column,value),
      setValues:(values:string[][])=>values.forEach((valuesRow,i)=>valuesRow.forEach((value,j)=>save(rowNumber+i,column+j,value))),
      setRichTextValue:(value:{text:string})=>save(rowNumber,column,value.text),
      clearContent:()=>save(rowNumber,column,''),
      addDeveloperMetadata:()=>{},
    };
  };
  const finder=()=>({withKey(){return this;},withValue(){return this;},find(){return [];}});
  const tab={
    getSheetId:()=>42,getName:()=> 'Incoming',getLastColumn:lastColumn,getMaxColumns:()=>maxColumns,getMaxRows:()=>maxRows,
    getDataRange:()=>({getDisplayValues:()=>rows.map(row=>Array.from({length:lastColumn()},(_,i)=>row[i]||''))}),
    getRange:range,moveColumns,insertColumnsAfter,createDeveloperMetadataFinder:finder,
  };
  const book={getName:()=> 'Lead source',getSheets:()=>[tab],addDeveloperMetadata:()=>{},createDeveloperMetadataFinder:finder};
  const context=createContext({
    SpreadsheetApp:{openById:()=>book,DeveloperMetadataVisibility:{DOCUMENT:'DOCUMENT'},flush:()=>{},newRichTextValue:()=>({text:'',setText(value:string){this.text=value;return this;},build(){return {text:this.text};}})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock:()=>{}})},
    Utilities:{getUuid:()=> 'check'},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:(text:string)=>({text,setMimeType(){return this;}})},
  });
  runInContext(appsScriptCode(spreadsheetId,token),context);
  const post=(action:string,data:Record<string,unknown>={})=>{
    context.INPUT=JSON.stringify({action,token,spreadsheetId,worksheetId:42,...data});
    return JSON.parse(runInContext('doPost({postData:{contents:INPUT}})',context).text);
  };
  const write=(values:Record<string,string>,snapshot:Record<string,string>={})=>post('write',{
    stableId:'public-id:a',metadataKey:'smartlead_script_legacy_42',identity:[{column:'ID',value:'a'}],values,snapshot,
  });
  return {rows,writes,post,write,controls,protectedCells,moveColumns,insertColumnsAfter};
}

describe('Apps Script output layout without structural column moves',()=>{
  it('connects and writes interleaved output columns while preserving source data and existing column positions',()=>{
    const headers=['ID','Sent Status','Name','Remark','Phone','Shared To','Budget','Feedback','Unmanaged formula'];
    const f=fixture([headers,['a','','Customer A','Prior remark','9876543210','','Keep A','','=SUM(1,2)'],['b','Sent','Customer B','Keep B','9876543211','Other owner','Keep budget','Interested','=SUM(3,4)']]);
    const source=f.rows.map(row=>[...row]);
    // A protected source cell must not prevent edits to the four output columns.
    f.protectedCells.add('2:7');
    expect(f.post('check',{challenge:'current-check'})).toMatchObject({ok:true,data:{codeVersion:3,challenge:'current-check'}});
    expect(f.post('prepare')).toMatchObject({ok:true,data:{canWriteOutputs:true}});
    expect(f.rows).toEqual(source);
    const values={sentStatus:'Sent',sharedTo:'Owner',status:'Interested',feedback:'=literal remark'};
    expect(f.write(values,{feedback:'Prior remark'})).toMatchObject({ok:true,data:{values}});
    expect(f.rows[0]).toEqual(headers);
    expect(f.rows[1]).toEqual(['a','Sent','Customer A','=literal remark','9876543210','Owner','Keep A','Interested','=SUM(1,2)']);
    expect(f.rows[2]).toEqual(source[2]);
    expect(f.moveColumns).not.toHaveBeenCalled();
    expect(f.insertColumnsAfter).not.toHaveBeenCalled();
  });

  it('appends only missing headings after all source data, including a column without a heading',()=>{
    const f=fixture([['ID','Shared To','Name','Phone','Sent Status',''],['a','Owner','Customer','9876543210','Sent','Unheaded source value']]);
    const source=f.rows.map(row=>row.slice(0,6));
    expect(f.post('prepare')).toMatchObject({ok:true});
    expect(f.rows[0]).toEqual(['ID','Shared To','Name','Phone','Sent Status','','Feedback','Remark']);
    expect(f.rows.map(row=>row.slice(0,6))).toEqual(source);
    expect(f.write({status:'Interested',feedback:'Call tomorrow'})).toMatchObject({ok:true,data:{values:{sentStatus:'Sent',sharedTo:'Owner',status:'Interested',feedback:'Call tomorrow'}}});
    expect(f.rows[1].slice(0,6)).toEqual(source[1]);
    expect(f.moveColumns).not.toHaveBeenCalled();
  });

  it('adds grid capacity when the source already fills its final available column',()=>{
    const f=fixture([['ID','Name','Phone','Notes'],['a','Customer','9876543210','Keep source']],4);
    expect(f.post('prepare')).toMatchObject({ok:true});
    expect(f.insertColumnsAfter).toHaveBeenCalledExactlyOnceWith(4,4);
    expect(f.rows[0]).toEqual(['ID','Name','Phone','Notes',...outputs]);
    expect(f.rows[1]).toEqual(['a','Customer','9876543210','Keep source']);
    expect(f.write({sentStatus:'Sent',sharedTo:'Owner'})).toMatchObject({ok:true,data:{values:{sentStatus:'Sent',sharedTo:'Owner'}}});
    expect(f.moveColumns).not.toHaveBeenCalled();
  });

  it('preserves legacy feedback as Remark and adds a separate Feedback heading without moving columns',()=>{
    const f=fixture([['ID','Name','Phone','lead_status','Feedback'],['a','Customer','9876543210','New','Original free-text remark']]);
    expect(f.post('prepare')).toMatchObject({ok:true});
    expect(f.rows[0]).toEqual(['ID','Name','Phone','lead_status','Remark','Sent Status','Shared To','Feedback']);
    expect(f.rows[1]).toEqual(['a','Customer','9876543210','New','Original free-text remark']);
    expect(f.write({sentStatus:'Sent',sharedTo:'Owner',status:'Interested',feedback:'Updated remark'},{feedback:'Original free-text remark'})).toMatchObject({ok:true});
    expect(f.rows[1]).toEqual(['a','Customer','9876543210','New','Updated remark','Sent','Owner','Interested']);
    expect(f.moveColumns).not.toHaveBeenCalled();
  });

  it('reports a protected existing output column without changing customer or output values',()=>{
    const f=fixture([['ID','Name','Phone',...outputs],['a','Customer','9876543210','Sent','Owner','Interested','Keep remark']]);
    f.protectedCells.add('2:7');
    const before=f.rows.map(row=>[...row]);
    expect(f.post('prepare')).toMatchObject({ok:false,code:'PROTECTED'});
    expect(f.write({feedback:'Attempted overwrite'},{feedback:'Keep remark'})).toMatchObject({ok:false,code:'PROTECTED'});
    expect(f.rows).toEqual(before);
    expect(f.moveColumns).not.toHaveBeenCalled();
  });

  it('reports a protected destination for missing headings without overwriting source columns',()=>{
    const f=fixture([['ID','Name','Phone','Notes'],['a','Customer','9876543210','Keep source']]);
    f.protectedCells.add('1:6');
    const before=f.rows.map(row=>[...row]);
    expect(f.post('prepare')).toMatchObject({ok:false,code:'PROTECTED'});
    expect(f.rows).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.moveColumns).not.toHaveBeenCalled();
  });

  it('identifies a rejected grid expansion as a layout failure without exposing source details or writing cells',()=>{
    const f=fixture([['ID','Name','Phone','Notes'],['a','Customer','9876543210','Keep source']],4);
    f.controls.insertError=true;
    const before=f.rows.map(row=>[...row]);
    const reply=f.post('prepare');
    expect(reply).toMatchObject({ok:false,code:'LAYOUT'});
    expect(JSON.stringify(reply)).not.toContain('Sensitive');
    expect(f.rows).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.moveColumns).not.toHaveBeenCalled();
  });

  it('rejects duplicate output headings before writing headings or lead values',()=>{
    const f=fixture([['ID','Name','Phone','Feedback','feedback'],['a','Customer','9876543210','Keep first','Keep second']]);
    const before=f.rows.map(row=>[...row]);
    expect(f.post('prepare')).toMatchObject({ok:false,code:'DUPLICATE_OUTPUT'});
    expect(f.rows).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.write({sentStatus:'Sent'})).toMatchObject({ok:false,code:'DUPLICATE_OUTPUT'});
    expect(f.rows).toEqual(before);
    expect(f.moveColumns).not.toHaveBeenCalled();
  });
});
