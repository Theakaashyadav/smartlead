import '../src/lib/config';
import { db } from '../src/lib/db';
import { isDemo } from '../src/lib/config';
import { passwordHash, encrypt } from '../src/lib/security';
import { DEFAULT_TEMPLATE, MANAGED, STATUSES } from '../src/lib/validation';
import { assignLead, drainJobs, synchronizeSheet } from '../src/lib/engine';
import type { SourceRow } from '../src/lib/google';

async function seed(){
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:process.env.ADMIN_ORGANIZATION||'My Organisation'},update:{}});
  if(!isDemo()){
    const email=process.env.ADMIN_EMAIL,password=process.env.ADMIN_PASSWORD;
    if(!email||!password||password.length<12)throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters)');
    await db.user.upsert({where:{email},create:{organizationId:'legacy',name:process.env.ADMIN_NAME||'Workspace Admin',email,passwordHash:passwordHash(password),role:'SUPER_ADMIN'},update:{}});
    console.log('Production administrator initialized.');return;
  }
  const demoAdmin=await db.user.findUnique({where:{email:'admin@smartlead.demo'}});
  if(demoAdmin){
    if(!demoAdmin.phone&&!demoAdmin.pinHash)await db.user.update({where:{id:demoAdmin.id},data:{phone:'+919876543210',pinHash:passwordHash('2468')}});
    console.log('Demo data already exists; phone login is ready.');return;
  }
  await db.user.create({data:{organizationId:'legacy',id:'admin-demo',name:'Akash Yadav',email:'admin@smartlead.demo',phone:'+919876543210',pinHash:passwordHash('2468'),passwordHash:passwordHash('SmartLead!2026'),role:'SUPER_ADMIN'}});
  const names=['Akash Yadav','Aman Sharma','Kunal Verma','Sahil Singh'];
  for(const [i,name] of names.entries())await db.employee.create({data:{organization:{connect:{id:'legacy'}},id:`employee-${i}`,name,phone:`+9198765400${10+i}`,department:i===3?'Digital Solutions':'Property Sales',projects:i===3?['Website Development']:['Noida Studio','Uttarakhand','Yamuna Expressway'],dailyLimit:1000,capacity:500,role:i===0?'Team Lead':'Sales Executive',user:{create:{organizationId:'legacy',name,email:`${name.split(' ')[0].toLowerCase()}@smartlead.demo`,passwordHash:passwordHash('SmartLead!2026'),role:'EXECUTIVE'}}}});
  await db.sender.create({data:{organizationId:'legacy',id:'sender-demo',name:'SmartLead · Operations',provider:'DEMO',phone:'+919876543210',status:'CONNECTED',lastConnectedAt:new Date()}});
  const sources=[['Noida Studio Apartments','Noida Studio','ROUND_ROBIN'],['Uttarakhand Properties','Uttarakhand','WEIGHTED'],['Yamuna Expressway Plots','Yamuna Expressway','SINGLE'],['Website Development','Website Development','CAPACITY'],['Shubh Kadam Residences','Shubh Kadam','ALL']];
  const customerNames=['Rahul Sharma','Priya Mehta','Vikram Singh','Neha Gupta','Arjun Patel','Ananya Verma','Rohit Kapoor','Sneha Joshi','Aditya Rao','Pooja Malhotra','Karan Sethi','Divya Nair','Nitin Bansal','Ishita Jain','Manish Kumar','Riya Khanna','Varun Das','Aditi Shah','Amit Chawla','Simran Kaur','Deepak Mishra','Kavya Reddy','Sanjay Arora','Meera Iyer','Harsh Goel','Tanya Sinha','Rajiv Saxena','Sakshi Tiwari','Yash Agarwal','Nisha Sood'];
  for(const [i,[name,project,mode]]of sources.entries()){
    const recipients=i===2?[0]:i===3?[1,3]:i===1?[2,3]:[0,1];
    const sheet=await db.sheet.create({data:{
      organizationId:'legacy',id:`sheet-${i}`,name,project,spreadsheetId:`demo-spreadsheet-${i}`,worksheetId:0,worksheetName:'Leads',connectionType:'DEMO',
      columnMapping:{leadId:'Lead ID',customerName:'Full Name',mobile:'Phone',project:'Project',budget:'Budget',source:'Source',...Object.fromEntries(Object.entries(MANAGED).map(([key,value])=>[key,value]))},
      managedColumnsApproved:true,syncInterval:180,
      rule:{create:{mode,senderId:'sender-demo',template:DEFAULT_TEMPLATE,recipients:{create:recipients.map((r,position)=>({employeeId:`employee-${r}`,position,weight:mode==='WEIGHTED'?(position===0?60:40):0}))}}}
    }});
    const rows:SourceRow[]=Array.from({length:30-i*3},(_,j)=>({stableId:`DEMO-${i}-${j}`,row:j+2,values:{leadId:`DEMO-${i}-${j}`,customerName:customerNames[(j+i*5)%customerNames.length],mobile:`+919800${String(i*100+j+1000).padStart(6,'0')}`,project,budget:i===3?'₹75,000–1.5 lakh':['₹40–50 lakh','₹60–80 lakh','₹25–35 lakh'][j%3],source:['Facebook Ads','Google Ads','Website','Referral'][j%4],location:i===0?'Sector 135, Noida':i===1?'Dehradun':i===2?'Yamuna Expressway':i===4?'Greater Noida':'Delhi NCR',leadDate:new Date(Date.now()-(13-(j%14))*86400000+j*60000).toISOString()}}));
    await db.setting.create({data:{key:`demo-source:${sheet.id}`,value:JSON.parse(JSON.stringify(rows))}});
    await synchronizeSheet(sheet.id);
  }
  await drainJobs(1000);
  const leads=await db.lead.findMany({include:{assignments:{where:{active:true,isPrimary:true}}}});
  for(const [i,lead]of leads.entries()){
    const status=['New','Interested','Follow-up Required','Connected','Very Interested / Hot Lead','Site Visit Scheduled','Converted / Closed Won','Not Contacted','No Answer','Negotiation'][i%10];
    const date=new Date(lead.leadDate.getTime()+3600000);
    const next=i%5===2?new Date(Date.now()+((i%7)-2)*86400000):null;
    const remarks=status==='Converted / Closed Won'?'Booking confirmed. Documentation has been shared.':status==='Site Visit Scheduled'?'Customer would like a site visit this weekend.':status==='Interested'?'Interested in the project. Shared the brochure and pricing.':'Discussed requirements. Follow-up scheduled for the next conversation.';
    await db.lead.update({where:{id:lead.id},data:{status,lastFeedback:i%4!==0?remarks:null,nextFollowupAt:next,interest:status.includes('Hot')?'Hot':status==='Interested'?'Warm':null}});
    const assignment=lead.assignments[0];
    if(assignment){
      await db.assignment.update({where:{id:assignment.id},data:{assignedAt:date}});
      await db.message.updateMany({where:{leadId:lead.id},data:{queuedAt:date,submittedAt:date}});
      if(i%4!==0)await db.feedback.create({data:{leadId:lead.id,assignmentId:assignment.id,employeeId:assignment.employeeId,status,remarks,interest:status.includes('Hot')?'Hot':'Warm',submittedAt:date,nextFollowupAt:next}});
      if(next)await db.followup.create({data:{leadId:lead.id,employeeId:assignment.employeeId,scheduledAt:next,notes:remarks}});
    }
  }
  // A visible, confirmed demo failure exercises the review/retry flow.
  const message=await db.message.findFirst();if(message)await db.message.update({where:{id:message.id},data:{status:'FAILED',submittedAt:null,providerMessageId:null,failureReason:'Simulated provider rejection. Safe to retry in demo mode.',failedAt:new Date()}});
  await db.setting.create({data:{key:'workspace',value:{name:'SmartLead Workspace',timezone:'Asia/Kolkata'}}});
  await db.setting.create({data:{key:'statuses',value:STATUSES}});
  console.log(`Seeded ${leads.length} fictional leads, 5 sheets and 4 employees. No external messages were sent.`);
}
seed().then(()=>db.$disconnect()).catch(async error=>{console.error(error);await db.$disconnect();process.exitCode=1;});
