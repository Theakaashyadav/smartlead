import { describe,expect,it } from 'vitest';
import { Prisma } from '@/generated/mongo';
import { databaseFailure,safeDatabaseErrorCode } from '@/lib/database-errors';

const privateDetails='mongodb+srv://private-user:private-password@private-cluster.invalid/secret_database';
describe('safe database failure diagnostics',()=>{
  it('reads the initialization errorCode and hides connection credentials',()=>{
    const error=new Prisma.PrismaClientInitializationError(`Authentication failed at ${privateDetails}`,'6.19.0','P1000');
    expect(safeDatabaseErrorCode(error)).toBe('P1000');
    expect(databaseFailure(error)).toMatchObject({reason:'DATABASE_AUTHENTICATION',prismaCode:'P1000'});
    expect(JSON.stringify(databaseFailure(error))).not.toContain('private-');
  });
  it('identifies the missing runtime engine without exposing searched filesystem paths',()=>{
    const error=new Prisma.PrismaClientInitializationError('Prisma Client could not locate the Query Engine for runtime "rhel-openssl-3.0.x". Searched /home/private-user/private-project','6.19.0');
    const diagnostic=databaseFailure(error);
    expect(diagnostic).toMatchObject({reason:'DATABASE_ENGINE_MISSING',engineTarget:'rhel-openssl-3.0.x'});
    expect(JSON.stringify(diagnostic)).not.toContain('private-');
  });
  it.each([
    ['P1001','Cannot connect','DATABASE_NETWORK'],
    ['P1011','TLS connection failed','DATABASE_TLS'],
    ['P1010','Access denied','DATABASE_PERMISSION'],
    ['P1013','Invalid URI','DATABASE_CONFIGURATION'],
    ['P2031','Replica set required','DATABASE_REPLICA_SET'],
    [undefined,'Unable to require libquery_engine-rhel-openssl-3.0.x.so.node: libssl.so.3 missing','DATABASE_ENGINE_INCOMPATIBLE'],
    [undefined,'DNS querySrv ENOTFOUND','DATABASE_DNS']
  ])('classifies %s %s without returning raw error details',(code,message,reason)=>{
    const error=new Prisma.PrismaClientInitializationError(`${message}: ${privateDetails}`,'6.19.0',code);
    expect(databaseFailure(error)).toMatchObject({reason});
    expect(JSON.stringify(databaseFailure(error))).not.toContain('private-');
  });
  it('recognizes MongoDB authentication and permissions inside raw-query errors',()=>{
    for(const [code,reason] of [[18,'DATABASE_AUTHENTICATION'],[13,'DATABASE_PERMISSION']] as const){
      const error=new Prisma.PrismaClientKnownRequestError(`Raw query failed: ${privateDetails}`,{clientVersion:'6.19.0',code:'P2010',meta:{code:String(code),message:privateDetails}});
      expect(databaseFailure(error)).toMatchObject({reason,prismaCode:'P2010'});
      expect(JSON.stringify(databaseFailure(error))).not.toContain('private-');
    }
  });
  it('identifies the Hostinger resolver parsing failure without exposing private details',()=>{
    const error=new Prisma.PrismaClientInitializationError(`Error in connector: Error creating a database connection. (Kind: An error occurred during DNS resolution: io error: Error parsing resolv.conf: option at line 5 is not recognized, labels: {}, source: None) ${privateDetails}`,'6.19.0');
    const diagnostic=databaseFailure(error);
    expect(diagnostic).toMatchObject({reason:'DATABASE_DNS'});
    expect(diagnostic?.message).toContain('standard MongoDB connection string with TLS enabled');
    expect(JSON.stringify(diagnostic)).not.toContain('private-');
    expect(JSON.stringify(diagnostic)).not.toContain('option at line 5');
  });
  it('leaves ordinary application and record errors to the existing error handler',()=>{
    expect(databaseFailure(new Error(`Authentication failed: ${privateDetails}`))).toBeNull();
    expect(databaseFailure(new Prisma.PrismaClientKnownRequestError('Unique constraint failed',{clientVersion:'6.19.0',code:'P2002'}))).toBeNull();
    expect(safeDatabaseErrorCode({code:privateDetails})).toBe('UNKNOWN');
  });
});
