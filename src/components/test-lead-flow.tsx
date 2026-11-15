'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Circle, LoaderCircle, MessageCircle, Plus, Send, TriangleAlert, X } from 'lucide-react';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { TestLeadFlow as TestFlow } from '@/lib/test-lead-flow';
import type { WhatsAppContact } from '@/lib/simple-shared';
import { api, Button, Field, Modal } from './ui';

type Step='recipients'|'executive'|'owner'|'progress';
type Draft={requestId:string;step:Step;recipients:WhatsAppContact[];executiveNotificationPhone:string;notificationPhone:string;run:TestFlow|null;watchId:string|null;savedAt:number};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'Please try again.';
const terminal=(run:TestFlow|null)=>!!run&&['COMPLETED','FAILED','UNCERTAIN'].includes(run.status);
const storageKey=(organizationId:string)=>`smartlead:test-flow:${organizationId}`;
const newDraft=():Draft=>({requestId:crypto.randomUUID(),step:'recipients',recipients:[],executiveNotificationPhone:'',notificationPhone:'',run:null,watchId:null,savedAt:Date.now()});
function restoreDraft(organizationId:string):Draft{
  try{
    const value=JSON.parse(sessionStorage.getItem(storageKey(organizationId))||'null') as Draft|null;
    if(value&&typeof value.requestId==='string'&&Array.isArray(value.recipients)&&Date.now()-value.savedAt<86400000)return value;
  }catch{}
  return newDraft();
}
function normalizePhone(value:string){const phone=parsePhoneNumberFromString(value,'IN');if(!phone?.isValid())throw new Error('Enter a valid Indian or international phone number.');return phone.number;}
async function readTest(id:string):Promise<TestFlow|null>{
  const response=await fetch(`/api/simple/test-flow/${encodeURIComponent(id)}`,{cache:'no-store'});
  if(response.status===404)return null;
  const json=await response.json();
  if(!response.ok)throw new Error(json.error?.message||'Test status is temporarily unavailable.');
  return json.data;
}

