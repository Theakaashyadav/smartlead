import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

export default async function setup(project:TestProject){
  const server=await MongoMemoryReplSet.create({binary:{downloadDir:path.resolve('data/mongodb-test-binaries')},replSet:{count:1,storageEngine:'wiredTiger'}});
  project.provide('mongoURI',server.getUri());
  return ()=>server.stop();
}
