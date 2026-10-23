'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, LogOut, MessageCircle, Pause, Play, Plus, RefreshCw, Search, Trash2, Users, X } from 'lucide-react';
import { api, Button, Field, Modal, Select } from './ui';
import { detectColumns, type WhatsAppContact } from '@/lib/simple-shared';
import { WhatsAppBrowserLogin } from './whatsapp-browser-login';
import { WhatsAppBackgroundLogin } from './whatsapp-background-login';
import { PhoneLoginSettings } from './phone-login-settings';

type SheetSummary={id:string;name:string;worksheetName:string;lastSyncAt:string|null;lastSyncError:string|null;pollInterval?:number;leadCount:number;enabled:boolean;recipients:WhatsAppContact[];delivery?:{submitted:number;queued:number;failed:number;error:string|null}};
type Account={id:string;phone:string|null;status:string;qrCode:string|null;lastError:string|null};
type State={user:{name:string;email:string|null;phone?:string|null;pinEnabled?:boolean;twoFactor?:boolean};organization:{id:string;name:string};account:Account|null;sheets:SheetSummary[];workerRunning:boolean;workerMessage?:string|null;whatsappLoginMode?:'background'|'browser'|'qr';feedbackError?:string|null;publicSheetWritebackAvailable?:boolean};
type Inspection={spreadsheetId:string;title:string;gid?:number;tabs:{id:number;name:string;headers:string[]}[]};
const message=(e:unknown)=>e instanceof Error?e.message:'Please try again.';

