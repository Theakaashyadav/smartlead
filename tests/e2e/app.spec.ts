import { test, expect } from '@playwright/test';
async function login(page:any){await page.goto('/login');await page.getByRole('button',{name:'Log in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);await expect(page.getByRole('heading',{name:'Your leads. Sent automatically.'})).toBeVisible();}

test('two organisation owners create separate accounts and keep their connections when switching logins',async({page,browser})=>{
  const suffix=Date.now().toString().slice(-9);const phone=`9${suffix}`,otherPhone=`8${suffix}`,pin='4826';
  await page.goto('/login');
  await expect(page.getByLabel('Phone number',{exact:false})).toBeVisible();await expect(page.getByLabel(/^PIN/)).toBeVisible();
  await page.screenshot({path:'data/phone-login-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'data/phone-login-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1050});
  await page.getByRole('link',{name:'Create an account',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Create your organisation'})).toBeVisible();
  await page.screenshot({path:'data/simple-registration-desktop.png',fullPage:true});
  await page.getByLabel('Your name',{exact:true}).fill('Manager One');await page.getByLabel('Organisation name',{exact:true}).fill('Agency One');
  await page.getByLabel('Phone number',{exact:false}).fill(phone);await page.getByLabel(/^PIN/).fill(pin);await page.getByLabel('Confirm PIN',{exact:true}).fill(pin);
  await page.getByRole('button',{name:'Create organisation account'}).click();await expect(page).toHaveURL(/dashboard/);
  await expect(page.getByLabel('Current organisation')).toContainText('Agency One');await expect(page.getByLabel('Current organisation')).toContainText(phone);
  const one=(await (await page.request.get('/api/simple/state')).json()).data;expect(one.sheets).toEqual([]);expect(one.account).toBeNull();
  await page.request.post('/api/simple/whatsapp/connect');
  const connectionOne=(await (await page.request.get('/api/simple/state')).json()).data.account;
  const context=await browser.newContext();const other=await context.newPage();
  try{
    await other.goto(new URL('/register',page.url()).href);
    await other.getByLabel('Your name',{exact:true}).fill('Manager Two');await other.getByLabel('Organisation name',{exact:true}).fill('Agency Two');
    await other.getByLabel('Phone number',{exact:false}).fill(otherPhone);await other.getByLabel(/^PIN/).fill(pin);await other.getByLabel('Confirm PIN',{exact:true}).fill(pin);
    await other.getByRole('button',{name:'Create organisation account'}).click();await expect(other).toHaveURL(/dashboard/);
    await expect(other.getByLabel('Current organisation')).toContainText('Agency Two');
    const two=(await (await other.request.get('/api/simple/state')).json()).data;expect(two.organization.id).not.toBe(one.organization.id);expect(two.sheets).toEqual([]);expect(two.account).toBeNull();
    expect((await other.request.get(`/api/whatsapp/${connectionOne.id}/qr`)).status()).toBe(404);
    await other.request.post('/api/simple/whatsapp/connect');const connectionTwo=(await (await other.request.get('/api/simple/state')).json()).data.account;
    expect(connectionTwo.id).not.toBe(connectionOne.id);
    await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(/login/);
    await page.getByLabel('Phone number',{exact:false}).fill(phone);await page.getByLabel(/^PIN/).fill(pin);await page.getByRole('button',{name:'Log in',exact:true}).click();
    await expect(page).toHaveURL(/dashboard/);await expect(page.getByLabel('Current organisation')).toContainText('Agency One');
    expect((await (await page.request.get('/api/simple/state')).json()).data.account.id).toBe(connectionOne.id);
    await page.getByRole('button',{name:'Login & PIN',exact:true}).click();
    await page.getByLabel('Current PIN',{exact:true}).fill(pin);await page.getByLabel('New PIN',{exact:false}).fill('0482');await page.getByLabel('Confirm PIN',{exact:true}).fill('0482');
    await page.getByRole('button',{name:'Save phone & PIN'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(/login/);
    await page.getByLabel('Phone number',{exact:false}).fill(phone);await page.getByLabel(/^PIN/).fill(pin);await page.getByRole('button',{name:'Log in',exact:true}).click();
    await expect(page.locator('.simple-login').getByRole('alert')).toContainText('Phone number, PIN, or verification code is incorrect');
    await page.getByLabel(/^PIN/).fill('0482');await page.getByRole('button',{name:'Log in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);
    expect((await (await page.request.get('/api/simple/state')).json()).data.account.id).toBe(connectionOne.id);
  }finally{await context.close();}
});

test('login opens two connection cards and the real local connection pages',async({page})=>{
  await login(page);
  await expect(page.locator('.simple-connect-card')).toHaveCount(2);
  await expect(page.getByRole('link',{name:'Connect Sheets',exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'Connect WhatsApp',exact:false})).toBeVisible();
  await page.screenshot({path:'data/simple-dashboard-desktop.png',fullPage:true});
  await page.getByRole('link',{name:'Connect Sheets',exact:false}).click();
  await expect(page.getByRole('heading',{name:'Your Google Sheets'})).toBeVisible();
  await page.getByRole('button',{name:/^Connect (?:another )?sheet$/}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Google Sheets link')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Connect Google once'})).toHaveCount(0);
  await expect(page.getByLabel('Google service-account key')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('link',{name:'WhatsApp',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your WhatsApp'})).toBeVisible();
  await expect(page.getByText('One account for all your connected sheets.')).toBeVisible();
  await expect(page.getByRole('heading',{name:/Link WhatsApp Web|WhatsApp connected/})).toBeVisible();
  const connection=await (await page.request.get('/api/simple/state')).json();
  if(connection.data.whatsappLoginMode==='background'||connection.data.whatsappLoginMode==='qr'){
    await expect(page.getByRole('button',{name:'Open WhatsApp Web',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:/^(Connect WhatsApp|Disconnect account|Waiting for scan|Try again)$/})).toBeVisible();
    await expect(page.getByText('Keep it open.',{exact:false})).toHaveCount(0);
  }else{
    await expect(page.getByRole('button',{name:'Open WhatsApp Web',exact:true})).toBeVisible();
    await expect(page.getByRole('img',{name:/Scan this QR code/})).toHaveCount(0);
  }
});

test('a pasted sheet link offers Apps Script code and checks access before connecting',async({page})=>{
  const sheet={id:'script-sheet-test',name:'Private leads',worksheetName:'Incoming',appsScriptConnected:true,enabled:false,leadCount:0,recipients:[],lastSyncError:null};
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:{id:'web',status:'CONNECTED',phone:'+919876543212',qrCode:null,lastError:null},sheets:[] as typeof sheet[]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));await page.route('**/api/simple/contacts',route=>route.fulfill({json:{data:{contacts:[]}}}));await page.route('**/api/simple/contacts/refresh',route=>route.fulfill({json:{data:{refreshing:true}}}));
  const url='https://docs.google.com/spreadsheets/d/script-test-spreadsheet-123456789/edit#gid=42';
  let prepared:any;let checked:any;let saved:any;let popups=0;page.on('popup',()=>{popups++;});
  await page.route('**/api/simple/sheets/script',route=>{prepared=route.request().postDataJSON();return route.fulfill({json:{data:{setupId:'test-setup',sheetUrl:url,code:'function doPost(e) { return ContentService.createTextOutput("test"); }'}}});});
  await page.route('**/api/simple/sheets/script/check',route=>{checked=route.request().postDataJSON();return route.fulfill({json:{data:{scriptSetupId:'test-setup',spreadsheetId:'script-test-spreadsheet-123456789',title:'Private leads',gid:42,canRead:true,canWrite:true,tabs:[{id:0,name:'Other',headers:['Full Name','Phone Number']},{id:42,name:'Incoming',headers:['Name','Phone']}]}}});});
  await page.route('**/api/simple/sheets',route=>{saved=route.request().postDataJSON();state.sheets=[sheet];return route.fulfill({json:{data:{id:sheet.id}}});});
  await login(page);await page.goto('/sheets');await page.getByRole('button',{name:'Connect sheet',exact:true}).first().click();await page.getByLabel('Google Sheets link').fill(url);await page.getByLabel('Project name',{exact:true}).fill('Corbett Meadows');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByLabel('Apps Script code')).toContainText('function doPost');await expect(page.getByRole('button',{name:'Copy Apps Script code'})).toBeVisible();expect(checked).toBeUndefined();
  await expect(page.getByRole('dialog')).toContainText('Who has access: Anyone');await page.screenshot({path:'data/apps-script-setup-desktop.png',fullPage:true});
  const endpoint='https://script.google.com/macros/s/AKfycb_test_deployment_123456789/exec';await page.getByLabel('Apps Script web app URL').fill(endpoint);await page.getByRole('button',{name:'Check connection',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('read and write access confirmed');await expect(page.getByLabel('Sheet tab')).toHaveValue('42');await expect(page.getByLabel('Customer name column')).toHaveValue('Name');await expect(page.getByLabel('Phone number column')).toHaveValue('Phone');
  await page.getByRole('dialog').getByRole('button',{name:'Connect sheet',exact:true}).click();await expect(page.getByRole('heading',{name:'Who should receive these leads?'})).toBeVisible();
  expect(prepared).toEqual({url});expect(checked).toEqual({setupId:'test-setup',endpoint});expect(saved).toEqual({scriptSetupId:'test-setup',spreadsheetId:'script-test-spreadsheet-123456789',worksheetId:42,columnMapping:{customerName:'Name',mobile:'Phone'},project:'Corbett Meadows'});expect(popups).toBe(0);
});

test('Apps Script reconnect keeps the existing sheet and recipients',async({page})=>{
  const sheet={id:'existing-sheet',name:'Existing leads',worksheetName:'Incoming',appsScriptConnected:false,enabled:false,leadCount:9,recipients:[{name:'Person',phone:'+919876543210'}],lastSyncError:null};
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:null,sheets:[sheet]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));let prepared:any;
  await page.route('**/api/simple/sheets/script',route=>{prepared=route.request().postDataJSON();return route.fulfill({json:{data:{setupId:'existing-setup',sheetUrl:'https://docs.google.com/spreadsheets/d/existing-test-spreadsheet-123456789/edit#gid=42',code:'function doPost(e) {}'}}});});
  await page.route('**/api/simple/sheets/script/check',route=>route.fulfill({json:{data:{scriptSetupId:'existing-setup',spreadsheetId:'existing-test-spreadsheet-123456789',title:sheet.name,gid:42,canRead:true,canWrite:true,tabs:[{id:42,name:'Incoming',headers:['Name','Phone']}]}}}));
  await page.route('**/api/simple/sheets',route=>{sheet.appsScriptConnected=true;return route.fulfill({json:{data:{id:sheet.id,reauthorized:true}}});});
  await login(page);await page.goto('/sheets');await page.getByRole('button',{name:'Connect Apps Script',exact:true}).click();await expect(page.getByLabel('Apps Script code')).toBeVisible();expect(prepared).toEqual({sheetId:sheet.id});
  await page.getByLabel('Apps Script web app URL').fill('https://script.google.com/macros/s/AKfycb_test_deployment_123456789/exec');await page.getByRole('button',{name:'Check connection',exact:true}).click();await page.getByRole('button',{name:'Save connection',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Reconnect Apps Script',exact:true})).toBeVisible();await expect(page.getByText('9 leads imported',{exact:true})).toBeVisible();await expect(page.getByText('Person',{exact:true})).toBeVisible();
});

test('Apps Script deployment errors keep the code and retry form available on mobile',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/simple/sheets/script',route=>route.fulfill({json:{data:{setupId:'test-setup',sheetUrl:'https://docs.google.com/spreadsheets/d/script-test-spreadsheet-123456789/edit',code:'function doPost(e) {}'}}}));
  await page.route('**/api/simple/sheets/script/check',route=>route.fulfill({status:400,json:{error:{message:'Deploy the script as a Web app, Execute as Me, with access set to Anyone.'}}}));
  await login(page);await page.goto('/sheets');await page.getByRole('button',{name:'Connect sheet',exact:true}).first().click();await page.getByLabel('Google Sheets link').fill('https://docs.google.com/spreadsheets/d/script-test-spreadsheet-123456789/edit');await page.getByLabel('Project name',{exact:true}).fill('Corbett Meadows');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Apps Script web app URL').fill('https://script.google.com/macros/s/AKfycb_test_deployment_123456789/exec');await page.getByRole('button',{name:'Check connection',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('access set to Anyone');await expect(page.getByRole('button',{name:'Check connection',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'data/apps-script-setup-mobile.png',fullPage:true});
});
test('an existing sheet project can be changed without reconnecting its script',async({page})=>{
  const sheet={id:'project-sheet',name:'Meta sheet title',project:'Old project',worksheetName:'Incoming',appsScriptConnected:true,enabled:false,leadCount:9,recipients:[],lastSyncError:null};
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:null,sheets:[sheet]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));let saved:any;let scriptOpened=false;
  await page.route('**/api/simple/sheets/script',route=>{scriptOpened=true;return route.abort();});
  await page.route('**/api/simple/sheets/project-sheet/project',route=>{saved=route.request().postDataJSON();sheet.project=saved.project;return route.fulfill({json:{data:{project:sheet.project}}});});
  await login(page);await page.goto('/sheets');await page.getByRole('button',{name:'Edit project',exact:true}).click();
  await expect(page.getByLabel('Project name',{exact:true})).toHaveValue('Old project');await page.getByLabel('Project name',{exact:true}).fill('Corbett Meadows');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'data/project-name-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Save project name',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('article')).toContainText('Project: Corbett Meadows');await expect(page.getByRole('heading',{name:'Meta sheet title',exact:true})).toBeVisible();expect(saved).toEqual({project:'Corbett Meadows'});expect(scriptOpened).toBe(false);
});

test('offline WhatsApp connections show an error and keep the retry button usable',async({page})=>{
  const workerMessage='WhatsApp connection service is offline. Start the SmartLead worker on your hosting server, then try again.';
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:false,workerMessage,whatsappLoginMode:'background',account:{id:'web',status:'CONNECTING',phone:null,qrCode:'data:image/png;base64,expired',lastError:null},sheets:[]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));
  let connections=0;
  await page.route('**/api/simple/whatsapp/connect',route=>{connections++;return route.fulfill({status:503,json:{error:{code:'WHATSAPP_WORKER_OFFLINE',message:workerMessage}}});});
  await login(page);await page.goto('/whatsapp');
  await expect(page.getByText('WhatsApp connection service is offline.',{exact:true})).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(workerMessage);
  await expect(page.getByRole('img',{name:/Scan this QR code/})).toHaveCount(0);
  const connect=page.getByRole('button',{name:'Connect WhatsApp',exact:true});await expect(connect).toBeEnabled();await connect.click();
  await expect(page.locator('.simple-main').getByRole('alert')).toContainText(workerMessage);await expect(connect).toBeEnabled();expect(connections).toBe(1);
});

test('WhatsApp connect shows progress then the worker QR code without opening another window',async({page})=>{
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,whatsappLoginMode:'qr',account:null as null|{id:string;status:string;phone:null;qrCode:string|null;lastError:null},sheets:[]};
  let connections=0;let connectionReads=0;let windows=0;page.on('popup',()=>{windows++;});
  await page.route('**/api/simple/state',route=>{
    if(state.account&&++connectionReads>1)state.account={...state.account,status:'WAITING_QR',qrCode:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQYQAAAAASUVORK5CYII='};
    return route.fulfill({json:{data:state}});
  });
  await page.route('**/api/simple/whatsapp/connect',route=>{connections++;state.account={id:'web',status:'CONNECTING',phone:null,qrCode:null,lastError:null};return route.fulfill({json:{data:{connecting:true}}});});
  await login(page);await page.goto('/whatsapp');await page.getByRole('button',{name:'Connect WhatsApp',exact:true}).click();
  await expect(page.getByText('Connecting to WhatsApp…',{exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:/Scan this QR code/})).toBeVisible({timeout:10000});
  await expect(page.getByRole('button',{name:'Waiting for scan',exact:true})).toBeDisabled();
  await expect(page.getByText('On your phone, open WhatsApp → Linked devices → Link a device.',{exact:true})).toBeVisible();
  expect(connections).toBe(1);expect(windows).toBe(0);
});

test('contact picker preserves selection order and accepts a new-conversation number',async({page})=>{
  const contacts=[{name:'Akash',phone:'+919876543210'},{name:'Aman',phone:'+919876543211'}];
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:{id:'web',status:'CONNECTED',phone:'+919876543212',qrCode:null,lastError:null},sheets:[{id:'sheet-test',name:'My leads',worksheetName:'Sheet1',enabled:false,leadCount:0,recipients:[],lastSyncError:null}]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));
  await page.route('**/api/simple/contacts',route=>route.fulfill({json:{data:{contacts}}}));
  await page.route('**/api/simple/contacts/refresh',route=>route.fulfill({json:{data:{refreshing:true}}}));
  let saved:any;
  await page.route('**/api/simple/sheets/sheet-test/recipients',route=>{saved=route.request().postDataJSON();return route.fulfill({json:{data:{started:true}}});});
  await login(page);await page.goto('/sheets');
  await page.getByRole('button',{name:'Choose recipients'}).click();
  await page.getByRole('checkbox',{name:/Aman/}).check();
  await page.getByRole('checkbox',{name:/Akash/}).check();
  await page.getByLabel('Recipient name',{exact:true}).fill('New person');
  await page.getByLabel('Recipient phone number').fill('+919876543219');
  await page.getByRole('button',{name:'Add',exact:true}).click();
  await expect(page.getByText('3 selected',{exact:true})).toBeVisible();
  await expect(page.locator('.simple-selected-order')).toContainText('Aman → Akash → New person → repeat');
  await page.getByRole('button',{name:'Save & start sending'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(saved.recipients.map((p:any)=>p.phone)).toEqual(['+919876543211','+919876543210','+919876543219']);
});

test('sheet cards show queued, submitted and failed sends',async({page})=>{
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:{id:'web',status:'CONNECTED',phone:'+919876543212',qrCode:null,lastError:null},sheets:[{id:'sheet-status',name:'My leads',worksheetName:'Sheet1',enabled:true,leadCount:6,recipients:[{name:'Person',phone:'+919876543210'}],lastSyncError:null,delivery:{submitted:3,queued:2,failed:1,error:'This phone number is not registered on WhatsApp.'}}]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));
  await login(page);await page.goto('/sheets');
  await expect(page.getByText('Some sends need checking',{exact:true})).toBeVisible();
  await expect(page.getByText('3 submitted to WhatsApp · 2 queued · 1 need checking',{exact:true})).toBeVisible();
  await expect(page.locator('article').getByRole('alert')).toHaveText('This phone number is not registered on WhatsApp.');
});
test('sheet update retry shows the script problem and clears waiting only after confirmation',async({page})=>{
  const error='Apps Script failed while saving the output cells. Reconnect Apps Script and deploy a new version.';
  const sheet={id:'sheet-retry',name:'Lead updates',worksheetName:'Incoming',enabled:false,appsScriptConnected:true,leadCount:1,recipients:[],lastSyncError:null,writeback:{pending:1,failed:0,error:null as string|null}};
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:null,sheets:[sheet]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));let calls=0;
  await page.route('**/api/simple/sheets/sheet-retry/writeback',route=>{calls++;sheet.writeback=calls===1?{pending:0,failed:1,error}:{pending:0,failed:0,error:null};return route.fulfill({json:{data:{attempted:1,remaining:calls===1?1:0,writeback:{status:calls===1?'ERROR':'SYNCED',error:calls===1?error:null}}}});});
  await login(page);await page.goto('/sheets');await expect(page.getByText('1 lead updating Google Sheet.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Update sheet now',exact:true}).click();
  await expect(page.locator('article').getByRole('alert')).toHaveText(error);await expect(page.getByText('1 sheet update failed.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Update sheet now',exact:true})).toBeEnabled();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'data/sheet-update-retry-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Update sheet now',exact:true}).click();await expect(page.getByRole('button',{name:'Update sheet now',exact:true})).toHaveCount(0);await expect(page.locator('article').getByRole('alert')).toHaveCount(0);expect(calls).toBe(2);
});

