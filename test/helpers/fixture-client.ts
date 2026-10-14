import { sessionRequest } from "../../src/session-client.js";
try { console.log(JSON.stringify(await sessionRequest(JSON.parse(process.argv[2])))); }
catch (error: any) { console.log(JSON.stringify({ error: error.code })); process.exitCode = 1; }
