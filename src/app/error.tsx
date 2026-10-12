'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main className="standalone"><div className="panel"><h1>Something needs attention</h1><p>SmartLead could not load this page. Check the application configuration and try again.</p><button className="btn primary" onClick={reset}>Try again</button></div></main>;}
