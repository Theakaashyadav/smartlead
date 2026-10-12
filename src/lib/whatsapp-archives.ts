import { existsSync } from 'node:fs';
import { mkdir,readFile,writeFile,unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GridFSBucket } from 'mongodb';
import { usingSQLite } from './db';
import { mongoDatabase } from './mongo-storage';
import { encrypt,decrypt } from './security';

// Runtime browser profiles stay on the worker; durable RemoteAuth backups use MongoDB.
export class EncryptedAuthStore {
  private filename(session:string){if(!/^[\w-]+$/.test(session))throw new Error('Invalid session identifier');return `${session}.enc`;}
  private file(session:string){return path.resolve(process.env.WHATSAPP_REMOTE_AUTH_DIR||'data/auth-archives',this.filename(session));}
  private async bucket(){return new GridFSBucket(await mongoDatabase(),{bucketName:'whatsapp_archives'});}
  async sessionExists({session}:{session:string}){
    const filename=this.filename(session);
    if(usingSQLite)return existsSync(this.file(session));
    return !!await (await this.bucket()).find({filename}).limit(1).next();
  }
  async save({session}:{session:string}){
    const filename=this.filename(session);
    const zip=await readFile(path.resolve(process.env.WHATSAPP_SESSION_DIR||'data/sessions',`${session}.zip`));
    const encrypted=encrypt(zip.toString('base64'));
    if(usingSQLite){await mkdir(path.dirname(this.file(session)),{recursive:true,mode:0o700});await writeFile(this.file(session),encrypted,{mode:0o600});return;}
    const bucket=await this.bucket();
    const previous=await bucket.find({filename}).project({_id:1}).toArray();
    const upload=bucket.openUploadStream(filename,{metadata:{encrypted:true,format:1}});
    try{await pipeline(Readable.from([Buffer.from(encrypted)]),upload);}
    catch(error){await upload.abort().catch(()=>{});throw error;}
    // Delete only backups observed before this upload, after the replacement is durable.
    for(const archive of previous)await bucket.delete(archive._id);
  }
  async extract({session,path:destination}:{session:string;path:string}){
    const filename=this.filename(session);let encrypted:string;
    if(usingSQLite)encrypted=await readFile(this.file(session),'utf8');
    else{
      const bucket=await this.bucket();const archive=await bucket.find({filename}).sort({uploadDate:-1,_id:-1}).limit(1).next();
      if(!archive)throw new Error('WhatsApp session backup not found');
      const chunks:Buffer[]=[];for await(const chunk of bucket.openDownloadStream(archive._id))chunks.push(Buffer.from(chunk));
      encrypted=Buffer.concat(chunks).toString('utf8');
    }
    await writeFile(destination,Buffer.from(decrypt(encrypted),'base64'),{mode:0o600});
  }
  async delete({session}:{session:string}){
    const filename=this.filename(session);
    if(usingSQLite){await unlink(this.file(session)).catch(error=>{if(error.code!=='ENOENT')throw error;});return;}
    const bucket=await this.bucket();for(const archive of await bucket.find({filename}).project({_id:1}).toArray())await bucket.delete(archive._id);
  }
}
