// Vercel: the whole app is one function, the same server as npm start, WebSockets included
// (Vercel Functions hold WebSocket connections on Fluid Compute). Copies of the function hear each
// other's changes through Postgres LISTEN/NOTIFY; if a socket drops, the screen polls until it is back.
import { createServer } from '../server.mjs';

export default createServer();
