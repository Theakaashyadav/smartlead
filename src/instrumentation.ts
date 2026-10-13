export async function register(){
  if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NODE_ENV==='production'&&process.env.NEXT_PHASE!=='phase-production-build'&&process.env.SMARTLEAD_EXTERNAL_WORKER!=='true'){
    const {startHostedWorker}=await import('./lib/hosted-worker');
    await startHostedWorker();
  }
}
