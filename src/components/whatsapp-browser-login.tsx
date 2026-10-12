'use client';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, ExternalLink, Smartphone } from 'lucide-react';
import { Button } from './ui';
export function WhatsAppBrowserLogin({account,busy,onConnect,onDisconnect}:{account?:{status:string;phone:string|null;lastError:string|null}|null;busy:boolean;onConnect:()=>Promise<void>;onDisconnect:()=>Promise<void>}){
  const connected=account?.status==='CONNECTED';const opening=account?.status==='CONNECTING';
  return <>
    {connected?<><div className="simple-success-icon"><CheckCircle2 size={36}/></div><h2>WhatsApp connected</h2><p>{account.phone}</p><p>WhatsApp Web is running in the background. You can now choose recipients for your sheets.</p><Link className="btn primary" href="/sheets">Choose sheet recipients<ArrowRight size={16}/></Link><Button busy={busy} onClick={onConnect}>Open WhatsApp Web<ExternalLink size={16}/></Button><Button variant="ghost" busy={busy} onClick={onDisconnect}>Disconnect account</Button></>:<>
      <div className="simple-card-icon whatsapp"><Smartphone size={30}/></div><h2>Link WhatsApp Web</h2><p>Sign in on the original WhatsApp website in a browser window on this computer.</p>
      <div className="simple-original-login"><strong>web.whatsapp.com</strong><p>{opening?'Opening WhatsApp Web…':account?.status==='WAITING_LOGIN'?'WhatsApp Web is open. Scan the QR code shown in that window.':'Click below to open WhatsApp Web, then scan its QR code with your phone.'}</p><small>You can also choose “Log in with phone number” on WhatsApp Web.</small></div>
      {account?.lastError&&<div className="alert error" role="alert">{account.lastError}</div>}
      <Button variant="primary" busy={busy||opening} onClick={onConnect}>Open WhatsApp Web<ExternalLink size={16}/></Button><p className="simple-fine-print">After login, the window minimizes and keeps sending in the background. Keep it open.</p>
    </>}
  </>;
}
