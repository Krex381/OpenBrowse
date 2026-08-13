import { config } from "./config.js";
import { buildServer } from "./server.js";

const services = await buildServer();
await services.pool.initialize();
await services.app.listen({ host: config.host, port: config.port });
const shutdown = async (): Promise<void> => {
  await services.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
