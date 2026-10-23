export type WhatsAppContact = {name:string;phone:string};
export const SIMPLE_TEMPLATE = '*New lead*\n\nName: {{customer_name}}\nPhone: {{mobile_number}}\nProject: {{project_name}}\nLocation: {{location}}\nBudget: {{budget}}\nSource: {{lead_source}}';
export const DELIVERY_COLUMNS={sentStatus:'Sent Status',sharedTo:'Shared To'};
export const SIMPLE_OUTPUT_COLUMNS={...DELIVERY_COLUMNS,status:'Feedback',feedback:'Remark'};
export type LeadQuestion={question:string;answer:string};
export function questionLabel(header:string){
  const text=header.replace(/_/g,' ').replace(/\s+/g,' ').trim();
  return text?text[0].toUpperCase()+text.slice(1):text;
}
export function sourceQuestions(headers:string[],cells:string[]):LeadQuestion[]{
  return headers.flatMap((header,index)=>{
    const text=header.replace(/_/g,' ').trim();
    return /\?\s*$/.test(text)||/^(what|when|where|why|which|how|are you|do you|have you|would you|is your|can you)\b/i.test(text)?[{question:questionLabel(header),answer:(cells[index]||'').trim()}]:[];
  });
}
export function simpleLeadMessage(lead:{customerName:string;mobile:string;location?:string|null;sourceData?:unknown},sheetName:string,feedbackLink:string){
  const questions=(lead.sourceData as {questions?:LeadQuestion[]}|null)?.questions||[];
  return ['Hello',`You got a new lead from ${sheetName}`,"Here's what we know:",...questions.map((q,i)=>`Q.${i+1} - ${q.question}\nAns.- ${q.answer||'Not provided'}`),`Name: ${lead.customerName}\nPhone: ${lead.mobile}\nCity: ${lead.location||'Not provided'}`,`*Submit Feedback*\n${feedbackLink}`,'Thank you!'].join('\n\n');
}
export function spreadsheetIdentity(input:string) {
  const value=input.trim();
  if(/^[\w-]{20,200}$/.test(value))return {id:value,gid:undefined};
  try {
    const url=new URL(value);const id=url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/)?.[1];
    if(url.hostname!=='docs.google.com'||!id)throw new Error();
    const gid=new URLSearchParams(url.hash.replace(/^#/, '')).get('gid')||url.searchParams.get('gid');
    return {id,gid:gid&&/^\d+$/.test(gid)?Number(gid):undefined};
  }catch{throw new Error('Paste a valid Google Sheets link.');}
}
export function detectColumns(headers:string[]) {
  const aliases:Record<string,string[]>={customerName:['customername','fullname','leadname','name','clientname','customer'],mobile:['mobilenumber','phonenumber','whatsappnumber','mobile','phone','contactnumber','contact'],project:['project','projectname'],email:['email','emailaddress'],location:['location','city'],budget:['budget'],source:['source','leadsource'],requirement:['requirement','requirements'],leadDate:['leaddate','date','timestamp'],leadId:['smartleadid','leadid','id']};
  const mapping:Record<string,string>={};const used=new Set<string>();
  for(const [field,names]of Object.entries(aliases)){
    const header=headers.find(h=>!used.has(h)&&names.includes(h.toLowerCase().replace(/[^a-z0-9]/g,'')));
    if(header){mapping[field]=header;used.add(header);}
  }
  return mapping;
}
