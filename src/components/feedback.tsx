'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, Layers, Phone, BriefcaseBusiness, UserRound, ArrowRight, ShieldCheck, MapPin, MessageSquareText, ChevronDown, RefreshCw, LockKeyhole } from 'lucide-react';
import { api, Badge, Button, Field, Select, dateTime } from './ui';
import { FEEDBACK_STATUSES } from '@/lib/feedback-statuses';
import './feedback.css';
const formSchema=z.object({status:z.string().min(1),remarks:z.string().trim().min(3,'Please add at least 3 characters of feedback').max(5000),interest:z.string(),nextFollowupAt:z.string(),callOutcome:z.string(),contactMethod:z.string(),siteVisitAt:z.string(),expectedBudget:z.string()});
type Form=z.infer<typeof formSchema>;
export function FeedbackForm({lead,statuses,onSubmit}:{lead:any;statuses:string[];onSubmit:(data:unknown)=>Promise<void>}){
  const [saved,setSaved]=useState(false);const [error,setError]=useState('');
  const {register,handleSubmit,formState:{errors,isSubmitting}}=useForm<Form>({resolver:zodResolver(formSchema),defaultValues:{status:lead.status,remarks:'',interest:'Warm',nextFollowupAt:'',callOutcome:'Connected',contactMethod:'Phone',siteVisitAt:'',expectedBudget:lead.budget||''}});
  return <form className="feedback-form" onSubmit={handleSubmit(async values=>{setError('');setSaved(false);try{await onSubmit({...values,version:lead.version,nextFollowupAt:values.nextFollowupAt?new Date(values.nextFollowupAt).toISOString():null,siteVisitAt:values.siteVisitAt?new Date(values.siteVisitAt).toISOString():null});setSaved(true);}catch(e){setError((e as Error).message);}})}><div className="form-grid"><Field label="Lead status *"><Select {...register('status')}>{statuses.map(s=><option key={s}>{s}</option>)}</Select></Field><Field label="Customer interest"><Select {...register('interest')}>{['Hot','Warm','Cold','Not Interested'].map(s=><option key={s}>{s}</option>)}</Select></Field><Field label="Call outcome"><Select {...register('callOutcome')}>{['Connected','No answer','Call back requested','Invalid number','Not contacted'].map(s=><option key={s}>{s}</option>)}</Select></Field><Field label="Preferred contact method"><Select {...register('contactMethod')}>{['Phone','WhatsApp','Email','In person'].map(s=><option key={s}>{s}</option>)}</Select></Field></div><Field label="Feedback / remarks *"><textarea {...register('remarks')} rows={4} placeholder="What did you discuss? Add useful context for the next conversation."/>{errors.remarks&&<small className="error-text">{errors.remarks.message}</small>}</Field><div className="form-grid"><Field label="Next follow-up (your local time)"><input type="datetime-local" {...register('nextFollowupAt')}/></Field><Field label="Site visit date"><input type="datetime-local" {...register('siteVisitAt')}/></Field><Field label="Expected budget"><input {...register('expectedBudget')} placeholder="e.g. ₹50 lakh"/></Field></div>{error&&<div role="alert" className="alert error">{error}</div>}{saved&&<div role="status" className="alert success"><CheckCircle2 size={18}/>Lead feedback submitted successfully.</div>}<Button type="submit" variant="primary" busy={isSubmitting} className="full">Submit feedback<ArrowRight size={16}/></Button><small className="form-footnote">Your feedback is saved securely. Google Sheets updates automatically when the connection is available.</small></form>;
}
type FeedbackLead = {
  id:string; customerName:string; mobile:string; project:string; status:string;
  lastFeedback:string|null; version:number; updatedAt:string; location?:string;
  source?:string; sheetName?:string; questions?:{question:string;answer:string}[];
  writebackStatus:string; writebackAvailable?:boolean; writebackError?:string|null;
};
type FeedbackData = {lead:FeedbackLead;employee:{name:string}};

