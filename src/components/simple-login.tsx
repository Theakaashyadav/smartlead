'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { api, Button, Field } from './ui';

export function Login({demo,registering=false}:{demo:boolean;registering?:boolean}){
  const [legacy,setLegacy]=useState(false);
  const [phone,setPhone]=useState(demo&&!registering?'9876543210':'');
  const [pin,setPin]=useState(demo&&!registering?'2468':'');
  const [email,setEmail]=useState(demo&&!registering?'admin@smartlead.demo':'');
  const [password,setPassword]=useState(demo&&!registering?'SmartLead!2026':'');
  const [name,setName]=useState('');const [organizationName,setOrganizationName]=useState('');
  const [confirmation,setConfirmation]=useState('');const [code,setCode]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function submit(e:React.FormEvent){
    e.preventDefault();setError('');
    if(registering&&pin!==confirmation){setError('PINs do not match.');return;}
    setBusy(true);
    try{
      await api(registering?'auth/register':'auth/login','POST',registering?{phone,pin,name,organizationName}:legacy?{email,password,code}:{phone,pin,code});
      window.location.assign('/dashboard');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <main className="simple-login"><div className="simple-login-card">
    <div className="simple-brand"><span><ArrowRight size={21}/></span>SmartLead</div>
    <h1>{registering?'Create your organisation':'Welcome back'}</h1>
    <p>{registering?'Create a workspace using your phone number and a four-digit PIN.':legacy?'Sign in to your existing account, then set up your phone number and PIN.':'Enter your phone number and PIN to open your workspace.'}</p>
    <form onSubmit={submit} className="simple-form">
      {registering&&<>
        <Field label="Your name"><input autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></Field>
        <Field label="Organisation name"><input autoComplete="organization" required minLength={2} maxLength={100} value={organizationName} onChange={e=>setOrganizationName(e.target.value)}/></Field>
      </>}
      {legacy?<>
        <Field label="Email"><input type="email" autoComplete="username" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></Field>
      </>:<>
        <Field label="Phone number" hint="Enter your 10-digit mobile number. No country code needed."><input type="tel" inputMode="tel" autoComplete="username" required maxLength={40} placeholder="10-digit mobile number" value={phone} onChange={e=>setPhone(e.target.value)}/></Field>
        <Field label="PIN" hint={registering?'Choose a four-digit PIN.':undefined}><input type="password" inputMode="numeric" pattern="[0-9]{4}" autoComplete={registering?'new-password':'current-password'} required minLength={4} maxLength={4} value={pin} onChange={e=>setPin(e.target.value)}/></Field>
      </>}
      {registering?<Field label="Confirm PIN"><input type="password" inputMode="numeric" pattern="[0-9]{4}" autoComplete="new-password" required minLength={4} maxLength={4} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></Field>:<details className="simple-login-code"><summary>Have an authenticator code?</summary><Field label="Authenticator code"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value)}/></Field></details>}
      {error&&<div className="alert error" role="alert">{error}</div>}
      <Button type="submit" variant="primary" busy={busy}>{registering?'Create organisation account':'Log in'}<ArrowRight size={17}/></Button>
    </form>
    {!registering&&<button type="button" className="text-button" onClick={()=>{setLegacy(!legacy);setError('');setCode('');}}>{legacy?'Use phone number and PIN':'Use an existing email account'}</button>}
    <p className="simple-login-switch">{registering?'Already have an account? ':'For a different organisation, '}<Link href={registering?'/login':'/register'}>{registering?'Log in':'Create an account'}</Link></p>
    {demo&&!registering&&<p className="simple-login-hint">Demo: 9876543210 · PIN 2468. Each new account has its own workspace.</p>}
  </div></main>;
}
