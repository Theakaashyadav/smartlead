import { existsSync } from 'node:fs';

export async function browserExecutablePath(cachedExecutable:()=>string|Promise<string>){
  if(process.env.CHROME_PATH)return existsSync(process.env.CHROME_PATH)?process.env.CHROME_PATH:null;
  const installed=(process.platform==='win32'?[
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ]:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome']).find(file=>existsSync(file));
  if(installed)return installed;
  try{const cached=await cachedExecutable();return existsSync(cached)?cached:null;}catch{return null;}
}