function SimpleFeedbackForm({lead,onSubmit}:{lead:FeedbackLead;onSubmit:(data:{status:string;remarks:string;version:number})=>Promise<void>}){
  const [status,setStatus]=useState<string>(FEEDBACK_STATUSES.some(s=>s===lead.status)?lead.status:'');
  const [remarks,setRemarks]=useState(lead.lastFeedback||'');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <form className="feedback-form" onSubmit={async e=>{
    e.preventDefault();if(busy)return;setError('');
    if(remarks.trim().length<3){setError('Please add at least 3 characters to your remark.');return;}
    setBusy(true);try{await onSubmit({status,remarks:remarks.trim(),version:lead.version});}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }}>
    <Field label="Lead status" hint="How did the conversation go?">
      <Select aria-label="Feedback (lead status)" required value={status} onChange={e=>setStatus(e.target.value)}>
        <option value="" disabled>Select an outcome</option>
        {FEEDBACK_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
      </Select>
    </Field>
    <Field label="Your remark" hint="Add a little context for the next conversation.">
      <textarea aria-label="Remark" required minLength={3} maxLength={5000} rows={5} value={remarks} onChange={e=>setRemarks(e.target.value)} placeholder="What did you discuss? What should happen next?"/>
      <span className="feedback-character-count">{remarks.length.toLocaleString()} / 5,000</span>
    </Field>
    {error&&<div role="alert" className="alert error">{error}</div>}
    {lead.lastFeedback&&<div role="status" className="feedback-saved">
      <CheckCircle2 size={21}/><div><strong>Feedback saved securely</strong>
      <p>{lead.writebackAvailable===false?'Your update is saved in SmartLead.':lead.writebackStatus==='SYNCED'?'Google Sheet is up to date.':lead.writebackStatus==='ERROR'?'Google Sheet sync will retry automatically. You can close this page.':'Google Sheet is updating in the background. You can close this page.'}</p></div>
    </div>}
    <Button type="submit" variant="primary" busy={busy} className="full">{busy?'Saving feedback…':'Save status & feedback'}{!busy&&<ArrowRight size={18}/>}</Button>
    <p className="feedback-save-note"><ShieldCheck size={15}/>Saved securely. Your sheet updates automatically.</p>
  </form>;
}

export function FeedbackPage({token}:{token:string}){
  const [data,setData]=useState<FeedbackData|null>(null);const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;setData(null);setError('');
    api<FeedbackData>(`feedback/${token}`).then(value=>{if(active)setData(value);}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[token,retry]);
  useEffect(()=>{
    if(!data?.lead.lastFeedback||data.lead.writebackAvailable===false||data.lead.writebackStatus==='SYNCED')return;
    let active=true;let inFlight=false;
    const timer=setInterval(async()=>{
      if(inFlight||document.visibilityState==='hidden')return;
      inFlight=true;
      try{const latest=await api<FeedbackData>(`feedback/${token}`);if(active)setData(current=>current&&latest.lead.version>=current.lead.version?latest:current);}catch{/* Saved feedback stays visible if the connection drops. */}
      finally{inFlight=false;}
    },5000);
    return()=>{active=false;clearInterval(timer);};
  },[token,data?.lead.lastFeedback,data?.lead.writebackStatus,data?.lead.writebackAvailable]);
  const lead=data?.lead;
  return <main className="feedback-page">
    <header className="feedback-topbar">
      <div className="feedback-brand"><span className="feedback-brand-icon"><Layers size={22}/></span>smartlead<span>.</span></div>
      <span className="feedback-private"><LockKeyhole size={13}/>Private lead link</span>
    </header>
    <div className="feedback-intro"><span className="eyebrow">EVERY CONVERSATION COUNTS</span><h1>A little feedback.<br/><span>A better follow-up.</span></h1><p>Capture the conversation and keep your next step clear.</p></div>
    <div className="feedback-card">
      {error?<div className="feedback-access-error"><ShieldCheck size={32}/><h2>This link is unavailable</h2><div role="alert" className="alert error">{error}</div><Button onClick={()=>setRetry(value=>value+1)}><RefreshCw size={16}/>Try again</Button></div>:!data||!lead?<div className="feedback-loading" role="status"><div className="skeleton tall"/><p>Loading your lead…</p></div>:<div className="feedback-layout">
        <section className="feedback-context" aria-labelledby="feedback-customer">
          <span className="feedback-section-label">YOUR LEAD</span>
          <div className="feedback-person"><span className="feedback-initials" aria-hidden="true">{lead.customerName.split(' ').filter(Boolean).slice(0,2).map(name=>name[0]).join('')}</span><div><h2 id="feedback-customer">{lead.customerName}</h2><Badge>{lead.status}</Badge></div></div>
          <div className="feedback-facts">
            <div><BriefcaseBusiness size={17}/><span><small>Project</small><strong>{lead.project||'Not provided'}</strong></span></div>
            <div><MapPin size={17}/><span><small>City</small><strong>{lead.location||'Not provided'}</strong></span></div>
            <div><UserRound size={17}/><span><small>Assigned to</small><strong>{data.employee.name}</strong></span></div>
          </div>
          <a className="feedback-call" href={`tel:${lead.mobile}`}><Phone size={17}/><span>{lead.mobile}</span><ArrowRight size={16}/></a>
          {(lead.questions?.length||lead.sheetName||lead.source)&&<details className="feedback-enquiry"><summary>Enquiry details<ChevronDown size={16}/></summary><div>
            {lead.sheetName&&<p>Sheet: {lead.sheetName}</p>}{lead.source&&<p>Source: {lead.source}</p>}
            {lead.questions?.map((q,i)=><div className="feedback-question" key={i}><strong>Q.{i+1} - {q.question}</strong><p>{q.answer||'Not provided'}</p></div>)}
          </div></details>}
          <p className="feedback-updated">Last updated {dateTime(lead.updatedAt)}</p>
        </section>
        <section className="feedback-editor" aria-labelledby="feedback-form-heading">
          <div className="feedback-editor-heading"><span className="feedback-editor-icon"><MessageSquareText size={20}/></span><div><h2 id="feedback-form-heading">Leave your feedback</h2><p>Two quick details. All caught up.</p></div></div>
          <SimpleFeedbackForm key={token} lead={lead} onSubmit={async values=>{
            const result=await api<{lead:Partial<FeedbackLead>}>(`feedback/${token}`,'POST',values);
            setData(current=>current?{...current,lead:{...current.lead,status:values.status,lastFeedback:values.remarks,version:values.version+1,writebackStatus:'PENDING',writebackError:null,...result.lead}}:current);
          }}/>
        </section>
      </div>}
    </div>
    <footer className="feedback-footer"><ShieldCheck size={15}/><span>This private link gives access to this lead only.</span><span className="feedback-footer-brand">Made for better connections. <strong>smartlead.</strong></span></footer>
  </main>;
}
