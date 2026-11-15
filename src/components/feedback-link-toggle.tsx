'use client';

export function FeedbackLinkToggle({enabled,onChange,disabled=false,label='Send feedback link',description='Include the feedback link in new and queued lead messages.'}:{enabled:boolean;onChange:(enabled:boolean)=>void;disabled?:boolean;label?:string;description?:string}){
  return <div className="simple-feedback-choice">
    <div><strong>Send feedback link</strong><small>{description}</small></div>
    <button type="button" role="switch" aria-label={label} aria-checked={enabled} disabled={disabled} className="simple-feedback-switch" onClick={()=>onChange(!enabled)}>
      <span className="simple-feedback-track" aria-hidden="true"><span/></span><span aria-hidden="true">{enabled?'On':'Off'}</span>
    </button>
  </div>;
}
