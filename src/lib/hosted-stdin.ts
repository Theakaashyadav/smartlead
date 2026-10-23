import { Readable } from 'node:stream';

// Some managed Node runners use fd 0 for their own socket. Reading stdin then
// throws open EEXIST. Native ESM imports of node:process enumerate that getter,
// so Puppeteer fails during import, before Chrome is even launched. Headless
// workers need no terminal input. Leave healthy stdin and the host's fd intact.
export function prepareHostedStdin(target:Pick<NodeJS.Process,'stdin'>=process){
  try{void target.stdin;return false;}
  catch(error){
    const failure=error as NodeJS.ErrnoException;
    if(failure.code!=='EEXIST'||failure.syscall!=='open')throw error;
    Object.defineProperty(target,'stdin',{value:Readable.from([]),enumerable:true,configurable:true});
    return true;
  }
}
