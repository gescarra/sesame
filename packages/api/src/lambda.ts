import { handle } from "hono/aws-lambda";
import { app } from "./app.ts";

// Fallback entry for a classic Lambda function URL, if Web Functions can't be used.
export const handler = handle(app);
