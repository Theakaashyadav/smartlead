import nextEnv from '@next/env';

// Load files in the same order as Next, while preserving hosting environment values.
const production=process.argv.includes('--production')||process.env.NODE_ENV==='production';
nextEnv.loadEnvConfig(process.cwd(),!production,{info(){},error(){}});
const env=process.env;
const database=env.DATABASE_PROVIDER||'mongodb';
const required=['APP_URL','SESSION_SECRET','ENCRYPTION_KEY',...(database==='sqlite'?['DEMO_DATABASE_URL']:['MONGODB_URI'])];
const missing=required.filter(key=>!env[key]);
const invalid=[];const warnings=[];let appOrigin=null;
if(env.APP_URL)try{
  const url=new URL(env.APP_URL);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error();
  appOrigin=url.origin;
  if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))warnings.push('APP_URL is local. On Hostinger, set it to the public HTTPS website address and apply changes.');
  else if(url.protocol!=='https:')invalid.push('APP_URL must use HTTPS for a hosted website');
}catch{invalid.push('APP_URL must be an HTTP(S) origin without a path or credentials');}
if(env.SESSION_SECRET&&(env.SESSION_SECRET.length<32||env.SESSION_SECRET.startsWith('replace-')))invalid.push('SESSION_SECRET must contain at least 32 characters from a secure random generator');
if(env.ENCRYPTION_KEY&&!/^[a-f\d]{64}$/i.test(env.ENCRYPTION_KEY))invalid.push('ENCRYPTION_KEY must contain exactly 64 hexadecimal characters');
if(!['mongodb','sqlite'].includes(database))invalid.push('DATABASE_PROVIDER must be mongodb or sqlite');
if(database==='mongodb'){
  let uri=env.MONGODB_URI?.trim();
  if(uri&&((uri.startsWith('"')&&uri.endsWith('"'))||(uri.startsWith("'")&&uri.endsWith("'"))))uri=uri.slice(1,-1).trim();
  if(env.MONGODB_URI&&!/^mongodb(?:\+srv)?:\/\//.test(uri||''))invalid.push('MONGODB_URI must be a MongoDB connection string');
  if(!/^smartlead(?:_[a-z0-9_-]+)?$/.test(env.MONGODB_DATABASE||'smartlead'))invalid.push('MONGODB_DATABASE must be smartlead or start with smartlead_');
}
// Log names and validation results only; never connection strings, passwords, or keys.
console.log(JSON.stringify({event:'smartlead_configuration',appOrigin,database,configured:required.filter(key=>!!env[key]),missing,invalid,warnings}));
if(missing.length||invalid.length)process.exitCode=1;
