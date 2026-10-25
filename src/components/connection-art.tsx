import { ArrowUpRight, FileSpreadsheet, MessageCircle, Users } from 'lucide-react';

/** Decorative brand artwork; it does not represent connection or delivery state. */
export function ConnectionArt(){
  return <div className="connection-art" aria-hidden="true">
    <div className="connection-art-orbit orbit-one"/>
    <div className="connection-art-orbit orbit-two"/>
    <span className="connection-art-spark spark-one"/>
    <span className="connection-art-spark spark-two"/>
    <span className="connection-art-spark spark-three"/>
    <div className="connection-art-hub"><ArrowUpRight size={44} strokeWidth={1.7}/></div>
    <div className="connection-art-node art-sheets"><FileSpreadsheet size={23}/><span>Google Sheets</span></div>
    <div className="connection-art-node art-whatsapp"><MessageCircle size={23}/><span>WhatsApp</span></div>
    <div className="connection-art-node art-people"><Users size={23}/><span>Your team</span></div>
  </div>;
}
