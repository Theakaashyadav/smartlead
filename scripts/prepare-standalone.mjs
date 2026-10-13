import path from 'node:path';
import { access, cp } from 'node:fs/promises';

const standalone=path.resolve('.next','standalone');
await access(path.join(standalone,'server.js'));
await cp(path.resolve('.next','static'),path.join(standalone,'.next','static'),{recursive:true});
try{await access('public');await cp('public',path.join(standalone,'public'),{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
console.log('Standalone server, static assets, and embedded worker are ready for publishing.');
