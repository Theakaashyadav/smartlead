'use client';

import { useId, useState } from 'react';
import { RefreshCw, Search, Users } from 'lucide-react';
import { isWhatsAppGroup, type WhatsAppContact } from '@/lib/simple-shared';
import { Button, Field } from './ui';

type Props={label:string;value:string;onChange:(value:string)=>void;contacts:WhatsAppContact[];loading?:boolean;disabled?:boolean;required?:boolean;inputLabel?:string;excluded?:string[];onRefresh?:()=>void};

export function WhatsAppDestinationPicker({label,value,onChange,contacts,loading=false,disabled=false,required=false,inputLabel=label,excluded=[],onRefresh}:Props){
  const [search,setSearch]=useState('');const choiceId=useId();
  const groupSelected=isWhatsAppGroup(value);
  const selected=contacts.find(contact=>contact.phone===value);
  const options=contacts.filter(contact=>!excluded.includes(contact.phone)&&`${contact.name} ${isWhatsAppGroup(contact.phone)?'group':contact.phone}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="simple-destination-picker" role="group" aria-label={label}>
    <h3>{label}</h3>
    <div className="simple-recipient-search"><Search size={17}/><input aria-label={`${label}: search contacts and groups`} placeholder="Search contacts and groups" value={search} disabled={disabled} onChange={event=>setSearch(event.target.value)}/>{onRefresh&&<Button type="button" variant="ghost" disabled={disabled} aria-label="Refresh contacts and groups" onClick={onRefresh}><RefreshCw size={16}/></Button>}</div>
    <div className="simple-contact-list simple-destination-list">{loading?<p>Loading WhatsApp contacts and groups…</p>:options.length?options.map(contact=><label key={contact.phone} className={`simple-contact simple-contact-choice ${value===contact.phone?'selected':''}`}>
      <input type="radio" name={choiceId} checked={value===contact.phone} disabled={disabled} onChange={()=>onChange(contact.phone)}/>
      <span className="simple-contact-avatar">{isWhatsAppGroup(contact.phone)?<Users size={18}/>:contact.name[0]?.toUpperCase()||'#'}</span>
      <span className="simple-contact-details"><strong>{contact.name}</strong><small>{isWhatsAppGroup(contact.phone)?'WhatsApp group':contact.phone}</small></span>
    </label>):<p>{search?'No matching contacts or groups.':'Refresh to load contacts and groups from your linked WhatsApp.'}</p>}</div>
    {groupSelected&&<p className="simple-destination-selected" role="status"><Users size={16}/><span>Selected group: <strong>{selected?.name||'WhatsApp group'}</strong></span></p>}
    <Field label={inputLabel} hint="Or enter a phone number with country code."><input type="tel" aria-label={inputLabel} maxLength={40} placeholder={required?'+91 phone number':'+91 phone number (optional)'} disabled={disabled} required={required&&!value} value={groupSelected?'':value} onChange={event=>onChange(event.target.value)}/></Field>
    {value&&<Button type="button" variant="ghost" disabled={disabled} onClick={()=>onChange('')}>Clear selection</Button>}
  </div>;
}