export function TestLeadFlow({organizationId,connected,workerRunning,workerMessage,onClose}:{organizationId:string;connected:boolean;workerRunning:boolean;workerMessage?:string|null;onClose:()=>void}){
  const [draft,setDraft]=useState<Draft>(()=>restoreDraft(organizationId));
  const [contacts,setContacts]=useState<WhatsAppContact[]>([]);const [search,setSearch]=useState('');
  const [name,setName]=useState('');const [phone,setPhone]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const sending=useRef(false);
  const {step,recipients,executiveNotificationPhone,notificationPhone,run,watchId}=draft;
  const update=(values:Partial<Draft>)=>setDraft(current=>({...current,...values}));
  useEffect(()=>{try{sessionStorage.setItem(storageKey(organizationId),JSON.stringify({...draft,savedAt:Date.now()}));}catch{}},[draft,organizationId]);
  useEffect(()=>{
    if(!connected||step!=='recipients')return;
    let active=true;
    api<{contacts:WhatsAppContact[]}>('simple/contacts').then(value=>{if(active)setContacts(value.contacts);}).catch(()=>{});
    return()=>{active=false;};
  },[connected,step]);
  useEffect(()=>{
    if(!watchId||busy||terminal(run))return;
    let active=true,refreshing=false;
    const refresh=async()=>{
      if(refreshing)return;refreshing=true;
      try{
        const result=await readTest(watchId);
        if(active&&result){update({run:result,step:'progress'});setError('');}
        else if(active)setError('No test status is available yet. Keep this window open while we check.');
      }catch{if(active)setError('Test status is temporarily unavailable. Your test may still be sending; we will keep checking.');}
      finally{refreshing=false;}
    };
    void refresh();const timer=setInterval(refresh,1000);
    return()=>{active=false;clearInterval(timer);};
  },[watchId,busy,run?.status]);
  function addRecipient(){
    try{
      const normalized=normalizePhone(phone);
      if(recipients.some(person=>person.phone===normalized))throw new Error('This number is already selected.');
      if(recipients.length>=10)throw new Error('Choose up to 10 test recipients.');
      const next=[...recipients,{name:name.replace(/[\r\n]+/g,' ').trim()||contacts.find(person=>person.phone===normalized)?.name||normalized,phone:normalized}];
      update({recipients:next});setName('');setPhone('');setError('');return next;
    }catch(error){setError(errorMessage(error));return null;}
  }
  function toggle(person:WhatsAppContact){
    setError('');
    if(recipients.some(recipient=>recipient.phone===person.phone)){update({recipients:recipients.filter(recipient=>recipient.phone!==person.phone)});return;}
    if(recipients.length>=10){setError('Choose up to 10 test recipients.');return;}
    update({recipients:[...recipients,person]});
  }
  async function send(event:React.FormEvent){
    event.preventDefault();if(sending.current)return;setError('');
    if(step==='recipients'){
      const selected=phone.trim()?addRecipient():recipients;
      if(!selected?.length){if(selected)setError('Choose at least one test recipient.');return;}
      update({step:'executive'});return;
    }
    try{
      if(step==='executive'){update({executiveNotificationPhone:normalizePhone(executiveNotificationPhone),step:'owner'});return;}
      const owner=normalizePhone(notificationPhone),executive=normalizePhone(executiveNotificationPhone);
      if(!connected)throw new Error('Connect WhatsApp before sending a test.');
      if(!workerRunning)throw new Error(workerMessage||'The WhatsApp connection service is offline. Try again when it restarts.');
      sending.current=true;setBusy(true);update({notificationPhone:owner,executiveNotificationPhone:executive,step:'progress',watchId:draft.requestId});
      try{
        const result=await api<TestFlow>('simple/test-flow','POST',{requestId:draft.requestId,recipients:recipients.map(({name,phone})=>({name,phone})),executiveNotificationPhone:executive,notificationPhone:owner});
        update({run:result,watchId:result.id});
      }catch(error){
        try{
          const existing=await readTest(draft.requestId);
          if(existing)update({run:existing,watchId:existing.id});
          else{update({step:'owner',watchId:null});setError(errorMessage(error));}
        }catch{update({watchId:draft.requestId});setError('We could not confirm whether the test started. We will check its status without resending.');}
      }finally{sending.current=false;setBusy(false);}
    }catch(error){setError(errorMessage(error));}
  }
  const title=step==='progress'?'Test lead flow':step==='recipients'?'Who should receive the test lead?':step==='executive'?'Executive test notification':'Your test notification';
  const people=contacts.filter(person=>`${person.name} ${person.phone}`.toLowerCase().includes(search.toLowerCase()));
  const close=()=>{if(!busy)onClose();};
  const firstRecipient=recipients[0]?.name||'Recipient Name';
  return <Modal title={title} description="Try the WhatsApp flow without connecting a sheet." onClose={close}>
    {step==='progress'?<div className="simple-form simple-test-progress">
      {error&&<p role="alert" className="alert error">{error}</p>}
      <div aria-live="polite">
        {run?.status==='COMPLETED'?<p role="status" className="alert success"><Check size={18}/>Test completed. The sample lead and both notifications were accepted by WhatsApp.</p>:run?.status==='UNCERTAIN'?<p role="alert" className="alert error"><TriangleAlert size={18}/>A test message may have been sent. Check WhatsApp before starting another test.</p>:run?.status==='FAILED'?<p role="alert" className="alert error"><TriangleAlert size={18}/>The test stopped. {run.error||'Check the message status below.'}</p>:<p role="status" className="simple-share-note"><LoaderCircle size={17} className="spin"/>{busy?'Starting your test…':run?.status==='RUNNING'?'Sending the sample lead and notifications…':'Your test is queued. Waiting for WhatsApp…'}</p>}
        {run?.workerMessage&&<p role="status" className="alert info">{run.workerMessage}</p>}
        {run?.recipients.map((person,index)=><section className="simple-test-result" key={`${index}-${person.phone}`} aria-label={`Test result for ${person.name}`}>
          <h3>{person.name}<small>{person.phone}</small></h3>
          <TestStage label="Lead to recipient" phone={person.phone} stage={person.lead}/>
          <TestStage label="Executive notification" phone={run.executiveNotificationPhone} stage={person.executive}/>
          <TestStage label="Your notification" phone={run.notificationPhone} stage={person.owner}/>
        </section>)}
      </div>
      <p className="simple-fine-print">Messages are marked [TEST]. This test checks WhatsApp sending; sheet updates and feedback need a connected sheet.</p>
      <div className="row simple-test-actions"><Button disabled={busy} onClick={close}>Close</Button>{terminal(run)&&<Button onClick={()=>{setDraft({...newDraft(),recipients,executiveNotificationPhone,notificationPhone});setError('');}}>Start another test</Button>}</div>
    </div>:!connected?<div className="simple-modal-empty"><MessageCircle size={36}/><h3>Connect WhatsApp first</h3><p>Link WhatsApp to send the test lead and notifications. You can test without a Google Sheet.</p><Link href="/whatsapp" className="btn primary" onClick={onClose}>Connect WhatsApp<ArrowRight size={16}/></Link></div>:<form className="simple-form" onSubmit={send}>
      <p className="simple-test-steps" aria-label="Test setup steps">1. Recipients <ArrowRight size={13}/> 2. Executive <ArrowRight size={13}/> 3. You</p>
      {error&&<p role="alert" className="alert error">{error}</p>}
      {step==='recipients'?<>
        <p className="simple-share-note">Choose up to 10 people. Each receives one sample lead, followed by a notification to the executive and then to you.</p>
        {contacts.length>0&&<><input aria-label="Search test contacts" placeholder="Search contacts" value={search} onChange={event=>setSearch(event.target.value)}/><div className="simple-contact-list">{people.map(person=><label key={person.phone} className={`simple-contact simple-contact-choice ${recipients.some(recipient=>recipient.phone===person.phone)?'selected':''}`}><input type="checkbox" checked={recipients.some(recipient=>recipient.phone===person.phone)} disabled={recipients.length>=10&&!recipients.some(recipient=>recipient.phone===person.phone)} onChange={()=>toggle(person)}/><span className="simple-contact-details"><strong>{person.name}</strong><small>{person.phone}</small></span></label>)}</div></>}
        <div className="simple-add-number"><h3>Add a test recipient</h3><div><input aria-label="Test recipient name" maxLength={100} placeholder="Name (optional)" value={name} onChange={event=>setName(event.target.value)}/><input aria-label="Test recipient phone number" type="tel" maxLength={40} placeholder="+91 phone number" value={phone} onChange={event=>setPhone(event.target.value)}/><Button type="button" disabled={!phone.trim()||recipients.length>=10} onClick={addRecipient}><Plus size={16}/>Add recipient</Button></div></div>
        {recipients.length>0&&<div className="simple-test-selected" aria-label="Selected test recipients">{recipients.map(person=><div key={person.phone}><span><strong>{person.name}</strong><small>{person.phone}</small></span><Button type="button" variant="ghost" aria-label={`Remove ${person.name}`} onClick={()=>toggle(person)}><X size={16}/></Button></div>)}</div>}
        <Button type="submit" variant="primary" disabled={!recipients.length&&!phone.trim()}>Next: executive number<ArrowRight size={17}/></Button>
      </>:step==='executive'?<>
        <p className="simple-share-note">The executive is notified after each test lead reaches its recipient. You can use your own number for every role.</p>
        <Field label="Executive WhatsApp number"><input type="tel" required maxLength={40} placeholder="+91 phone number" value={executiveNotificationPhone} onChange={event=>update({executiveNotificationPhone:event.target.value})}/></Field>
        <p className="simple-test-preview">[TEST] New lead (SmartLead Test Lead) shared to ({firstRecipient}).</p>
        <div className="row"><Button type="button" onClick={()=>{update({step:'recipients'});setError('');}}><ArrowLeft size={16}/>Back</Button><Button type="submit" variant="primary">Next: your number<ArrowRight size={17}/></Button></div>
      </>:<>
        <p className="simple-share-note">Your confirmation arrives after the executive notification. All messages are marked [TEST].</p>
        <Field label="Your WhatsApp number"><input type="tel" required maxLength={40} placeholder="+91 phone number" value={notificationPhone} onChange={event=>update({notificationPhone:event.target.value})}/></Field>
        <div className="simple-test-preview"><strong>Sample lead</strong><p>SmartLead Test Lead · 0000000000<br/>Project: SmartLead Test · City: Test City</p></div>
        <p className="simple-test-preview">[TEST] New lead (SmartLead Test Lead, 0000000000) shared to ({firstRecipient}) and executive also updated.</p>
        <p className="simple-fine-print">{recipients.length} recipient{recipients.length===1?'':'s'} · {recipients.length*3} test messages. The test sends through your linked WhatsApp. No sheet is required.</p>
        {!workerRunning&&<p role="status" className="alert info">{workerMessage||'The WhatsApp connection service is offline. Try again when it restarts.'}</p>}
        <div className="row"><Button type="button" onClick={()=>{update({step:'executive'});setError('');}}><ArrowLeft size={16}/>Back</Button><Button type="submit" variant="primary" busy={busy} disabled={!workerRunning}><Send size={16}/>Send test lead</Button></div>
      </>}
    </form>}
  </Modal>;
}

function TestStage({label,phone,stage}:{label:string;phone:string;stage:TestFlow['recipients'][number]['lead']}){
  const accepted=stage.status==='SUBMITTED',running=stage.status==='PROCESSING',failed=['FAILED','UNCERTAIN'].includes(stage.status);
  return <div className={`simple-test-stage ${accepted?'accepted':failed?'failed':''}`}>
    {accepted?<Check size={16}/>:running?<LoaderCircle size={16} className="spin"/>:failed?<TriangleAlert size={16}/>:<Circle size={16}/>}
    <div><strong>{label}</strong><small>{phone}</small><span>{accepted?'Accepted by WhatsApp':running?'Sending…':stage.status==='UNCERTAIN'?'Acceptance uncertain':failed?'Failed':'Waiting'}</span>{stage.error&&<p>{stage.error}</p>}</div>
  </div>;
}