test('mobile stays simple and unauthenticated users must log in',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'data/simple-dashboard-mobile.png',fullPage:true});
  await page.goto('/reports');await expect(page).toHaveURL(/dashboard/);
  await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(/login/);
  expect((await page.request.get('/api/simple/state')).status()).toBe(401);
  await page.goto('/dashboard');await expect(page).toHaveURL(/login/);
});

test('private lead link has only status and feedback and reports the confirmed sheet update',async({page})=>{
  const token='a'.repeat(43)+'.'+'b'.repeat(43);
  const data={simple:true,employee:{name:'Employee One'},statuses:['New','Interested','Not Interested'],lead:{id:'feedback-lead',customerName:'Sample Customer',mobile:'+919876543210',project:'Plots',sheetName:'Plot enquiries',location:'Noida',questions:[{question:'What is your approximate budget?',answer:'50 lakh'}],status:'New',lastFeedback:null as string|null,writebackStatus:'SYNCED',version:2,updatedAt:new Date().toISOString()}};
  let submitted:any;let reads=0;
  await page.route(`**/api/feedback/${token}`,route=>{
    if(route.request().method()==='POST'){submitted=route.request().postDataJSON();data.lead.status=submitted.status;data.lead.lastFeedback=submitted.remarks;data.lead.version++;data.lead.writebackStatus='PENDING';return route.fulfill({json:{data:{message:'Feedback saved. Google Sheet update queued.'}}});}
    if(submitted&&++reads>1)data.lead.writebackStatus='SYNCED';return route.fulfill({json:{data}});
  });
  await page.goto(`/feedback/${token}`);
  await expect(page.getByRole('heading',{name:'Sample Customer'})).toBeVisible();
  await expect(page.getByText('Sheet: Plot enquiries',{exact:true})).toBeVisible();
  await expect(page.getByText('Q.1 - What is your approximate budget?',{exact:true})).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(1);await expect(page.locator('textarea')).toHaveCount(1);await expect(page.locator('input')).toHaveCount(0);
  await page.getByLabel('Feedback (lead status)',{exact:true}).selectOption('Interested');await page.getByLabel('Remark',{exact:true}).fill('Please arrange a site visit on Sunday.');
  await page.getByRole('button',{name:'Save status & feedback'}).click();
  await expect(page.getByRole('status')).toHaveText('Feedback saved. Updating Google Sheet…');
  await expect(page.getByRole('status')).toHaveText('Status and feedback saved to Google Sheet.');
  expect(submitted).toEqual({status:'Interested',remarks:'Please arrange a site visit on Sunday.',version:2});
});

test('expired feedback links show an access error without an editable form',async({page})=>{
  const token='expired-private-link';
  await page.route(`**/api/feedback/${token}`,route=>route.fulfill({status:410,json:{error:{message:'This feedback link has expired or been revoked.'}}}));
  await page.goto(`/feedback/${token}`);await expect(page.locator('.feedback-card').getByRole('alert')).toContainText('expired or been revoked');await expect(page.getByRole('button',{name:'Save status & feedback'})).toHaveCount(0);
});
