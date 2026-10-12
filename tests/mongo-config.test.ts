import { describe,expect,it } from 'vitest';
import { mongoSettings } from '@/lib/mongo-config';

describe('separate SmartLead MongoDB database',()=>{
  it('selects smartlead while preserving credentials and existing authentication options',()=>{
    const result=mongoSettings({MONGODB_URI:'mongodb://user:password@host.example:27017/otherproject?authSource=admin&replicaSet=rs0'});
    expect(result.database).toBe('smartlead');expect(result.url).toContain('/smartlead?');
    expect(result.url).toContain('authSource=admin');expect(result.url).toContain('replicaSet=rs0');expect(result.url).toContain('appName=SmartLead');
  });
  it('preserves a standard connection authentication database when replacing its data database',()=>{
    const result=mongoSettings({MONGODB_URI:'mongodb://user:password@host1.example:27017,host2.example:27017/otherproject?replicaSet=rs0'});
    expect(result.url).toContain('/smartlead?');expect(result.url).toContain('authSource=otherproject');expect(result.url).toContain('host1.example:27017,host2.example:27017');
  });
  it.each(['"',"'"])('accepts a hosting environment value wrapped in %s without changing encoded credentials',(quote)=>{
    const uri='mongodb://user:p%40ss%23word%24@host1.example:27017,host2.example:27017/smartlead?authSource=admin&replicaSet=rs0&tls=true';
    const expected=mongoSettings({MONGODB_URI:uri});
    expect(mongoSettings({MONGODB_URI:`  ${quote}${uri}${quote}\r\n`})).toEqual(expected);
    expect(expected.url).toContain('p%40ss%23word%24');
    expect(expected.url).toContain('tls=true');
  });
  it('rejects mismatched quotes without returning connection credentials',()=>{
    const uri='mongodb://private-user:private-password@host.example/smartlead';
    expect(()=>mongoSettings({MONGODB_URI:`"${uri}'`})).toThrow('MONGODB_URI is invalid. Use a MongoDB connection string with correctly encoded credentials.');
  });
  it('supports Atlas and isolated test databases without exposing credentials in errors',()=>{
    expect(mongoSettings({MONGODB_URI:'mongodb+srv://user:password@cluster.example/',MONGODB_DATABASE:'smartlead_test_123'})).toMatchObject({database:'smartlead_test_123'});
    expect(()=>mongoSettings({MONGODB_URI:'invalid-with-secret'})).toThrow('MONGODB_URI is invalid.');
    expect(()=>mongoSettings({MONGODB_URI:'mongodb://host',MONGODB_DATABASE:'admin'})).toThrow('MONGODB_DATABASE must be smartlead');
    expect(()=>mongoSettings({})).toThrow('Set MONGODB_URI');
  });
});
