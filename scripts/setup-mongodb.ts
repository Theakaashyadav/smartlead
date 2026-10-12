import '../src/lib/config';
import { closeMongoStorage, initializeMongoDatabase, mongoDatabase } from '../src/lib/mongo-storage';

async function run(){
  const database=await mongoDatabase();
  await initializeMongoDatabase(database);
  console.log(`MongoDB is ready. SmartLead uses the separate ${database.databaseName} database. No users, leads, or demo records were imported.`);
}
run().catch(()=>{console.error('MongoDB setup failed. Check MONGODB_URI, network access, database permissions, and replica-set support. Existing databases were not cleared.');process.exitCode=1;}).finally(closeMongoStorage);
