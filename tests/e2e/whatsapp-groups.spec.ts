import { test, expect, type Page } from '@playwright/test';

const contacts=[
  {name:'Sales Team',phone:'120363001234567890@g.us',kind:'group'},
  {name:'Executive Team',phone:'919876543210-1456789012@g.us',kind:'group'},
  {name:'Owner Updates',phone:'120363009876543210@g.us',kind:'group'},
  {name:'Aman Office',phone:'+919876543211'},
];

async function workspace(page:Page){
  const sheet={id:'group-sheet',name:'Group leads',worksheetName:'Leads',enabled:false,leadCount:0,recipients:[] as {name:string;phone:string;leadCount?:number}[],executiveNotificationPhone:null as string|null,notificationPhone:null as string|null,lastSyncError:null};
  const state={user:{name:'Admin',email:'admin@smartlead.demo'},organization:{id:'group-ui',name:'Group workspace'},workerRunning:true,account:{id:'web',status:'CONNECTED',phone:'+919876543212',qrCode:null,lastError:null},sheets:[sheet]};
  await page.route('**/api/simple/state',route=>route.fulfill({json:{data:state}}));
  await page.route('**/api/simple/contacts',route=>route.fulfill({json:{data:{contacts}}}));
  await page.route('**/api/simple/contacts/refresh',route=>route.fulfill({json:{data:{refreshing:true}}}));
  await page.goto('/login');await page.getByRole('button',{name:'Log in',exact:true}).click();await expect(page).toHaveURL(/dashboard/,{timeout:30000});
  return sheet;
}

test('sheet recipients and both notifications select WhatsApp groups and retain their names on reopening',async({page})=>{
  const sheet=await workspace(page);let saved:any;
  await page.route('**/api/simple/sheets/group-sheet/recipients',route=>{
    saved=route.request().postDataJSON();Object.assign(sheet,saved);return route.fulfill({json:{data:{started:true}}});
  });
  await page.goto('/sheets');await page.getByRole('button',{name:'Choose recipients',exact:true}).click();
  await page.getByRole('checkbox',{name:/Sales Team/}).check();
  await page.getByLabel('Leads per turn for Sales Team',{exact:true}).fill('2');
  await page.getByRole('checkbox',{name:/Aman Office/}).check();
  await page.getByRole('button',{name:'Next: executive notifications',exact:true}).click();
  await page.getByLabel('Executive notification recipient: search contacts and groups',{exact:true}).fill('Executive');
  await page.getByRole('radio',{name:/Executive Team/}).check();
  await expect(page.getByRole('status')).toContainText('Selected group: Executive Team');
  await expect(page.getByLabel('Executive notification WhatsApp number',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Next: your notifications',exact:true}).click();
  await expect(page.getByLabel('Your notification recipient: search contacts and groups',{exact:true})).toHaveValue('');
  await page.getByRole('radio',{name:/Owner Updates/}).check();
  await page.getByRole('button',{name:'Save & start sending',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(saved).toMatchObject({recipients:[{name:'Sales Team',phone:contacts[0].phone,leadCount:2},{name:'Aman Office',phone:contacts[3].phone,leadCount:1}],executiveNotificationPhone:contacts[1].phone,notificationPhone:contacts[2].phone});
  await page.getByRole('button',{name:'Edit recipients',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/Sales Team/})).toBeChecked();
  await expect(page.getByLabel('Leads per turn for Sales Team',{exact:true})).toHaveValue('2');
  await page.getByRole('button',{name:'Next: executive notifications',exact:true}).click();
  await expect(page.getByRole('radio',{name:/Executive Team/})).toBeChecked();
  await page.getByRole('button',{name:'Next: your notifications',exact:true}).click();
  await expect(page.getByRole('radio',{name:/Owner Updates/})).toBeChecked();
});

test('test lead flow uses a group for the lead and contact or group notification destinations',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await workspace(page);let saved:any;
  await page.route('**/api/simple/test-flow',route=>{
    saved=route.request().postDataJSON();const stage={status:'SUBMITTED',providerMessageId:'test-receipt'};
    return route.fulfill({json:{data:{...saved,id:'group-flow',status:'COMPLETED',recipients:saved.recipients.map((person:any)=>({...person,lead:stage,executive:stage,owner:stage})),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}});
  });
  await page.getByRole('button',{name:'Test lead flow',exact:true}).click();
  await page.getByRole('checkbox',{name:/Sales Team/}).check();
  await page.getByRole('button',{name:'Next: executive number',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('radio',{name:/Executive Team/}).check();
  await page.getByRole('button',{name:'Next: your number',exact:true}).click();
  await page.getByRole('radio',{name:/Aman Office/}).check();
  await page.getByRole('button',{name:/Send test/}).click();
  await expect(page.getByText('Test completed. The sample lead and both notifications were accepted by WhatsApp.',{exact:true})).toBeVisible();
  expect(saved).toMatchObject({recipients:[{name:'Sales Team',phone:contacts[0].phone}],executiveNotificationPhone:contacts[1].phone,notificationPhone:contacts[3].phone});
  await expect(page.getByRole('region',{name:'Test result for Sales Team'})).toContainText('Executive Team');
});
