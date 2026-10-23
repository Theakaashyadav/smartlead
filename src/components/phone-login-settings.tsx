'use client';
import { useState } from 'react';
import { api, Button, Field, Modal } from './ui';

export function PhoneLoginSettings({user,onClose,onSaved}:{user:{phone?:string|null;pinEnabled?:boolean;twoFactor?:boolean};onClose:()=>void;onSaved:()=>Promise<unknown>}){
  const [phone,setPhone]=useState(user.phone?.replace(/^\+91(?=\d{10}$)/,'')||'');
  const [pin,setPin]=useState('');const [confirmation,setConfirmation]=useState('');
  const [currentCredential,setCurrentCredential]=useState('');const [code,setCode]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function submit(e:React.FormEvent){
    e.preventDefault();setError('');
    if(pin!==confirmation){setError('PINs do not match.');return;}
    setBusy(true);
    try{await api('auth/phone','PUT',{phone,pin,currentCredential,code});await onSaved();onClose();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal title="Phone login & PIN" onClose={onClose}><form className="simple-form" onSubmit={submit}>
    <p>Use this phone number and PIN to sign in to your current workspace.</p>
    <Field label={user.pinEnabled?'Current PIN':'Current password'}><input type="password" autoComplete="current-password" required maxLength={128} value={currentCredential} onChange={e=>setCurrentCredential(e.target.value)}/></Field>
    <Field label="Phone number" hint="Enter your 10-digit mobile number. No country code needed."><input type="tel" autoComplete="tel-national" required maxLength={40} value={phone} onChange={e=>setPhone(e.target.value)}/></Field>
    <Field label="New PIN" hint="Choose a four-digit PIN."><input type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" required minLength={4} maxLength={4} value={pin} onChange={e=>setPin(e.target.value)}/></Field>
    <Field label="Confirm PIN"><input type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" required minLength={4} maxLength={4} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></Field>
    {user.twoFactor&&<Field label="Authenticator code"><input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value)}/></Field>}
    {error&&<div className="alert error" role="alert">{error}</div>}
    <Button type="submit" variant="primary" busy={busy}>Save phone & PIN</Button>
  </form></Modal>;
}
