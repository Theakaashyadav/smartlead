import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/security';
import { isDemo } from '@/lib/config';
import { SimpleApp } from '@/components/simple-app';
import { Login } from '@/components/simple-login';
import { FeedbackPage } from '@/components/feedback';
import { GoogleAuthorizationComplete } from '@/components/google-authorization';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{path?:string[]}>}){
  const {path=[]}=await params;
  if(path[0]==='feedback'&&path[1])return <FeedbackPage token={path[1]}/>;
  const user=await currentUser();
  if(path[0]==='login'||path[0]==='register'){if(user)redirect('/dashboard');return <Login key={path[0]} demo={isDemo()} registering={path[0]==='register'}/>;}
  if(!user)redirect('/login');
  if(path[0]==='google-complete'&&path.length===1)return <GoogleAuthorizationComplete/>;
  if(!path.length)redirect('/dashboard');
  if(!['dashboard','sheets','whatsapp'].includes(path[0])||path.length>1)redirect('/dashboard');
  return <SimpleApp/>;
}
