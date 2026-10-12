import { afterAll,afterEach,describe,expect,it,vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { db,databaseHealth } from '@/lib/db';
import { mongoSettings } from '@/lib/mongo-config';
import { initializeMongoDatabase, mongoDatabase, closeMongoStorage } from '@/lib/mongo-storage';
import { transaction } from '@/lib/engine';
import { GET } from '@/app/api/[...path]/route';
import { POST } from '@/app/api/[...path]/route';
import { Prisma } from '@/generated/mongo';

afterAll(async()=>{await db.$disconnect();await closeMongoStorage();});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('MongoDB storage constraints',()=>{
  it('reports missing hosting configuration without exposing credentials',async()=>{
    vi.stubEnv('MONGODB_URI','');vi.stubEnv('APP_URL','https://hosted.example.com');
    const response=await GET(new Request('https://hosted.example.com/api/health'),{params:Promise.resolve({path:['health']})});
    expect(response.status).toBe(503);
    const result=await response.json();
    expect(result).toMatchObject({error:{code:'DATABASE_UNAVAILABLE'},configuration:{appOrigin:'https://hosted.example.com',database:'mongodb',missing:['MONGODB_URI']}});
    expect(JSON.stringify(result)).not.toContain(process.env.SESSION_SECRET);
    expect(JSON.stringify(result)).not.toContain(process.env.ENCRYPTION_KEY);
    expect(result.diagnostic.reason).toBe('DATABASE_CONFIGURATION');
  });
  it('identifies missing deployment engines through health without exposing private paths',async()=>{
    vi.spyOn(db,'$runCommandRaw').mockRejectedValueOnce(new Prisma.PrismaClientInitializationError('Prisma Client could not locate the Query Engine for runtime "rhel-openssl-3.0.x". Searched /home/private-account/project','6.19.0'));
    const response=await GET(new Request('http://localhost:3000/api/health'),{params:Promise.resolve({path:['health']})});
    const result=await response.json();
    expect(response.status).toBe(503);
    expect(result.diagnostic).toMatchObject({reason:'DATABASE_ENGINE_MISSING',engineTarget:'rhel-openssl-3.0.x'});
    expect(JSON.stringify(result)).not.toContain('private-account');
  });
  it('returns an actionable registration failure when MongoDB rejects credentials',async()=>{
    const privateURI='mongodb+srv://private-user:private-password@cluster.invalid';
    vi.spyOn(db.rateLimit,'upsert').mockRejectedValueOnce(new Prisma.PrismaClientInitializationError(`Authentication failed: ${privateURI}`,'6.19.0','P1000'));
    const response=await POST(new Request('http://localhost:3000/api/auth/register',{method:'POST',headers:{origin:process.env.APP_URL!,'content-type':'application/json'},body:'{}'}),{params:Promise.resolve({path:['auth','register']})});
    const result=await response.json();
    expect(response.status).toBe(503);
    expect(result).toMatchObject({error:{code:'DATABASE_UNAVAILABLE'},diagnostic:{reason:'DATABASE_AUTHENTICATION',prismaCode:'P1000'}});
    expect(result.error.message).toContain('MongoDB authentication failed');
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('persists organisation ownership for both reads and database filters',async()=>{
    const user=await db.user.create({data:{organizationId:'legacy',name:'Owner',email:'mongo-owner@test.invalid',passwordHash:'fixture'}});
    const database=await mongoDatabase();
    expect(await database.collection('users').findOne({_id:user.id} as never,{projection:{organizationId:1}})).toMatchObject({organizationId:'legacy'});
    expect(await db.user.count({where:{organizationId:'legacy',id:user.id}})).toBe(1);
  });
  it('connects to the dedicated database and rolls back failed multi-document writes',async()=>{
    await databaseHealth();
    await expect(transaction(async tx=>{await tx.setting.create({data:{key:'mongo-rollback-test',value:true}});throw new Error('rollback');})).rejects.toThrow('rollback');
    expect(await db.setting.findUnique({where:{key:'mongo-rollback-test'}})).toBeNull();
  });
  it('allows multiple unlinked employees but prevents the same login being linked twice',async()=>{
    await db.employee.createMany({data:[{organizationId:'legacy',id:'mongo-unlinked-a',name:'First',phone:'+919800001111',projects:[]},{organizationId:'legacy',id:'mongo-unlinked-b',name:'Second',phone:'+919800002222',projects:[]}]});
    const user=await db.user.create({data:{organizationId:'legacy',id:'mongo-linked-user',email:'mongo-linked@test.invalid',name:'Test user',passwordHash:'fixture'}});
    await db.employee.update({where:{organizationId:'legacy',id:'mongo-unlinked-a'},data:{userId:user.id}});
    await expect(db.employee.update({where:{organizationId:'legacy',id:'mongo-unlinked-b'},data:{userId:user.id}})).rejects.toMatchObject({code:'P2002'});
  });
  it('protects other databases and refuses an occupied unrecognized project database',async()=>{
    const {url}=mongoSettings();const client=new MongoClient(url);await client.connect();
    try{
      const other=client.db('other_project_test');
      await expect(initializeMongoDatabase(other)).rejects.toThrow('outside the SmartLead namespace');
      const occupied=client.db('smartlead_occupied_test');await occupied.collection('existing').insertOne({keep:true});
      await expect(initializeMongoDatabase(occupied)).rejects.toThrow('unrecognized data');
      expect(await occupied.collection('existing').countDocuments({keep:true})).toBe(1);
      expect(await occupied.collection('settings').countDocuments()).toBe(0);
    }finally{await client.close();}
  });
});
