import { db } from '@/lib/db';

export async function clearTestModels(names:string[]){
  const models=db as unknown as Record<string,{deleteMany:()=>Promise<unknown>}>;
  for(const name of names)await models[name[0].toLowerCase()+name.slice(1)].deleteMany();
}
