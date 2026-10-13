// Socket login runs in Node.js and does not need Chromium or a desktop.
export const socketWhatsApp = () => !process.env.WHATSAPP_LOGIN_MODE || process.env.WHATSAPP_LOGIN_MODE === 'socket';
