import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({resolve:{alias:{'@':path.resolve('src')}},test:{include:['tests/*.test.ts','tests/mongodb/*.test.ts'],setupFiles:['tests/mongo-setup.ts'],globalSetup:['tests/mongo-global-setup.ts'],fileParallelism:false,testTimeout:30000,hookTimeout:60000}});
