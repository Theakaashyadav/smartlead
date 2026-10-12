import { defineConfig, devices } from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',workers:1,timeout:60000,use:{baseURL:'http://127.0.0.1:3000',headless:true,channel:'msedge',trace:'retain-on-failure'},projects:[{name:'desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1050}}}],reporter:'list'});