export function SimpleApp(){
  const pathname=usePathname();const router=useRouter();
  const [state,setState]=useState<State|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const [connectOpen,setConnectOpen]=useState(false);const [recipientSheet,setRecipientSheet]=useState<string|null>(null);
  const [loginSettings,setLoginSettings]=useState(false);
  const [deletingSheet,setDeletingSheet]=useState<SheetSummary|null>(null);
  const closeDelete=useCallback(()=>setDeletingSheet(null),[]);
  const closeConnect=useCallback(()=>setConnectOpen(false),[]);const closeRecipients=useCallback(()=>setRecipientSheet(null),[]);
  const reload=useCallback(async()=>{const result=await api<State>('simple/state');setState(result);return result;},[]);
  useEffect(()=>{let active=true;const refresh=()=>api<State>('simple/state').then(s=>{if(active)setState(s);}).catch(e=>{if(active)setError(message(e));});refresh();const timer=setInterval(refresh,5000);return()=>{active=false;clearInterval(timer);};},[]);
  async function action(path:string,method='POST',body?:unknown){setBusy(true);setError('');try{await api(`simple/${path}`,method,body);await reload();}catch(e){setError(message(e));}finally{setBusy(false);}}
  const account=state?.account;const connected=account?.status==='CONNECTED';
  const currentSheet=state?.sheets.find(s=>s.id===recipientSheet);
  const section=pathname==='/sheets'?'sheets':pathname==='/whatsapp'?'whatsapp':'dashboard';
  return <div className="simple-app">
    <header className="simple-header"><Link className="simple-brand" href="/dashboard"><span><ArrowRight size={21}/></span>SmartLead</Link><nav aria-label="Main navigation"><Link href="/dashboard" aria-current={section==='dashboard'?'page':undefined}>Dashboard</Link><Link href="/sheets" aria-current={section==='sheets'?'page':undefined}>Sheets</Link><Link href="/whatsapp" aria-current={section==='whatsapp'?'page':undefined}>WhatsApp</Link></nav><Button variant="ghost" aria-label="Sign out" onClick={async()=>{await api('auth/logout','POST');window.location.assign('/login');}}><LogOut size={17}/><span>Sign out</span></Button></header>
    <main className="simple-main">
      {state&&<div className="simple-organization" aria-label="Current organisation"><strong>{state.organization.name}</strong><span>{state.user.name} · {state.user.phone?.replace(/^\+91(?=\d{10}$)/,'')||state.user.email}</span><Button variant="ghost" onClick={()=>setLoginSettings(true)}>Login & PIN</Button></div>}
      {state&&loginSettings&&<PhoneLoginSettings user={state.user} onClose={()=>setLoginSettings(false)} onSaved={reload}/>}
      {error&&<div role="alert" className="alert error">{error}<button onClick={()=>setError('')} aria-label="Dismiss error"><X size={16}/></button></div>}
      {!state?<p className="simple-loading">Loading your workspace…</p>:<>
        {section==='dashboard'&&<><div className="simple-intro"><span className="simple-kicker">SHEETS → WHATSAPP</span><h1>Your leads. Sent automatically.</h1><p>Connect your sheets, link WhatsApp, and choose who receives each lead.</p></div><div className="simple-cards">
          <Link href="/sheets" className="simple-connect-card"><div className="simple-card-icon sheets"><FileSpreadsheet size={30}/></div><h2>Connect Sheets</h2><p>Add one or more Google Sheets.<br/>Choose recipients for each sheet.</p><div className="simple-card-bottom"><span>{state.sheets.length?`${state.sheets.length} sheet${state.sheets.length===1?'':'s'} connected`:'No sheets connected'}</span><ArrowRight size={22}/></div></Link>
          <Link href="/whatsapp" className="simple-connect-card"><div className="simple-card-icon whatsapp"><MessageCircle size={30}/></div><h2>Connect WhatsApp</h2><p>Scan one QR code to link your account.<br/>Use its contacts to send your leads.</p><div className="simple-card-bottom"><span className={connected?'simple-connected':''}>{connected?`Connected ${account?.phone||''}`:'Link your WhatsApp account'}</span><ArrowRight size={22}/></div></Link>
        </div><div className="simple-how"><span>1. Connect</span><ArrowRight size={15}/><span>2. Choose people</span><ArrowRight size={15}/><span>3. Leads go out, one by one</span></div>{state.sheets.length>0&&<section className="simple-dashboard-sheets" aria-label="Connected sheets"><div className="simple-page-heading"><h2>Your connected sheets</h2><Link className="inline-link" href="/sheets">Manage sheets<ArrowRight size={15}/></Link></div><SheetCards sheets={state.sheets} connected={connected} busy={busy} onRecipients={setRecipientSheet} onToggle={sheet=>action(`sheets/${sheet.id}/pause`,'PUT',{enabled:!sheet.enabled})} onDelete={setDeletingSheet}/></section>}</>}
        {section==='sheets'&&<><div className="simple-page-heading"><div><Link className="simple-back" href="/dashboard"><ArrowLeft size={15}/>Dashboard</Link><h1>Your Google Sheets</h1><p>Each new lead goes to the next selected person, then the order repeats.</p></div><Button variant="primary" onClick={()=>setConnectOpen(true)}><Plus size={17}/>{state.sheets.length?'Connect another sheet':'Connect sheet'}</Button></div>
          {!connected&&<Link className="simple-connect-notice" href="/whatsapp"><MessageCircle size={19}/><span>Connect WhatsApp to see your contacts and start sending.</span><ArrowRight size={18}/></Link>}
          {state.feedbackError&&<p role="alert" className="alert info">{state.feedbackError} Your leads remain queued.</p>}
          {state.publicSheetWritebackAvailable===false&&state.sheets.length>0&&<p className="alert info">Feedback is saved in SmartLead. Automatic feedback updates to public Google Sheets are unavailable with this connection.</p>}
          {!state.sheets.length?<div className="simple-empty"><FileSpreadsheet size={42}/><h2>Connect your first sheet</h2><p>Paste a Google Sheets link. You can add more sheets whenever you need.</p><Button variant="primary" onClick={()=>setConnectOpen(true)}><Plus size={16}/>Connect sheet</Button></div>:<SheetCards sheets={state.sheets} connected={connected} busy={busy} onRecipients={setRecipientSheet} onToggle={sheet=>action(`sheets/${sheet.id}/pause`,'PUT',{enabled:!sheet.enabled})} onDelete={setDeletingSheet}/>}
        </>}
        {section==='whatsapp'&&<><div className="simple-page-heading"><div><Link className="simple-back" href="/dashboard"><ArrowLeft size={15}/>Dashboard</Link><h1>Your WhatsApp</h1><p>One account for all your connected sheets.</p></div></div><section className="simple-whatsapp-panel">
          {state.whatsappLoginMode==='background'||state.whatsappLoginMode==='qr'?<WhatsAppBackgroundLogin account={account} busy={busy} workerRunning={state.workerRunning} onConnect={()=>action('whatsapp/connect')} onDisconnect={()=>action('whatsapp/disconnect')}/>:<WhatsAppBrowserLogin account={account} busy={busy} workerRunning={state.workerRunning} onConnect={()=>action('whatsapp/connect')} onDisconnect={()=>action('whatsapp/disconnect')}/>}
        </section></>}
        {!state.workerRunning&&(section==='whatsapp'||state.sheets.some(s=>s.enabled)||account&&account.status!=='DISCONNECTED')&&<p role="status" className="simple-worker-note">{state.workerMessage||'WhatsApp connection service is offline. Please try again after it restarts.'}</p>}
      </>}
    </main>
    {connectOpen&&<ConnectSheet onClose={closeConnect} onConnected={async id=>{setConnectOpen(false);await reload();setRecipientSheet(id);router.push('/sheets');}}/>}
    {deletingSheet&&<DeleteSheet sheet={deletingSheet} onClose={closeDelete} onDeleted={()=>{setState(current=>current?{...current,sheets:current.sheets.filter(sheet=>sheet.id!==deletingSheet.id)}:current);if(recipientSheet===deletingSheet.id)setRecipientSheet(null);setDeletingSheet(null);void reload().catch(e=>setError(message(e)));}}/>}
    {currentSheet&&<RecipientPicker sheet={currentSheet} connected={connected} onClose={closeRecipients} onSaved={async()=>{setRecipientSheet(null);await reload();}}/>}
  </div>;
}

