export async function register(){
  if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NODE_ENV==='production'&&process.env.NEXT_PHASE!=='phase-production-build'){
    const {prepareHostedStdin}=await import('./lib/hosted-stdin');
    prepareHostedStdin();
    if(process.env.ADMIN_PHONE_SETUP==='true'){
      try{
        const {runAdminPhoneSetup}=await import('./lib/admin-phone-setup');
        await runAdminPhoneSetup();
      }catch{console.error(JSON.stringify({event:'admin_phone_setup_failed',reason:'SETUP_UNAVAILABLE',message:'Cannot start admin phone setup. Check the hosting configuration and runtime logs.'}));}
    }
    if(process.env.SMARTLEAD_EXTERNAL_WORKER!=='true'){
      const {startHostedWorker}=await import('./lib/hosted-worker');
      await startHostedWorker();
    }
  }
}
