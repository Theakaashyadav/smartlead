// This code runs in Google's Apps Script runtime, not in the website process.
export function appsScriptCode(spreadsheetId:string,token:string){
  return `// SmartLead connection for this spreadsheet only.
// Keep this code private: its connection key allows SmartLead to read this sheet.
// Save, then Deploy > New deployment > Web app.
// Execute as: Me. Who has access: Anyone. Authorize, deploy, and copy the /exec URL.
var SMARTLEAD_SHEET_ID = ${JSON.stringify(spreadsheetId)};
var SMARTLEAD_KEY = ${JSON.stringify(token)};
`+String.raw`
var SMARTLEAD_PROTOCOL = 'smartlead-apps-script-v1';
var SMARTLEAD_CODE_VERSION = 2;
var SMARTLEAD_OUTPUTS = {sentStatus:'Sent Status',sharedTo:'Shared To',status:'Feedback',feedback:'Remark'};

function doGet() {
  return ContentService.createTextOutput('SmartLead connector is deployed. Use Check connection in SmartLead.');
}
function doPost(e) {
  var lock;
  try {
    var request = JSON.parse(e.postData.contents);
    if (!smartLeadEqual_(request.token, SMARTLEAD_KEY)) return smartLeadReply_({ok:false,code:'AUTH'});
    if (request.spreadsheetId !== SMARTLEAD_SHEET_ID) return smartLeadReply_({ok:false,code:'SOURCE'});
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return smartLeadReply_({ok:false,code:'BUSY'});
    var book = SpreadsheetApp.openById(SMARTLEAD_SHEET_ID);
    var data;
    if (request.action === 'check') {
      var key = 'smartlead_check_' + Utilities.getUuid();
      try { book.addDeveloperMetadata(key, 'access-check'); }
      finally { book.createDeveloperMetadataFinder().withKey(key).find().forEach(function(tag){tag.remove();}); }
      data = {title:book.getName(),codeVersion:SMARTLEAD_CODE_VERSION,canRead:true,canWrite:true,challenge:request.challenge,
        tabs:book.getSheets().map(function(tab){return {id:tab.getSheetId(),name:tab.getName(),headers:tab.getRange(1,1,1,Math.max(1,tab.getLastColumn())).getDisplayValues()[0].map(function(value){return value.trim();})};})};
    } else {
      var tab = book.getSheets().filter(function(item){return item.getSheetId() === request.worksheetId;})[0];
      if (!tab) return smartLeadReply_({ok:false,code:'TAB'});
      if (request.action === 'read') data = {rows:tab.getDataRange().getDisplayValues()};
      else if (request.action === 'prepare') data = smartLeadPrepare_(tab,request);
      else if (request.action === 'write') data = smartLeadWrite_(tab,request);
      else return smartLeadReply_({ok:false,code:'REQUEST'});
    }
    return smartLeadReply_({ok:true,data:data});
  } catch (error) {
    var known = ['SOURCE','CONFLICT','REQUEST','VERIFY','PROTECTED'];
    var stage = request && request._stage;
    return smartLeadReply_({ok:false,code:known.indexOf(error.message)>=0?error.message:'SCRIPT',stage:['SOURCE','LAYOUT','PERMISSION','SAVE','VERIFY'].indexOf(stage)>=0?stage:undefined});
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}
function smartLeadReply_(result) {
  result.protocol = SMARTLEAD_PROTOCOL; result.spreadsheetId = SMARTLEAD_SHEET_ID;
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
function smartLeadEqual_(a,b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  var difference = 0; for (var i=0;i<b.length;i++) difference |= a.charCodeAt(i)^b.charCodeAt(i);
  return difference === 0;
}
function smartLeadHeading_(value) { return String(value).trim().toLowerCase().replace(/[\s_]+/g,''); }
function smartLeadColumn_(headers,label) {
  var found=[];headers.forEach(function(header,index){if(smartLeadHeading_(header)===smartLeadHeading_(label))found.push(index);});
  if(found.length>1)throw new Error('CONFLICT');
  return found.length?found[0]:-1;
}
function smartLeadMatches_(headers,row,identity) {
  return identity.every(function(cell){var index=headers.indexOf(cell.column);return index>=0 && String(row[index]||'').trim()===cell.value;});
}
function smartLeadFindRow_(tab,request) {
  if(!request.identity || !request.identity.length || !request.stableId || !/^smartlead_[\w-]+$/.test(request.metadataKey))throw new Error('REQUEST');
  var rows=tab.getDataRange().getDisplayValues(),headers=rows[0].map(function(value){return value.trim();});
  var matches=[];
  for(var i=1;i<rows.length;i++)if(smartLeadMatches_(headers,rows[i],request.identity))matches.push(i+1);
  if(matches.length!==1)throw new Error('SOURCE');
  // Unique source identity is always required. Row metadata is an extra guard;
  // a metadata service failure must not block that verified source identity.
  var tags=[];
  try { tags=tab.createDeveloperMetadataFinder().withKey(request.metadataKey).withValue(request.stableId).find(); }
  catch (metadataError) { tags=[]; }
  if(tags.length>1)throw new Error('SOURCE');
  if(tags.length){
    var range=tags[0].getLocation().getRow();
    if(!range || range.getRow()!==matches[0])throw new Error('SOURCE');
  }else{
    try { tab.getRange(matches[0]+':'+matches[0]).addDeveloperMetadata(request.metadataKey,request.stableId,SpreadsheetApp.DeveloperMetadataVisibility.DOCUMENT); }
    catch (metadataError) { /* The unique original source identity is still verified before and after saving. */ }
  }
  return matches[0];
}
function smartLeadLayout_(tab) {
  var headers=tab.getRange(1,1,1,Math.max(1,tab.getLastColumn())).getDisplayValues()[0];
  var normalized=headers.map(smartLeadHeading_);
  var legacy=normalized.indexOf('leadstatus')>=0 && normalized.indexOf('remark')<0?smartLeadColumn_(headers,'Feedback'):-1;
  if(legacy>=0){tab.getRange(1,legacy+1).setValue('Remark');headers[legacy]='Remark';}
  var labels=Object.keys(SMARTLEAD_OUTPUTS).map(function(field){return SMARTLEAD_OUTPUTS[field];});
  var missing=labels.filter(function(label){return smartLeadColumn_(headers,label)<0;});
  if(missing.length){
    var start=Math.max(1,tab.getLastColumn());
    if(start+missing.length>tab.getMaxColumns())tab.insertColumnsAfter(tab.getMaxColumns(),start+missing.length-tab.getMaxColumns());
    tab.getRange(1,start+1,1,missing.length).setValues([missing]);
  }
  // Move complete columns, keeping original values, formulas and source order.
  for(var i=labels.length-1;i>=0;i--){
    headers=tab.getRange(1,1,1,tab.getLastColumn()).getDisplayValues()[0];
    var source=smartLeadColumn_(headers,labels[i])+1;
    var target=tab.getLastColumn()-(labels.length-1-i);
    if(source!==target)tab.moveColumns(tab.getRange(1,source,tab.getMaxRows(),1),source<target?target+1:target);
  }
  return tab.getRange(1,1,1,tab.getLastColumn()).getDisplayValues()[0];
}
function smartLeadWrite_(tab,request) {
  var values=request.values,snapshot=request.snapshot||{};
  if(!values || !Object.keys(values).length || Object.keys(values).some(function(field){return !Object.prototype.hasOwnProperty.call(SMARTLEAD_OUTPUTS,field) || typeof values[field]!=='string';}))throw new Error('REQUEST');
  // Resolve the original lead before changing the output layout.
  request._stage='SOURCE';smartLeadFindRow_(tab,request);
  request._stage='LAYOUT';
  var headers=smartLeadLayout_(tab),rowNumber=smartLeadFindRow_(tab,request);
  var row=tab.getRange(rowNumber,1,1,headers.length).getDisplayValues()[0];
  request._stage='PERMISSION';
  Object.keys(values).forEach(function(field){
    if(!tab.getRange(rowNumber,smartLeadColumn_(headers,SMARTLEAD_OUTPUTS[field])+1).canEdit())throw new Error('PROTECTED');
  });
  request._stage='SAVE';
  Object.keys(values).forEach(function(field){
    var actual=row[smartLeadColumn_(headers,SMARTLEAD_OUTPUTS[field])]||'';
    var expected=field==='status'&&!snapshot.__publicOutputV2&&!actual?'':snapshot[field];
    if(expected===undefined)expected=field==='sharedTo'?(snapshot.assignedEmployee||''):'';
    if(Object.prototype.hasOwnProperty.call(snapshot,field)&&actual!==expected&&actual!==values[field])throw new Error('CONFLICT');
  });
  Object.keys(values).forEach(function(field){
    var cell=tab.getRange(rowNumber,smartLeadColumn_(headers,SMARTLEAD_OUTPUTS[field])+1);
    // Rich text writes literal text, including remarks beginning with '='.
    if(values[field])cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(values[field]).build());
    else cell.clearContent();
  });
  SpreadsheetApp.flush();
  request._stage='VERIFY';
  var checkedHeaders=tab.getRange(1,1,1,tab.getLastColumn()).getDisplayValues()[0];
  var checkedRow=tab.getRange(rowNumber,1,1,checkedHeaders.length).getDisplayValues()[0];
  if(!smartLeadMatches_(checkedHeaders,checkedRow,request.identity))throw new Error('VERIFY');
  Object.keys(values).forEach(function(field){var index=smartLeadColumn_(checkedHeaders,SMARTLEAD_OUTPUTS[field]);if(index<0 || (checkedRow[index]||'')!==values[field])throw new Error('VERIFY');});
  var observed={};Object.keys(SMARTLEAD_OUTPUTS).forEach(function(field){observed[field]=checkedRow[smartLeadColumn_(checkedHeaders,SMARTLEAD_OUTPUTS[field])]||'';});
  return {values:observed};
}
function smartLeadPrepare_(tab,request) {
  request._stage='LAYOUT';var headers=smartLeadLayout_(tab);
  request._stage='PERMISSION';
  Object.keys(SMARTLEAD_OUTPUTS).forEach(function(field){
    if(!tab.getRange(1,smartLeadColumn_(headers,SMARTLEAD_OUTPUTS[field])+1,tab.getMaxRows(),1).canEdit())throw new Error('PROTECTED');
  });
  // Exercise the same write method on the managed headings. Customer rows and
  // their existing output values remain untouched during connection checking.
  request._stage='SAVE';
  Object.keys(SMARTLEAD_OUTPUTS).forEach(function(field){
    tab.getRange(1,smartLeadColumn_(headers,SMARTLEAD_OUTPUTS[field])+1).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(SMARTLEAD_OUTPUTS[field]).build());
  });
  SpreadsheetApp.flush();request._stage='VERIFY';
  var checked=tab.getRange(1,1,1,tab.getLastColumn()).getDisplayValues()[0];
  Object.keys(SMARTLEAD_OUTPUTS).forEach(function(field){if(smartLeadColumn_(checked,SMARTLEAD_OUTPUTS[field])<0)throw new Error('VERIFY');});
  return {canWriteOutputs:true};
}
`;
}
