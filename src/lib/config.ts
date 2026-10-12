import { existsSync } from 'node:fs';
try { if (existsSync('.env')) process.loadEnvFile('.env'); } catch { /* Next loads its own environment. */ }
export const isDemo = () => process.env.DEMO_MODE === 'true';
export const appUrl = () => process.env.APP_URL || 'http://localhost:3000';
export function secret(name: string) {
  const value = process.env[name];
  if (!value || value.startsWith('replace-')) throw new Error(`${name} must be configured`);
  return value;
}
