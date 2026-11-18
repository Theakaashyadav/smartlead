import {describe,expect,it} from 'vitest';
import {isWhatsAppGroup,whatsappDestinationLabel} from '@/lib/simple-shared';
import {phoneSchema,requiredWhatsappDestinationSchema,whatsappDestinationSchema} from '@/lib/validation';

describe('WhatsApp destinations',()=>{
  it.each(['120363123456789012@g.us','919876543210-1234567890@g.us'])('preserves group address %s',group=>{
    expect(isWhatsAppGroup(group)).toBe(true);
    expect(requiredWhatsappDestinationSchema.parse(` ${group} `)).toBe(group);
    expect(whatsappDestinationSchema.parse(group)).toBe(group);
    expect(phoneSchema.safeParse(group).success).toBe(false);
  });
  it('normalizes manual phone numbers and preserves optional notification settings',()=>{
    expect(requiredWhatsappDestinationSchema.parse('98765 43210')).toBe('+919876543210');
    expect(whatsappDestinationSchema.parse('  ')).toBeNull();
    expect(whatsappDestinationSchema.parse(null)).toBeNull();
    expect(whatsappDestinationSchema.parse(undefined)).toBeUndefined();
  });
  it.each(['','team@g.us','123@g.us.evil','123@gXus','123@s.whatsapp.net','123@c.us','123@broadcast','123@newsletter','123-456-789@g.us','-123@g.us','123@g.us\n456','919876543210@g.us.extra','+919876543210@c.us','919876543210@newsletter','1'.repeat(80)+'@g.us'])('rejects invalid destination %j',value=>{
    expect(isWhatsAppGroup(value)).toBe(false);
    expect(requiredWhatsappDestinationSchema.safeParse(value).success).toBe(false);
  });
  it('uses saved group subjects and contact names for destination labels',()=>{
    const contacts=[{name:'Sales team',phone:'120363123456789012@g.us',kind:'group' as const},{name:'Aman',phone:'+919876543210'}];
    expect(whatsappDestinationLabel(contacts[0].phone,contacts)).toBe('Sales team');
    expect(whatsappDestinationLabel(contacts[1].phone,contacts)).toBe('Aman');
    expect(whatsappDestinationLabel('120363987654321012@g.us',contacts)).toBe('WhatsApp group');
    expect(whatsappDestinationLabel('+919876543211',contacts)).toBe('+919876543211');
  });
});
