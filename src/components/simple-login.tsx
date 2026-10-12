'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { api, Button, Field } from './ui';

export function Login({demo,registering=false}:{demo:boolean;registering?:boolean}){
  const [email,setEmail]=useState(demo&&!registering?'admin@smartlead.demo':'');
  const [password,setPassword]=useState(demo&&!registering?'SmartLead!2026':'');
  const [name,setName]=useState('');const [organizationName,setOrganizationName]=useState('');
  const [confirmation,setConfirmation]=useState('');const [code,setCode]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function submit(e:React.FormEvent){
    e.preventDefault();setError('');
    if(registering&&password!==confirmation){setError('Passwords do not match.');return;}
    setBusy(true);
    try{
      await api(registering?'auth/register':'auth/login','POST',registering?{email,password,name,organizationName}:{email,password,code});
      window.location.assign('/dashboard');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <main className="simple-login"><div className="simple-login-card">
    <div className="simple-brand"><span><ArrowRight size={21}/></span>SmartLead</div>
    <h1>{registering?'Create your organisation':'Welcome back'}</h1>
    <p>{registering?'Get a separate workspace for your organisation’s WhatsApp, sheets, and leads.':'Log in to your organisation’s sheets and WhatsApp.'}</p>
    <form onSubmit={submit} className="simple-form">
      {registering&&<>
        <Field label="Your name"><input autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></Field>
        <Field label="Organisation name"><input autoComplete="organization" required minLength={2} maxLength={100} value={organizationName} onChange={e=>setOrganizationName(e.target.value)}/></Field>
      </>}
      <Field label="Email" hint="Use this email as your login ID."><input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></Field>
      <Field label="Password" hint={registering?'At least 12 characters.':undefined}><input type="password" autoComplete={registering?'new-password':'current-password'} required minLength={registering?12:1} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></Field>
      {registering?<Field label="Confirm password"><input type="password" autoComplete="new-password" required value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></Field>:<details className="simple-login-code"><summary>Have an authenticator code?</summary><Field label="Authenticator code"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value)}/></Field></details>}
      {error&&<div className="alert error" role="alert">{error}</div>}
      <Button type="submit" variant="primary" busy={busy}>{registering?'Create organisation account':'Log in'}<ArrowRight size={17}/></Button>
    </form>
    <p className="simple-login-switch">{registering?'Already have an account? ':'For a different organisation, '}<Link href={registering?'/login':'/register'}>{registering?'Log in':'Create an account'}</Link></p>
    {demo&&!registering&&<p className="simple-login-hint">Your existing local login is filled in. Each new account has its own workspace.</p>}
  </div></main>;
}
