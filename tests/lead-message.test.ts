import {describe,expect,it} from 'vitest';
import {simpleLeadMessage,sourceQuestions} from '@/lib/simple-shared';

describe('compact WhatsApp lead messages',()=>{
  it('uses the requested layout and keeps sheet answers and the feedback URL intact',()=>{
    const headers=['what_is_your_primary_purpose_for_buying_a_plot?','what_is_your_approximate_budget?','when_are_you_planning_to_purchase?','when_would_you_be_available_for_a_site_visit?'];
    const cells=['build_a_holiday_home','₹30–50_lakh','within_1_month','within_1_month'];
    const lead={customerName:'Sample Customer',mobile:'+919800000001',location:'Delhi',sourceData:{questions:sourceQuestions(headers,cells)}};
    const original=JSON.stringify(lead);const url='https://smartlead.example/feedback/example-token.signature';
    const body=simpleLeadMessage(lead,'Corbett Meadows',url);
    expect(body).toBe([
      'Hello, You got a new lead',
      'Project – *Corbett Meadows*',
      "Here's what we know:",
      'Name: *Sample Customer*',
      'Phone: *+919800000001*',
      'City: *Delhi*',
      'purpose - *build_a_holiday_home*',
      'budget - *₹30–50_lakh*',
      'planning to purchase - *within_1_month*',
      'available for a site visit - *within_1_month*',
      '*Submit Feedback*',url,'Thank you!',
    ].join('\n'));
    expect(body).not.toContain('\n\n');expect(JSON.stringify(lead)).toBe(original);expect(cells).toEqual(['build_a_holiday_home','₹30–50_lakh','within_1_month','within_1_month']);
  });
  it('orders the known details, includes other questions and does not duplicate a mapped budget',()=>{
    const lead={customerName:'Customer',mobile:'+919800000001',budget:'₹30–50_lakh',sourceData:{questions:[{question:'When are you available for a site visit?',answer:'next_week'},{question:'What is your budget for purchasing a property?',answer:'₹30–50_lakh'},{question:'What is your purpose for buying a property?',answer:'investment'},{question:'How many bedrooms?',answer:'3_BHK'}]}};
    const body=simpleLeadMessage(lead,'Project A','https://smartlead.example/feedback/test');
    expect(body.indexOf('purpose -')).toBeLessThan(body.indexOf('budget -'));expect(body.indexOf('budget -')).toBeLessThan(body.indexOf('available for a site visit -'));
    expect(body.match(/budget -/g)).toHaveLength(1);expect(body).toContain('How many bedrooms - *3_BHK*');
  });
  it('uses an ordinary budget column when there is no budget question and keeps each detail on one line',()=>{
    const lead={customerName:'Customer\nExample',mobile:'+919800000001',budget:'₹30–50_lakh'};
    const body=simpleLeadMessage(lead,'Project A','https://smartlead.example/feedback/test');
    expect(body).toContain('Name: *Customer Example*\n');expect(body).toContain('budget - *₹30–50_lakh*');expect(body).not.toContain('\n\n');expect(lead.customerName).toBe('Customer\nExample');
  });
});
