import ConnectionString from 'mongodb-connection-string-url';

export function mongoSettings(env:Record<string,string|undefined>=process.env){
  const database=env.MONGODB_DATABASE||'smartlead';
  if(!/^smartlead(?:_[a-z0-9_-]+)?$/.test(database))throw new Error('MONGODB_DATABASE must be smartlead or start with smartlead_.');
  let uri=env.MONGODB_URI?.trim();
  // Hosting dashboards can pass dotenv quotes as literal environment values.
  if(uri&&((uri.startsWith('"')&&uri.endsWith('"'))||(uri.startsWith("'")&&uri.endsWith("'"))))uri=uri.slice(1,-1).trim();
  if(!uri)throw new Error('Set MONGODB_URI in .env to connect SmartLead to MongoDB.');
  try{
    const connection=new ConnectionString(uri);
    const originalDatabase=decodeURIComponent(connection.pathname.slice(1));
    if(connection.username&&!connection.searchParams.has('authSource'))connection.searchParams.set('authSource',connection.isSRV?'admin':originalDatabase||'admin');
    connection.pathname=`/${database}`;
    connection.searchParams.set('appName','SmartLead');
    return {database,url:connection.toString()};
  }catch{throw new Error('MONGODB_URI is invalid. Use a MongoDB connection string with correctly encoded credentials.');}
}
