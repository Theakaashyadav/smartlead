import type { Metadata } from 'next';
import './globals.css';
import './theme.css';
export const metadata:Metadata={title:'SmartLead · Sheets to WhatsApp',description:'Connect Google Sheets, link WhatsApp, and send leads to your selected contacts automatically.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
