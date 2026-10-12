import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const {LoadUtils}=createRequire(import.meta.url)('whatsapp-web.js/src/util/Injected/Utils.js');
// Exercise the exact tsx serialization used by the real worker and Puppeteer.
const compatibilitySource=execFileSync(process.execPath,['node_modules/tsx/dist/cli.mjs','-e',"import {installWhatsAppCompatibility} from './src/lib/whatsapp-compat'; console.log(installWhatsAppCompatibility.toString())"],{encoding:'utf8'});
afterEach(()=>vi.unstubAllGlobals());

describe('WhatsApp message ID compatibility',()=>{
  for(const format of ['$1','_serialized'])it(`submits once and reads the real SDK result with ${format} message IDs`,async()=>{
    let nextId=0;
    class MsgKey{
      [key:string]:unknown;
      constructor(){this[format]=`outgoing-${++nextId}`;}
      static async newId(){return 'new-id';}
    }
    const models=new Map<string,unknown>();
    const submit=vi.fn((_chat:unknown,message:any)=>{
      const id=message.id[format];
      models.set(id,{...message,serialize:()=>({...message,id:{[format]:id,remote:'test@c.us'}})});
      return [Promise.resolve(),Promise.resolve()];
    });
    const modules:Record<string,unknown>={
      WAWebMsgKey:MsgKey,
      WAWebChatGetters:{getIsNewsletter:()=>false,getIsBroadcast:()=>false},
      WALinkify:{findLink:()=>null,findLinks:()=>[]},
      WAWebUserPrefsMeUser:{getMaybeMeLidUser:()=>({}),getMaybeMePnUser:()=>({})},
      WAWebGetEphemeralFieldsMsgActionsUtils:{getEphemeralFields:()=>({})},
      WAWebSendMsgChatAction:{addAndSendMsgToChat:submit},
      WAWebCollections:{Msg:{get:(id:string)=>{if(!id)throw Error('Missing message key');return models.get(id);}}},
    };
    const app:any={require:(name:string)=>{if(!(name in modules))throw Error(`Unexpected module ${name}`);return modules[name];}};
    vi.stubGlobal('window',app);LoadUtils();
    const installWhatsAppCompatibility=runInNewContext(`(${compatibilitySource})`,{window:app});
    installWhatsAppCompatibility();installWhatsAppCompatibility();
    const message=await app.WWebJS.sendMessage({id:{isLid:()=>false}},'Mock lead',{});
    expect(app.WWebJS.getMessageModel(message).id._serialized).toBe('outgoing-1');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
