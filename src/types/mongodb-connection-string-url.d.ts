// The package's ESM export does not expose its bundled declarations to TypeScript.
declare module 'mongodb-connection-string-url' {
  export default class ConnectionString extends URL {
    constructor(uri:string);
    readonly isSRV:boolean;
  }
}
