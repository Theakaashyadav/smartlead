'use client';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Smartphone } from 'lucide-react';
import { Button } from './ui';
export function WhatsAppBackgroundLogin({account,busy,onConnect,onDisconnect}:{account?:{status:string;phone:string|null;qrCode:string|null;lastError:string|null}|null;busy:boolean;onConnect:()=>Promise<void>;onDisconnect:()=>Promise<void>}){
  const connected=account?.status==='CONNECTED';const opening=account?.status==='CONNECTING'||account?.status==='WAITING_LOGIN';
  return connected?<><div className="simple-success-icon"><CheckCircle2 size={36}/></div><h2>WhatsApp connected</h2><p>{account.phone}</p><p>Sending runs in the background. You can close this page and all visible browser windows.</p><Link className="btn primary" href="/sheets">Choose sheet recipients<ArrowRight size={16}/></Link><Button variant="ghost" busy={busy} onClick={onDisconnect}>Disconnect account</Button></>:<>
    <div className="simple-card-icon whatsapp"><Smartphone size={30}/></div><h2>Link WhatsApp Web</h2><p>Connect your account once. No separate browser window is needed.</p>
    {account?.qrCode?<div className="simple-qr"><img src={account.qrCode} alt="Scan this QR code with WhatsApp to connect your account" width={264} height={264}/><p>On your phone, open WhatsApp → Linked devices → Link a device.</p></div>:<div className="simple-qr-placeholder"><Smartphone size={46}/><p>{opening?'Connecting to WhatsApp…':'Click below to connect WhatsApp.'}</p></div>}
    {account?.lastError&&<div className="alert error" role="alert">{account.lastError}</div>}
    <Button variant="primary" busy={busy||opening} disabled={!!account?.qrCode} onClick={onConnect}>{account?.qrCode?'Waiting for scan':account?.status==='ERROR'?'Try again':'Connect WhatsApp'}</Button><p className="simple-fine-print">After linking, sending continues when you close the dashboard.</p>
  </>;
}
