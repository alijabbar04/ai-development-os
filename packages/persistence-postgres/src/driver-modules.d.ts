declare module "pg/lib/client.js" {
  import type { ClientConfig, PoolClient } from "pg";

  const PgClient: new (configuration?: ClientConfig) => PoolClient;
  export default PgClient;
}

declare module "pg-pool" {
  import type { PoolClient, PoolConfig } from "pg";

  export default class PgPool {
    constructor(
      configuration: PoolConfig,
      client: new (configuration?: PoolConfig) => PoolClient,
    );
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "error", handler: () => void): this;
  }
}