function SheetCards({sheets,connected,busy,onRecipients,onToggle,onDelete}:{sheets:SheetSummary[];connected:boolean;busy:boolean;onRecipients:(id:string)=>void;onToggle:(sheet:SheetSummary)=>void;onDelete:(sheet:SheetSummary)=>void}){
  return <div className="simple-sheet-list">{sheets.map(sheet=><article className="simple-sheet" key={sheet.id}><div className="simple-sheet-top"><div className="simple-card-icon sheets"><FileSpreadsheet size={24}/></div><div className="simple-sheet-title"><h2>{sheet.name}</h2><p>{sheet.worksheetName}</p></div><span className={`simple-status ${sheet.enabled&&connected?'on':''}`}>{sheet.enabled?(sheet.delivery?.failed?'Some sends need checking':connected?'Sending automatically':'Waiting for WhatsApp'):sheet.recipients.length?'Paused':'Choose recipients'}</span></div><div className="simple-sheet-people"><Users size={17}/><span>{sheet.recipients.length?sheet.recipients.map(p=>p.name).join(' → '):'No recipients selected'}</span>{sheet.recipients.length>1&&<span className="muted">→ repeat</span>}</div>{sheet.lastSyncError&&<p className="alert error">{sheet.lastSyncError}</p>}{sheet.delivery&&<p className="muted">{sheet.delivery.submitted} submitted to WhatsApp · {sheet.delivery.queued} queued{sheet.delivery.failed?` · ${sheet.delivery.failed} need checking`:""}</p>}{sheet.delivery?.error&&<p role="alert" className="alert error">{sheet.delivery.error}</p>}<div className="simple-sheet-bottom"><span className="muted">{sheet.leadCount} lead{sheet.leadCount===1?'':'s'} imported{sheet.enabled?` · Checks for new leads every ${sheet.pollInterval||5} seconds`:''}</span><div className="row"><Button onClick={()=>onRecipients(sheet.id)}><Users size={15}/>{sheet.recipients.length?'Edit recipients':'Choose recipients'}</Button>{sheet.recipients.length>0&&<Button busy={busy} onClick={()=>onToggle(sheet)}>{sheet.enabled?<Pause size={15}/>:<Play size={15}/>} {sheet.enabled?'Pause':'Resume'}</Button>}<Button variant="danger" disabled={busy} aria-label={`Delete ${sheet.name}`} onClick={()=>onDelete(sheet)}><Trash2 size={15}/>Delete sheet</Button></div></div></article>)}</div>;
}

