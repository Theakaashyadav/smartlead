import { test, expect } from '@playwright/test';
async function login(page:any){await page.goto('/login');await page.getByRole('button',{name:'Log in',exact:true}).click();await expect(page).toHaveURL(/dashboard/);await expect(page.getByRole('heading',{name:'Your leads. Sent automatically.'})).toBeVisible();}

test('two organisation owners create separate accounts and keep their connections when switching logins',async({page,browser})=>{
  const email=`agency-one-${Date.now()}@example.test`;const otherEmail=`agency-two-${Date.now()}@example.test`;const password='SeparateWorkspace!2026';
  await page.goto('/login');await page.getByRole('link',{name:'Create an account',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Create your organisation'})).toBeVisible();
  await page.screenshot({path:'data/simple-registration-desktop.png',fullPage:true});
  await page.getByLabel('Your name',{exact:true}).fill('Manager One');await page.getByLabel('Organisation name',{exact:true}).fill('Agency One');
  await page.getByLabel('Email',{exact:false}).fill(email);await page.getByLabel('Password',{exact:false}).first().fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create organisation account'}).click();await expect(page).toHaveURL(/dashboard/);
  await expect(page.getByLabel('Current organisation')).toContainText('Agency One');await expect(page.getByLabel('Current organisation')).toContainText(email);
  const one=(await (await page.request.get('/api/simple/state')).json()).data;expect(one.sheets).toEqual([]);expect(one.account).toBeNull();
  await page.request.post('/api/simple/whatsapp/connect');
  const connectionOne=(await (await page.request.get('/api/simple/state')).json()).data.account;
  const context=await browser.newContext();const other=await context.newPage();
  try{
    await other.goto('http://127.0.0.1:3000/register');
    await other.getByLabel('Your name',{exact:true}).fill('Manager Two');await other.getByLabel('Organisation name',{exact:true}).fill('Agency Two');
    await other.getByLabel('Email',{exact:false}).fill(otherEmail);await other.getByLabel('Password',{exact:false}).first().fill(password);await other.getByLabel('Confirm password',{exact:true}).fill(password);
    await other.getByRole('button',{name:'Create organisation account'}).click();await expect(other).toHaveURL(/dashboard/);
    await expect(other.getByLabel('Current organisation')).toContainText('Agency Two');
    const two=(await (await other.request.get('/api/simple/state')).json()).data;expect(two.organization.id).not.toBe(one.organization.id);expect(two.sheets).toEqual([]);expect(two.account).toBeNull();
    expect((await other.request.get(`/api/whatsapp/${connectionOne.id}/qr`)).status()).toBe(404);
    await other.request.post('/api/simple/whatsapp/connect');const connectionTwo=(await (await other.request.get('/api/simple/state')).json()).data.account;
    expect(connectionTwo.id).not.toBe(connectionOne.id);
    await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(/login/);
    await page.getByLabel('Email',{exact:false}).fill(email);await page.getByLabel('Password',{exact:false}).first().fill(password);await page.getByRole('button',{name:'Log in',exact:true}).click();
    await expect(page).toHaveURL(/dashboard/);await expect(page.getByLabel('Current organisation')).toContainText('Agency One');
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
  if(connection.data.whatsappLoginMode==='background'){
    await expect(page.getByRole('button',{name:'Open WhatsApp Web',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:/^(Connect WhatsApp|Disconnect account|Waiting for scan|Try again)$/})).toBeVisible();
    await expect(page.getByText('Keep it open.',{exact:false})).toHaveCount(0);
  }else{
    await expect(page.getByRole('button',{name:'Open WhatsApp Web',exact:true})).toBeVisible();
    await expect(page.getByRole('img',{name:/Scan this QR code/})).toHaveCount(0);
  }
});

test('a public link detects columns and opens recipient selection without Google setup',async({page})=>{
  const sheet={id:'public-sheet-test',name:'Public leads',worksheetName:'Incoming',enabled:false,leadCount:0,recipients:[],lastSyncError:null};
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'legacy',name:'Test Organisation'},workerRunning:true,account:{id:'web',status:'CONNECTED',phone:'+919876543212',qrCode:null,lastError:null},sheets:[] as typeof sheet[]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));
  await page.route('**/api/simple/contacts',route=>route.fulfill({json:{data:{contacts:[]}}}));
  await page.route('**/api/simple/contacts/refresh',route=>route.fulfill({json:{data:{refreshing:true}}}));
  let inspected:any;let saved:any;
  await page.route('**/api/simple/sheets/inspect',route=>{inspected=route.request().postDataJSON();return route.fulfill({json:{data:{spreadsheetId:'public-test-spreadsheet-123456789',title:'Public leads',gid:42,tabs:[{id:0,name:'Other',headers:['Full Name','Phone Number']},{id:42,name:'Incoming',headers:['Name','Phone']}]}}});});
  await page.route('**/api/simple/sheets',route=>{saved=route.request().postDataJSON();state.sheets=[sheet];return route.fulfill({json:{data:{id:sheet.id}}});});
  await login(page);await page.goto('/sheets');await page.getByRole('button',{name:'Connect sheet',exact:true}).first().click();
  const url='https://docs.google.com/spreadsheets/d/public-test-spreadsheet-123456789/edit#gid=42';
  await page.getByLabel('Google Sheets link').fill(url);await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByLabel('Sheet tab')).toHaveValue('42');await expect(page.getByLabel('Customer name column')).toHaveValue('Name');await expect(page.getByLabel('Phone number column')).toHaveValue('Phone');
  await page.getByRole('dialog').getByRole('button',{name:'Connect sheet',exact:true}).click();await expect(page.getByRole('heading',{name:'Who should receive these leads?'})).toBeVisible();
  expect(inspected).toEqual({url});expect(saved).toEqual({spreadsheetId:'public-test-spreadsheet-123456789',worksheetId:42,columnMapping:{customerName:'Name',mobile:'Phone'}});
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
  await page.getByLabel('Lead status',{exact:true}).selectOption('Interested');await page.getByLabel('Feedback',{exact:true}).fill('Please arrange a site visit on Sunday.');
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
