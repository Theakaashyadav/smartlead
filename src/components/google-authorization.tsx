'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './ui';

const resultType='smartlead:google-authorization';
type AuthorizationResult={google:'connected'|'error';message?:string;url?:string;credentialId?:string};

function openGoogleAuthorization(start:()=>Promise<{url:string}>,signal:AbortSignal):Promise<AuthorizationResult>{
  // Open during the click event, before the network request, so browsers allow it.
  const popup=window.open('about:blank',`smartlead-google-${crypto.randomUUID()}`,'popup=yes,width=560,height=720');
  if(!popup)return Promise.reject(new Error('Allow pop-ups for SmartLead, then try connecting Google again.'));
  popup.document.title='Connect Google · SmartLead';
  popup.document.body.textContent='Opening Google account selection…';
  return new Promise((resolve,reject)=>{
    let finished=false;
    const cleanup=()=>{window.removeEventListener('message',receive);signal.removeEventListener('abort',cancel);clearInterval(closed);clearTimeout(timeout);popup.close();};
    const fail=(message:string)=>{if(finished)return;finished=true;cleanup();reject(new Error(message));};
    const cancel=()=>fail('Google connection was cancelled.');
    const receive=(event:MessageEvent)=>{
      if(event.origin!==window.location.origin||event.source!==popup||event.data?.type!==resultType)return;
      const result=event.data.result as AuthorizationResult|undefined;
      if(!result||!['connected','error'].includes(result.google))return;
      if(result.google==='error'){fail(typeof result.message==='string'?result.message:'Google access was not approved.');return;}
      if((result.url!==undefined&&typeof result.url!=='string')||(result.credentialId!==undefined&&typeof result.credentialId!=='string'))return;
      if(finished)return;finished=true;cleanup();resolve(result);
    };
    const closed=setInterval(()=>{if(popup.closed)fail('Google connection was cancelled. Your sheet connection is unchanged.');},300);
    const timeout=setTimeout(()=>fail('Google authorization expired. Please try again.'),600000);
    window.addEventListener('message',receive);signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted){cancel();return;}
    start().then(result=>{
      if(finished)return;
      if(popup.closed){cancel();return;}
      const destination=new URL(result.url,window.location.origin);
      if(destination.origin!==window.location.origin&&destination.origin!=='https://accounts.google.com')throw new Error('Google returned an invalid connection address. Please try again.');
      popup.location.href=destination.toString();popup.focus();
    }).catch(error=>fail(error instanceof Error?error.message:'Google connection could not be started.'));
  });
}

export function useGoogleAuthorization(){
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  return useCallback((input:{url?:string;sheetId?:string})=>{
    active.current?.abort();const controller=new AbortController();active.current=controller;
    return openGoogleAuthorization(()=>api<{url:string}>('simple/google/authorize','POST',{...input,popup:true}),controller.signal);
  },[]);
}

export function GoogleAuthorizationComplete(){
  const completedOnce=useRef(false);
  const [result,setResult]=useState<AuthorizationResult|null>(null);const [back,setBack]=useState('/sheets');
  useEffect(()=>{
    if(completedOnce.current)return;completedOnce.current=true;
    const query=new URLSearchParams(window.location.search);
    const completed:AuthorizationResult=query.get('google')==='connected'?{google:'connected',...(query.get('sheet')&&query.get('credential')?{url:query.get('sheet')!,credentialId:query.get('credential')!}:{})}:{google:'error',message:query.get('message')||'Google access was not approved. Please try again.'};
    setResult(completed);
    const destination=new URL('/sheets',window.location.origin);destination.searchParams.set('google',completed.google);
    if(completed.message)destination.searchParams.set('message',completed.message);
    if(completed.url&&completed.credentialId){destination.searchParams.set('sheet',completed.url);destination.searchParams.set('credential',completed.credentialId);}
    setBack(destination.pathname+destination.search);
    window.opener?.postMessage({type:resultType,result:completed},window.location.origin);
    window.history.replaceState(null,'',window.location.pathname);
  },[]);
  return <main className="simple-login"><div className="simple-login-card"><h1>{result?.google==='error'?'Google connection needs attention':'Google connection complete'}</h1><p role={result?.google==='error'?'alert':'status'}>{result?.google==='error'?result.message:'Return to your SmartLead window to finish choosing the sheet tab and columns.'}</p><Link href={back}>Return to Sheets</Link></div></main>;
}
