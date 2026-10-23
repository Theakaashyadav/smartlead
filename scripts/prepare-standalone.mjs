import path from 'node:path';
import { access, cp, rm } from 'node:fs/promises';

const standalone=path.resolve('.next','standalone');
await access(path.join(standalone,'server.js'));
// Runtime sessions, databases and test fixtures must never ship in the server
// artifact, including when Windows tracing retains ignored runtime files.
const runtimeData=path.resolve(standalone,'data');
if(path.dirname(runtimeData)!==standalone)throw new Error('Invalid standalone runtime-data path.');
await rm(runtimeData,{recursive:true,force:true});
await cp(path.resolve('.next','static'),path.join(standalone,'.next','static'),{recursive:true});
try{await access('public');await cp('public',path.join(standalone,'public'),{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
console.log('Standalone server, static assets, and embedded worker are ready for publishing.');
