// Classify errors using private details, but return only fixed messages and safe codes.
// Prisma initialization errors use errorCode; query errors use code.
export function databaseFailure(error:unknown){
  if(!error||typeof error!=='object')return null;
  const value=error as {name?:unknown;message?:unknown;code?:unknown;errorCode?:unknown;meta?:{code?:unknown;message?:unknown}};
  const rawCode=value.code??value.errorCode;
  const prismaCode=typeof rawCode==='string'&&/^P\d{4}$/.test(rawCode)?rawCode:undefined;
  const type=typeof value.name==='string'?value.name:'';
  const details=[value.message,value.meta?.message].filter(v=>typeof v==='string').join('\n');
  const diagnostic=(reason:string,message:string,engineTarget?:string)=>({reason,message,...(prismaCode?{prismaCode}:{}),...(engineTarget?{engineTarget}:{})});
  const isDatabaseError=type.startsWith('PrismaClient')||type.startsWith('Mongo')||!!prismaCode;
  if(/^Set MONGODB_URI in \.env|^MONGODB_(?:URI is invalid|DATABASE must be)/.test(details)||prismaCode==='P1012'||prismaCode==='P1013')return diagnostic('DATABASE_CONFIGURATION','Check MONGODB_URI and MONGODB_DATABASE in the hosting environment, then apply changes and restart the app.');
  if(!isDatabaseError)return null;
  if(/could not locate the query engine|query engine.*(?:could not be found|not found)/i.test(details)){
    const target=details.match(/runtime "([a-z\d.-]{1,60})"/i)?.[1];
    return diagnostic('DATABASE_ENGINE_MISSING','The deployment is missing the Prisma database engine for this server. Regenerate Prisma Client for the hosting runtime and include its engine in the deployment.',target);
  }
  if(/(?:unable to require|unable to load|failed to load).*(?:query.engine|libquery_engine)|libssl\.so|GLIBC_[\d.]+.*not found/is.test(details))return diagnostic('DATABASE_ENGINE_INCOMPATIBLE','The Prisma database engine cannot load on this server. Check the hosting runtime, OpenSSL libraries, and Prisma binary target.');
  if(prismaCode==='P1000'||Number(value.meta?.code)===18||/authentication failed|bad auth|SCRAM failure/i.test(details))return diagnostic('DATABASE_AUTHENTICATION','MongoDB authentication failed. Check the database user and password in Hostinger\'s MONGODB_URI, then apply changes.');
  if(prismaCode==='P1010'||Number(value.meta?.code)===13||/not authorized|not authorised/i.test(details))return diagnostic('DATABASE_PERMISSION','The MongoDB user cannot access SmartLead. Grant that user read and write access to the smartlead database.');
  if(prismaCode==='P2031'||/replica set.*(?:required|need)|transactions.*replica set/i.test(details))return diagnostic('DATABASE_REPLICA_SET','MongoDB transactions require a replica set. Use a MongoDB Atlas cluster or configure replica-set support.');
  if(prismaCode==='P1011'||/TLS|SSL|certificate/i.test(details))return diagnostic('DATABASE_TLS','The server could not establish a secure MongoDB connection. Check Atlas network access and the hosting server\'s TLS configuration.');
  if(/ENOTFOUND|EAI_AGAIN|querySrv|DNS.*(?:failed|lookup|resolve)/i.test(details))return diagnostic('DATABASE_DNS','The hosting server could not resolve MongoDB. Check the cluster hostname in MONGODB_URI and the server\'s DNS access.');
  if(['P1001','P1002','P1008','P1017','P2024','P2037'].includes(prismaCode||'')||/server selection|connection (?:refused|timed out)|ECONNREFUSED|ETIMEDOUT/i.test(details))return diagnostic('DATABASE_NETWORK','The hosting server cannot connect to MongoDB. Check the cluster status, Atlas network access, and outbound connections from Hostinger.');
  if(type==='PrismaClientInitializationError')return diagnostic('DATABASE_INITIALIZATION','The database client could not start. Check the database_health_error entry in Hostinger Runtime logs.');
  return null;
}

export function safeDatabaseErrorCode(error:unknown){
  if(!error||typeof error!=='object')return 'UNKNOWN';
  const value=error as {code?:unknown;errorCode?:unknown};
  const code=value.code??value.errorCode;
  return typeof code==='string'&&/^P\d{4}$/.test(code)?code:'UNKNOWN';
}