function DeleteSheet({sheet,onClose,onDeleted}:{sheet:SheetSummary;onClose:()=>void;onDeleted:()=>void}){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const close=useCallback(()=>{if(!busy)onClose();},[busy,onClose]);
  async function remove(){
    setBusy(true);setError('');
    try{await api(`simple/sheets/${sheet.id}`,'DELETE');onDeleted();}
    catch(e){setError(message(e));setBusy(false);}
  }
  return <Modal title="Delete sheet?" description={`${sheet.name} · ${sheet.worksheetName}`} onClose={close}>
    <div className="simple-delete-sheet">
      <p>This permanently removes this connection, its imported leads, messages, and feedback from SmartLead. Automatic sending for this sheet will stop.</p>
      <p>Your original Google Sheet stays unchanged.</p>
      {error&&<p role="alert" className="alert error">{error}</p>}
      <div className="row"><Button disabled={busy} onClick={close}>Cancel</Button><Button variant="danger" busy={busy} onClick={remove}><Trash2 size={16}/>Delete sheet</Button></div>
    </div>
  </Modal>;
}

function ConnectSheet({onClose,onConnected}:{onClose:()=>void;onConnected:(id:string)=>Promise<void>}){
  const [url,setUrl]=useState('');const [info,setInfo]=useState<Inspection|null>(null);const [tabId,setTabId]=useState(0);const [mapping,setMapping]=useState<Record<string,string>>({});const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const tab=info?.tabs.find(t=>t.id===tabId);
  async function inspect(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{const data=await api<Inspection>('simple/sheets/inspect','POST',{url});if(!data.tabs.length)throw new Error('This spreadsheet has no tabs.');setInfo(data);const selected=data.tabs.find(t=>t.id===data.gid)||data.tabs[0];setTabId(selected.id);setMapping(detectColumns(selected.headers));}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function connect(e:React.FormEvent){e.preventDefault();if(!info)return;setBusy(true);setError('');try{const data=await api<{id:string}>('simple/sheets','POST',{spreadsheetId:info.spreadsheetId,worksheetId:tabId,columnMapping:mapping});await onConnected(data.id);}catch(e){setError(message(e));}finally{setBusy(false);}}
  return <Modal title="Connect Google Sheet" description="Add a sheet, then choose who gets its leads." onClose={onClose}>
    {error&&<div role="alert" className="alert error">{error}</div>}
    {!info?<form className="simple-form" onSubmit={inspect}>
      <p className="simple-share-note">Set your sheet to “Anyone with the link” → Editor, then paste its link below.</p>
      <Field label="Google Sheets link"><input type="url" required value={url} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={e=>setUrl(e.target.value)} autoFocus/></Field><Button type="submit" variant="primary" busy={busy}>Continue<ArrowRight size={16}/></Button>
    </form>:<form className="simple-form" onSubmit={connect}>
      <div className="simple-found-sheet"><FileSpreadsheet size={22}/><strong>{info.title}</strong><button type="button" onClick={()=>setInfo(null)}>Change</button></div>
      {info.tabs.length>1&&<Field label="Sheet tab"><Select value={tabId} onChange={e=>{const id=Number(e.target.value);setTabId(id);setMapping(detectColumns(info.tabs.find(t=>t.id===id)!.headers));}}>{info.tabs.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>}
      <div className="simple-column-fields">{[['customerName','Customer name column'],['mobile','Phone number column']].map(([key,label])=><Field key={key} label={label}><Select required value={mapping[key]||''} onChange={e=>setMapping(m=>({...m,[key]:e.target.value}))}><option value="">Choose column</option>{tab?.headers.filter(Boolean).map((h,i)=><option key={`${h}-${i}`} value={h}>{h}</option>)}</Select></Field>)}</div>
      <p className="simple-share-note">Existing leads will start sending when you choose recipients.</p>
      <Button type="submit" variant="primary" busy={busy} disabled={!mapping.customerName||!mapping.mobile}>Connect sheet<ArrowRight size={16}/></Button>
    </form>}
  </Modal>;
}

function RecipientPicker({sheet,connected,onClose,onSaved}:{sheet:SheetSummary;connected:boolean;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [contacts,setContacts]=useState<WhatsAppContact[]>([]);const [selected,setSelected]=useState<WhatsAppContact[]>(sheet.recipients);const [search,setSearch]=useState('');const [phone,setPhone]=useState('');const [name,setName]=useState('');const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  useEffect(()=>{if(!connected){setLoading(false);return;}let active=true;const fetchContacts=()=>api<{contacts:WhatsAppContact[];error?:string}>('simple/contacts').then(data=>{if(active){setContacts(data.contacts);setLoading(false);if(data.error)setError(data.error);}}).catch(e=>{if(active){setError(message(e));setLoading(false);}});fetchContacts();api('simple/contacts/refresh','POST').catch(e=>{if(active)setError(message(e));});const timer=setInterval(fetchContacts,4000);return()=>{active=false;clearInterval(timer);};},[connected]);
  function toggle(person:WhatsAppContact){setSelected(s=>s.some(p=>p.phone===person.phone)?s.filter(p=>p.phone!==person.phone):[...s,person]);}
  function addNumber(){const value=phone.trim();if(!/^\+?[\d\s()-]{7,25}$/.test(value)){setError('Enter a valid phone number, including country code.');return;}const digits=value.replace(/\D/g,'');const number=value.startsWith('+')?`+${digits}`:digits.length===10?`+91${digits}`:`+${digits}`;if(selected.some(p=>p.phone===number)){setError('This number is already selected.');return;}const person={name:name.trim()||number,phone:number};setSelected(s=>[...s,person]);setPhone('');setName('');setError('');}
  async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await api(`simple/sheets/${sheet.id}/recipients`,'PUT',{recipients:selected});await onSaved();}catch(e){setError(message(e));}finally{setBusy(false);}}
  const people=[...contacts,...selected.filter(s=>!contacts.some(c=>c.phone===s.phone))].filter(c=>`${c.name} ${c.phone}`.toLowerCase().includes(search.toLowerCase()));
  return <Modal title="Who should receive these leads?" description={`${sheet.name} · ${sheet.worksheetName}`} onClose={onClose}>
    {!connected?<div className="simple-modal-empty"><MessageCircle size={36}/><h3>Connect WhatsApp first</h3><p>Your WhatsApp contacts will appear here after you link your account.</p><Link href="/whatsapp" className="btn primary" onClick={onClose}>Connect WhatsApp<ArrowRight size={16}/></Link></div>:<form className="simple-form" onSubmit={save}>
      {error&&<div role="alert" className="alert error">{error}</div>}
      <div className="simple-recipient-search"><Search size={17}/><input aria-label="Search WhatsApp contacts" placeholder="Search name or number" value={search} onChange={e=>setSearch(e.target.value)}/><Button type="button" variant="ghost" aria-label="Refresh contacts" onClick={async()=>{setError('');try{await api('simple/contacts/refresh','POST');}catch(e){setError(message(e));}}}><RefreshCw size={16}/></Button></div>
      <div className="simple-contact-list">{loading?<p>Loading WhatsApp contacts…</p>:people.length?people.map(person=>{const order=selected.findIndex(p=>p.phone===person.phone);return <label key={person.phone} className={`simple-contact ${order>=0?'selected':''}`}><input type="checkbox" checked={order>=0} onChange={()=>toggle(person)}/><span className="simple-contact-avatar">{(person.name[0]||'#').toUpperCase()}</span><span><strong>{person.name}</strong><small>{person.phone}</small></span>{order>=0&&<span className="simple-contact-order">{order+1}</span>}</label>;}):<p>{search?'No matching contacts. Add the number below.':'Your contacts will appear here. You can also add a number below.'}</p>}</div>
      <div className="simple-add-number"><h3>Number not listed? Add it here.</h3><div><input aria-label="Recipient name" placeholder="Name (optional)" value={name} maxLength={100} onChange={e=>setName(e.target.value)}/><input aria-label="Recipient phone number" placeholder="+91 phone number" type="tel" value={phone} onChange={e=>setPhone(e.target.value)}/><Button type="button" onClick={addNumber} disabled={!phone.trim()}><Plus size={16}/>Add</Button></div><small>A new conversation starts automatically when their first lead is sent.</small></div>
      {selected.length>0&&<div className="simple-selected-order"><strong>{selected.length} selected</strong><p>{selected.map(p=>p.name).join(' → ')}{selected.length>1?' → repeat':''}</p></div>}
      <Button type="submit" variant="primary" busy={busy} disabled={!selected.length}><Check size={17}/>Save & start sending</Button><p className="simple-fine-print">One lead per person, in the selected order. New leads are checked every minute.</p>
    </form>}
  </Modal>;
}
