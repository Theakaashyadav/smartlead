'use client';
import {useEffect,useState} from 'react';
import {ArrowRight,Check,Copy,ExternalLink,FileSpreadsheet} from 'lucide-react';
import {api,Button,Field,Modal,Select} from './ui';
import {detectColumns,spreadsheetIdentity} from '@/lib/simple-shared';

type Setup={setupId:string;code:string;sheetUrl:string;endpoint?:string};
type Inspection={spreadsheetId:string;title:string;gid?:number;scriptSetupId:string;canRead:boolean;canWrite:boolean;tabs:{id:number;name:string;headers:string[]}[]};
export function ConnectSheet({initialSheet,onClose,onConnected}:{initialSheet:{id:string;name:string}|null;onClose:()=>void;onConnected:(id:string,reauthorized?:boolean)=>Promise<void>}){
  const [url,setUrl]=useState('');const [setup,setSetup]=useState<Setup|null>(null);const [endpoint,setEndpoint]=useState('');const [info,setInfo]=useState<Inspection|null>(null);
  const [tabId,setTabId]=useState(0);const [mapping,setMapping]=useState<Record<string,string>>({});const [busy,setBusy]=useState(!!initialSheet);const [error,setError]=useState('');const [copied,setCopied]=useState(false);
  const message=(error:unknown)=>error instanceof Error?error.message:'Please try again.';
  useEffect(()=>{
    if(!initialSheet)return;let active=true;
    api<Setup>('simple/sheets/script','POST',{sheetId:initialSheet.id}).then(result=>{if(active){setSetup(result);setEndpoint(result.endpoint||'');}}).catch(error=>{if(active)setError(message(error));}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[initialSheet]);
  async function prepare(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{spreadsheetIdentity(url);setSetup(await api<Setup>('simple/sheets/script','POST',{url}));}catch(error){setError(message(error));}finally{setBusy(false);}}
  async function copy(){try{await navigator.clipboard.writeText(setup!.code);setCopied(true);}catch{setError('Select the code below and copy it manually.');}}
  async function check(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{const result=await api<Inspection>('simple/sheets/script/check','POST',{setupId:setup!.setupId,endpoint});const selected=result.tabs.find(t=>t.id===result.gid)||result.tabs[0];setInfo(result);setTabId(selected.id);setMapping(detectColumns(selected.headers));}catch(error){setError(message(error));}finally{setBusy(false);}}
  async function connect(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{const result=await api<{id:string;reauthorized?:boolean}>('simple/sheets','POST',{scriptSetupId:info!.scriptSetupId,spreadsheetId:info!.spreadsheetId,worksheetId:tabId,columnMapping:mapping});await onConnected(result.id,result.reauthorized);}catch(error){setError(message(error));}finally{setBusy(false);}}
  const tab=info?.tabs.find(t=>t.id===tabId);
  return <Modal title={initialSheet?'Connect Apps Script':'Connect Google Sheet'} description={initialSheet?initialSheet.name:'Paste the link, install the script, then check the connection.'} onClose={onClose}>
    {error&&<div role="alert" className="alert error">{error}</div>}
    {!setup?<form className="simple-form" onSubmit={prepare}>
      <p className="simple-share-note">Connect your sheet using Apps Script. Your sheet can stay private.</p>
      <Field label="Google Sheets link"><input type="url" required value={url} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={e=>setUrl(e.target.value)} autoFocus/></Field>
      <Button type="submit" variant="primary" busy={busy}>Continue<ArrowRight size={16}/></Button>
    </form>:!info?<form className="simple-form" onSubmit={check}>
      <ol className="simple-script-steps">
        <li><a href={setup.sheetUrl} target="_blank" rel="noopener noreferrer">Open your Google Sheet <ExternalLink size={13}/></a>, then choose <strong>Extensions → Apps Script</strong>.</li>
        <li>Copy the code below, replace the contents of <strong>Code.gs</strong>, and save.</li>
        <li>Choose <strong>Deploy → New deployment → Web app</strong>. Set <strong>Execute as: Me</strong> and <strong>Who has access: Anyone</strong>. Authorize and deploy.</li>
        <li>Copy the <strong>Web app URL</strong> ending in <strong>/exec</strong> and paste it below.</li>
      </ol>
      <div><Button type="button" onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'Code copied':'Copy Apps Script code'}</Button></div>
      <Field label="Apps Script code"><textarea readOnly spellCheck={false} rows={10} value={setup.code} className="simple-script-code" onFocus={e=>e.currentTarget.select()}/></Field>
      <p className="simple-share-note">Keep this code private. It contains the connection key for this sheet. For an existing script, save the code, then choose Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy. Saving alone does not update the live web app.</p>
      <Field label="Apps Script web app URL"><input type="url" required value={endpoint} placeholder="https://script.google.com/macros/s/…/exec" onChange={e=>setEndpoint(e.target.value)}/></Field>
      <Button type="submit" variant="primary" busy={busy}>Check connection<ArrowRight size={16}/></Button>
    </form>:<form className="simple-form" onSubmit={connect}>
      <div className="simple-found-sheet"><FileSpreadsheet size={22}/><strong>{info.title}</strong><button type="button" onClick={()=>setInfo(null)}>Check again</button></div>
      <p role="status" className="simple-share-note">Connection checked: read and write access confirmed.</p>
      {info.tabs.length>1&&<Field label="Sheet tab"><Select value={tabId} disabled={!!initialSheet} onChange={e=>{const id=Number(e.target.value);setTabId(id);setMapping(detectColumns(info.tabs.find(t=>t.id===id)!.headers));}}>{info.tabs.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>}
      {!initialSheet&&<div className="simple-column-fields">{[['customerName','Customer name column'],['mobile','Phone number column']].map(([key,label])=><Field key={key} label={label}><Select required value={mapping[key]||''} onChange={e=>setMapping(m=>({...m,[key]:e.target.value}))}><option value="">Choose column</option>{tab?.headers.filter(Boolean).map((h,i)=><option key={`${h}-${i}`} value={h}>{h}</option>)}</Select></Field>)}</div>}
      <p className="simple-share-note">{initialSheet?'Existing leads, recipients and sending history will be kept.':'Existing leads will start sending when you choose recipients.'}</p>
      <Button type="submit" variant="primary" busy={busy} disabled={!initialSheet&&(!mapping.customerName||!mapping.mobile)}>{initialSheet?'Save connection':'Connect sheet'}<ArrowRight size={16}/></Button>
    </form>}
  </Modal>;
}
