import { MongoClient } from "mongodb";
import {
  mongoDbName,
  mongoDbUrl,
  mongoSessionCollection,
} from "./mongo-config.js";

let client;

export const connectToMongoDB = async () => {
  if (!client) {
    client = new MongoClient(mongoDbUrl);
    await client.connect();
    console.log("Connected to MongoDB for session storage");
  }
  return client.db(mongoDbName).collection(mongoSessionCollection);
};
