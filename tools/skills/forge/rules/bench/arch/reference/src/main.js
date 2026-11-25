import { createServer, createTracker } from './index.js';

const port = Number(process.env.PORT ?? 3000);
const server = createServer({ tracker: createTracker() });
server.listen(port, () => console.log(`taskly listening on http://localhost:${port}`));
