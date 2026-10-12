// WhatsApp Web renamed MsgKey._serialized to $1. Keep the SDK's lookups
// compatible without changing its send implementation or creating a new chat.
export function installWhatsAppCompatibility() {
  type Key={_serialized?:string;$1?:string};
  const app=window as unknown as {
    require:(name:string)=>{prototype:Key};
    WWebJS:{getMessageModel:((message:unknown)=>{id?:Key})&{smartLeadCompatible?:boolean}};
  };
  const prototype=app.require('WAWebMsgKey').prototype;
  if(!('_serialized' in prototype))Object.defineProperty(prototype,'_serialized',{
    configurable:true,get(this:Key){return this.$1;},
    set(this:Key,value:string){Object.defineProperty(this,'_serialized',{configurable:true,enumerable:true,writable:true,value});},
  });
  const original=app.WWebJS.getMessageModel;
  if(!original.smartLeadCompatible){
    // Object method syntax keeps this function self-contained when tsx enables
    // keepNames; a named arrow would reference a helper outside the browser.
    const compatible:typeof original={model(message:unknown){
      const model=original(message);
      if(model.id&&!model.id._serialized&&model.id.$1)model.id._serialized=model.id.$1;
      return model;
    }}.model;
    compatible.smartLeadCompatible=true;
    app.WWebJS.getMessageModel=compatible;
  }
}
