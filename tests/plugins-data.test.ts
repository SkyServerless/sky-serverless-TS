import { afterEach, describe, expect, it, vi } from "vitest";
import { SkyContext } from "../src/core/context";
import { SkyRequest } from "../src/core/http";
import {
  cachePlugin,
  CacheHelper,
  mysqlPlugin,
  MysqlClient,
  MysqlPool,
  MysqlPoolConfig,
  MysqlPluginOptions,
  MysqlResolvedConfig,
  MysqlQueryValues,
  mssqlPlugin,
  MssqlClient,
  MssqlParameter,
  MssqlPool,
  MssqlConnectionConfig,
  MssqlResolvedConfig,
  redisPlugin,
  RedisLike,
  RedisResolvedConfig,
} from "../src/plugins/data";
import { __mysqlInternals } from "../src/plugins/data/mysql";
import { __mssqlInternals } from "../src/plugins/data/mssql";
import { __redisInternals } from "../src/plugins/data/redis";

describe("mysqlPlugin", () => {
  afterEach(() => {
    delete process.env.SKY_MYSQL_URI;
    __mysqlInternals.resetMysqlModuleLoader();
  });

  it("injects a MysqlClient and executes queries using the provided poolFactory", async () => {
    const fakePool = createFakeMysqlPool(() => [{ id: 1 }]);
    const options: MysqlPluginOptions = {
      connection: { host: "127.0.0.1", user: "root", database: "tests" },
      poolFactory: () => fakePool.pool,
    };

    const plugin = mysqlPlugin(options);
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;

    const rows = await client.query("SELECT 1");
    expect(rows).toEqual([{ id: 1 }]);
    expect(fakePool.queries).toEqual([
      { sql: "SELECT 1", params: undefined },
    ]);
  });

  it("resolves config from env fallback and only creates a pool once", async () => {
    process.env.SKY_MYSQL_URI =
      "mysql://user:pass@db.internal:3307/app?connectionLimit=15&ssl=custom-ca";
    const fakePool = createFakeMysqlPool();
    const factory = vi.fn((config: MysqlResolvedConfig) => {
      expect(config.host).toBe("db.internal");
      expect(config.port).toBe(3307);
      expect(config.database).toBe("app");
      expect(config.connectionLimit).toBe(15);
      expect(config.ssl).toBe("custom-ca");
      return fakePool.pool;
    });

    const plugin = mysqlPlugin({ poolFactory: factory });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;

    await client.query("SELECT 1");
    await client.query("SELECT 2");

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("closes and recreates the pool when close is invoked", async () => {
    const firstPool = createFakeMysqlPool(() => [{ run: 1 }]);
    const secondPool = createFakeMysqlPool(() => [{ run: 2 }]);
    const pools = [firstPool, secondPool];
    let factoryCalls = 0;

    const plugin = mysqlPlugin({
      connectionString: "mysql://user:pass@host/app",
      poolFactory: () => {
        const pool = pools[factoryCalls];
        factoryCalls += 1;
        return pool.pool;
      },
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;

    expect(await client.query("SELECT")).toEqual([{ run: 1 }]);
    await client.close();
    expect(firstPool.endSpy).toHaveBeenCalledTimes(1);

    expect(await client.query("SELECT")).toEqual([{ run: 2 }]);
    expect(factoryCalls).toBe(2);

    await client.getPool();
    await client.close();
    await client.close();
  });

  it("throws a helpful error when configuration is missing", async () => {
    const plugin = mysqlPlugin();
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;

    await expect(client.query("SELECT 1")).rejects.toThrow(
      /Missing MySQL configuration/,
    );
  });

  it("uses default mysql2 module when no poolFactory is provided", async () => {
    const fakePool = createFakeMysqlPool(() => [{ ok: true }]);
    const createPool = vi.fn(() => fakePool.pool);
    __mysqlInternals.setMysqlModuleLoader(async () => ({
      createPool,
    }));

    const plugin = mysqlPlugin({
      connectionString:
        "mysql://user:pw@default-host:3333/app?waitForConnections=false&connectionLimit=7&queueLimit=4&charset=latin1&ssl=true",
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;
    await client.query("SELECT 1");

    expect(createPool).toHaveBeenCalledWith({
      host: "default-host",
      port: 3333,
      user: "user",
      password: "pw",
      database: "app",
      waitForConnections: false,
      connectionLimit: 7,
      queueLimit: 4,
      charset: "latin1",
      ssl: {},
    });
  });

  it("creates pools using the connection string when no other config is present", async () => {
    const createPool = vi.fn(() => createFakeMysqlPool().pool);
    __mysqlInternals.setMysqlModuleLoader(async () => ({
      createPool,
    }));

    await __mysqlInternals.createDefaultMysqlPool({
      connectionString: "mysql://root:pw@localhost/app",
    } as MysqlResolvedConfig);

    expect(createPool).toHaveBeenCalledWith(
      "mysql://root:pw@localhost/app",
    );
  });

  it("does not override existing mysql services in the context", async () => {
    const plugin = mysqlPlugin({
      connection: { host: "localhost", user: "root" },
      poolFactory: () => createFakeMysqlPool().pool,
    });
    const context = createContext();
    context.services.mysql = { existing: true };

    await plugin.onRequest?.(createRequest(), context);
    expect(context.services.mysql).toEqual({ existing: true });
  });

  it("skips pool teardown when close is called before initialization", async () => {
    const plugin = mysqlPlugin({
      connection: { host: "localhost", user: "root" },
      poolFactory: () => createFakeMysqlPool().pool,
    });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;

    await client.close();
  });

  it("supports disabling SSL via connection string", async () => {
    process.env.SKY_MYSQL_URI =
      "mysql://user:pass@db.internal:3307/app?ssl=false";
    const factory = vi.fn((config: MysqlResolvedConfig) => {
      expect(config.ssl).toBeUndefined();
      return createFakeMysqlPool().pool;
    });

    const plugin = mysqlPlugin({ poolFactory: factory });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mysql as MysqlClient;
    await expect(client.query("SELECT 1")).resolves.toEqual([]);
  });

  it("parses connection strings without database name", () => {
    const config =
      __mysqlInternals.parseMysqlConnectionString("mysql://localhost");
    expect(config.database).toBeUndefined();
  });

  it("parses mysql DSNs without credentials but with host", () => {
    const config =
      __mysqlInternals.parseMysqlConnectionString("mysql://localhost/data");
    expect(config.user).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.database).toBe("data");
  });

  it("normalizes mysql DSNs missing protocol schemes", () => {
    const config =
      __mysqlInternals.parseMysqlConnectionString("user:pw@db.internal:4000/app");
    expect(config.host).toBe("db.internal");
    expect(config.port).toBe(4000);
    expect(config.user).toBe("user");
    expect(config.password).toBe("pw");
    expect(config.database).toBe("app");
  });

  it("handles mysql connection strings without hostnames", () => {
    const config =
      __mysqlInternals.parseMysqlConnectionString("mysql:///scratch");
    expect(config.host).toBeUndefined();
    expect(config.database).toBe("scratch");
  });

  it("propagates loader errors when mysql2 is unavailable", async () => {
    __mysqlInternals.setMysqlModuleLoader(async () => {
      throw new Error("driver missing");
    });

    await expect(
      __mysqlInternals.createDefaultMysqlPool({
        connectionString: "mysql://root@localhost/app",
      } as MysqlResolvedConfig),
    ).rejects.toThrow(/driver missing/);
  });

  it("creates mysql pools using config objects when no URI is provided", async () => {
    const createPool = vi.fn(() => createFakeMysqlPool().pool);
    __mysqlInternals.setMysqlModuleLoader(async () => ({
      createPool,
    }));

    await __mysqlInternals.createDefaultMysqlPool({
      host: "localhost",
      user: "root",
    } as MysqlResolvedConfig);

    expect(createPool).toHaveBeenCalledWith({
      host: "localhost",
      user: "root",
    });
  });

  it("provides a load helper that exposes the resolved mysql module", async () => {
    const moduleInstance = { createPool: vi.fn() };
    __mysqlInternals.setMysqlModuleLoader(
      async () => moduleInstance as unknown as { createPool: () => MysqlPool },
    );

    await expect(__mysqlInternals.loadMysqlModule()).resolves.toBe(
      moduleInstance,
    );
  });

  it("caches the mysql module loader result across calls", async () => {
    const moduleInstance = {
      createPool: vi.fn((config: MysqlPoolConfig | string) =>
        createFakeMysqlPool().pool,
      ),
    };
    const loader = vi.fn(
      async () =>
        moduleInstance as unknown as {
          createPool(config: MysqlPoolConfig | string): MysqlPool;
        },
    );
    __mysqlInternals.setMysqlModuleLoader(loader);

    await __mysqlInternals.loadMysqlModule();
    await __mysqlInternals.loadMysqlModule();

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("executes the default mysql module loader", async () => {
    __mysqlInternals.resetMysqlModuleLoader();
    await __mysqlInternals.loadMysqlModule().catch(() => undefined);
  });

  it("exposes the mysql missing-module error helper", () => {
    expect(() =>
      __mysqlInternals.raiseMissingMysqlModule(new Error("fail")),
    ).toThrow(/mysql2/);

    return expect(
      __mysqlInternals.importMysqlModule(() =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow(/mysql2/);
  });
});

describe("mssqlPlugin", () => {
  afterEach(() => {
    delete process.env.SKY_MSSQL_CONN_STR;
    __mssqlInternals.resetMssqlModuleLoader();
  });

  it("binds named parameters and returns rows", async () => {
    const fakePool = createFakeMssqlPool([{ total: 1 }]);
    const plugin = mssqlPlugin({
      config: { server: "localhost", user: "sa" },
      poolFactory: () => fakePool.pool,
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;

    const rows = await client.query("SELECT @id as id", {
      id: 42,
      region: { value: "BR", type: "VarChar" } as MssqlParameter,
      tenant: { value: "alpha" } as MssqlParameter,
    });

    expect(rows).toEqual([{ total: 1 }]);
    expect(fakePool.requests).toHaveLength(1);
    expect(fakePool.requests[0]).toMatchObject({
      sql: "SELECT @id as id",
      inputs: [
        { name: "id", value: 42 },
        { name: "region", type: "VarChar", value: "BR" },
        { name: "tenant", value: "alpha" },
      ],
    });
  });

  it("treats nulls and plain objects as raw parameters", async () => {
    const fakePool = createFakeMssqlPool([{ ok: true }]);
    const plugin = mssqlPlugin({
      config: { server: "localhost", user: "sa" },
      poolFactory: () => fakePool.pool,
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;

    await client.query("SELECT @raw as raw", {
      raw: { foo: "bar" },
      empty: null,
    });

    expect(fakePool.requests[0].inputs).toEqual([
      { name: "raw", value: { foo: "bar" } },
      { name: "empty", value: null },
    ]);
  });

  it("reads config from env fallback and caches the pool", async () => {
    process.env.SKY_MSSQL_CONN_STR =
      "mssql://user:pass@sqlhost:1433/core?encrypt=true&trustServerCertificate=false";
    const fakePool = createFakeMssqlPool();
    const factory = vi.fn((config: MssqlResolvedConfig) => {
      expect(config.server).toBe("sqlhost");
      expect(config.port).toBe(1433);
      expect(config.database).toBe("core");
      expect(config.options?.encrypt).toBe(true);
      expect(config.options?.trustServerCertificate).toBe(false);
      return fakePool.pool;
    });

    const plugin = mssqlPlugin({ poolFactory: factory });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;

    await client.query("SELECT 1");
    await client.query("SELECT 2");

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reinitializes the pool after close", async () => {
    const pools = [createFakeMssqlPool(), createFakeMssqlPool()];
    let call = 0;
    const plugin = mssqlPlugin({
      uri: "mssql://user:pass@host/app",
      poolFactory: () => {
        const pool = pools[call];
        call += 1;
        return pool.pool;
      },
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;

    await client.query("SELECT 1");
    await client.close();
    await client.query("SELECT 2");

    expect(call).toBe(2);

    await client.getPool();
    await client.close();
    await client.close();
  });

  it("does not override an existing mssql service on the context", async () => {
    const plugin = mssqlPlugin({
      config: { server: "localhost" },
      poolFactory: () => createFakeMssqlPool().pool,
    });
    const context = createContext();
    context.services.mssql = { existing: true };

    await plugin.onRequest?.(createRequest(), context);
    expect(context.services.mssql).toEqual({ existing: true });
  });

  it("skips closing when no pool was created yet", async () => {
    const plugin = mssqlPlugin({
      config: { server: "localhost" },
      poolFactory: () => createFakeMssqlPool().pool,
    });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;
    await client.close();
  });

  it("throws when configuration is missing", async () => {
    const plugin = mssqlPlugin();
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;

    await expect(client.query("SELECT 1")).rejects.toThrow(
      /Missing MSSQL configuration/,
    );
  });

  it("invokes the default mssql module loader when no poolFactory is provided", async () => {
    const fakePool = createFakeMssqlPool([{ ok: 1 }]);
    const connectionArguments: unknown[] = [];

    __mssqlInternals.setMssqlModuleLoader(async () => ({
      ConnectionPool: class {
        constructor(config: unknown) {
          connectionArguments.push(config);
        }

        async connect() {
          return fakePool.pool;
        }
      },
    }));

    const plugin = mssqlPlugin({
      connectionString:
        "mssql://user:pass@sqlhost:1433/app?encrypt=false&trustServerCertificate=true",
    });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const client = context.services.mssql as MssqlClient;

    await client.query("SELECT 1");
    expect(connectionArguments[0]).toBe(
      "mssql://user:pass@sqlhost:1433/app?encrypt=false&trustServerCertificate=true",
    );
  });

  it("creates pools from config objects when no connection string is present", async () => {
    const connectionArguments: unknown[] = [];
    __mssqlInternals.setMssqlModuleLoader(async () => ({
      ConnectionPool: class {
        constructor(config: unknown) {
          connectionArguments.push(config);
        }

        async connect() {
          return createFakeMssqlPool().pool;
        }
      },
    }));

    await __mssqlInternals.createDefaultMssqlPool({
      user: "sa",
      password: "pw",
    } as MssqlResolvedConfig);

    expect(connectionArguments[0]).toEqual({
      user: "sa",
      password: "pw",
    });
  });

  it("propagates loader errors when the mssql package is missing", async () => {
    __mssqlInternals.setMssqlModuleLoader(async () => {
      throw new Error("missing mssql");
    });

    await expect(
      __mssqlInternals.createDefaultMssqlPool({
        connectionString: "mssql://user@host/db",
      } as MssqlResolvedConfig),
    ).rejects.toThrow(/missing mssql/);
  });

  it("exposes a helper that resolves the current mssql module loader", async () => {
    const moduleInstance = {
      ConnectionPool: class {
        constructor() {}
        async connect() {
          return createFakeMssqlPool().pool;
        }
      },
    };
    __mssqlInternals.setMssqlModuleLoader(
      async () =>
        moduleInstance as unknown as {
          ConnectionPool: new () => { connect(): Promise<MssqlPool> };
        },
    );

    await expect(__mssqlInternals.loadMssqlModule()).resolves.toBe(
      moduleInstance,
    );
  });

  it("executes the default mssql module loader", async () => {
    __mssqlInternals.resetMssqlModuleLoader();
    await __mssqlInternals.loadMssqlModule().catch(() => undefined);
  });

  it("exposes the mssql missing-module error helper", () => {
    expect(() =>
      __mssqlInternals.raiseMissingMssqlModule(new Error("fail")),
    ).toThrow(/mssql/);

    return expect(
      __mssqlInternals.importMssqlModule(() =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow(/mssql/);
  });

  it("normalizes MSSQL DSNs without scheme prefixes", () => {
    const config = __mssqlInternals.parseMssqlConnectionString(
      "user:pw@sqlhost:1555/core?encrypt=false",
    );
    expect(config.server).toBe("sqlhost");
    expect(config.port).toBe(1555);
    expect(config.user).toBe("user");
    expect(config.password).toBe("pw");
    expect(config.database).toBe("core");
    expect(config.options?.encrypt).toBe(false);
  });

  it("handles MSSQL connection strings missing optional sections", () => {
    const hostless =
      __mssqlInternals.parseMssqlConnectionString("mssql:///analytics");
    expect(hostless.server).toBeUndefined();
    expect(hostless.user).toBeUndefined();
    expect(hostless.password).toBeUndefined();
    expect(hostless.database).toBe("analytics");

    const noDatabase =
      __mssqlInternals.parseMssqlConnectionString("mssql://sqlhost");
    expect(noDatabase.database).toBeUndefined();
  });

  it("parses ODBC connection strings with aliases and options", () => {
    const config = __mssqlInternals.parseMssqlConnectionString(
      [
        "Server=localhost,1433",
        "Server=localhost,invalid",
        "Database=Sky",
        "Initial Catalog=core",
        "User Id=sa",
        "Uid=app",
        "User=override",
        "Username=final",
        "Password=pass",
        "Pwd=secret",
        "Encrypt=maybe",
        "Encrypt=yes",
        "TrustServerCertificate=maybe",
        "TrustServerCertificate=no",
        "Port=bad",
        "Port=1666",
        "Addr=(local)",
        "Address=,1234",
        "Network Address=np:.,1555",
        "NoEqualsPart",
        "Server=",
        "Application Name=sky",
      ].join(";"),
    );

    expect(config).toMatchObject({
      server: "localhost",
      port: 1555,
      database: "core",
      user: "final",
      password: "secret",
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
    });
  });

  it("accepts ODBC data source strings with tcp prefixes", () => {
    const config = __mssqlInternals.parseMssqlConnectionString(
      [
        "Data Source=tcp:dbhost\\inst,1444",
        "Data Source=(localdb)",
        "Database=inventory",
        "User=sa",
        "Password=pass",
        "Encrypt=1",
        "TrustServerCertificate=0",
      ].join(";"),
    );

    expect(config).toMatchObject({
      server: "localhost",
      port: 1444,
      database: "inventory",
      user: "sa",
      password: "pass",
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
    });
  });

  it("returns empty config for blank or invalid MSSQL strings", () => {
    expect(__mssqlInternals.parseMssqlConnectionString("   ")).toEqual({});
    expect(
      __mssqlInternals.parseMssqlConnectionString(
        "mssql://user:pw@host:abc/db",
      ),
    ).toEqual({});
  });

  it("caches the MSSQL module loader result across calls", async () => {
    const moduleInstance = {
      ConnectionPool: class {
        constructor(_config: MssqlConnectionConfig | string) {}
        async connect(): Promise<MssqlPool> {
          return createFakeMssqlPool().pool;
        }
      },
    };
    const loader = vi.fn(
      async () =>
        moduleInstance as unknown as {
          ConnectionPool: new (
            config: MssqlConnectionConfig | string,
          ) => { connect(): Promise<MssqlPool> };
        },
    );
    __mssqlInternals.setMssqlModuleLoader(loader);

    await __mssqlInternals.loadMssqlModule();
    await __mssqlInternals.loadMssqlModule();

    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("redisPlugin", () => {
  afterEach(() => {
    delete process.env.SKY_REDIS_URI;
    __redisInternals.resetRedisModuleLoader();
  });

  it("creates a single Redis client and shares it across contexts", async () => {
    const fakeRedis = createFakeRedis();
    const factory = vi.fn(
      (config: RedisResolvedConfig) => {
        expect(config.connectionString).toBe("redis://localhost:6379/1");
        return fakeRedis.client;
      },
    );

    const plugin = redisPlugin({
      connectionString: "redis://localhost:6379/1",
      clientFactory: factory,
    });

    const contextA = createContext();
    await plugin.onRequest?.(createRequest(), contextA);
    const contextB = createContext();
    await plugin.onRequest?.(createRequest(), contextB);

    expect(contextA.services.redis).toBe(fakeRedis.client);
    expect(contextB.services.redis).toBe(fakeRedis.client);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("falls back to SKY_REDIS_URI when no connection was provided", async () => {
    process.env.SKY_REDIS_URI = "redis://cache:6380/2";
    const fakeRedis = createFakeRedis();
    const plugin = redisPlugin({
      clientFactory: (config) => {
        expect(config.connectionString).toBe("redis://cache:6380/2");
        return fakeRedis.client;
      },
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    expect(context.services.redis).toBe(fakeRedis.client);
  });

  it("throws when connection details are missing", async () => {
    const plugin = redisPlugin();
    const context = createContext();
    await expect(plugin.onRequest?.(createRequest(), context)).rejects.toThrow(
      /Missing Redis configuration/,
    );
  });

  it("does not override an existing redis service on the context", async () => {
    const plugin = redisPlugin({
      clientFactory: () => createFakeRedis().client,
    });
    const context = createContext();
    const existing = { ready: true };
    context.services.redis = existing;

    await plugin.onRequest?.(createRequest(), context);
    expect(context.services.redis).toBe(existing);
  });

  it("creates redis clients using the default loader and custom options", async () => {
    const instances: Array<{ args: unknown[] }> = [];
    class FakeRedis {
      constructor(...args: unknown[]) {
        instances.push({ args });
      }
    }

    __redisInternals.setRedisModuleLoader(async () => ({
      default: FakeRedis as unknown as new () => RedisLike,
    }));

    const plugin = redisPlugin({
      connectionString: "redis://cache:6380/3",
      connection: { tls: true },
    });
    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);

    expect(instances[0]?.args).toEqual([
      "redis://cache:6380/3",
      { tls: true },
    ]);
  });

  it("falls back to options only when connection string is absent", async () => {
    const instances: Array<{ args: unknown[] }> = [];
    class FakeRedis {
      constructor(...args: unknown[]) {
        instances.push({ args });
      }
    }
    __redisInternals.setRedisModuleLoader(async () => ({
      default: FakeRedis as unknown as new () => RedisLike,
    }));

    await __redisInternals.createDefaultRedisClient({
      options: { host: "cache" },
    });

    expect(instances[0]?.args).toEqual([{ host: "cache" }]);
  });

  it("supports creating clients from connection strings without options", async () => {
    const instances: Array<{ args: unknown[] }> = [];
    class FakeRedis {
      constructor(...args: unknown[]) {
        instances.push({ args });
      }
    }

    __redisInternals.setRedisModuleLoader(async () => ({
      default: FakeRedis as unknown as new () => RedisLike,
    }));

    await __redisInternals.createDefaultRedisClient({
      connectionString: "redis://localhost:6380/1",
    });

    expect(instances[0]?.args).toEqual(["redis://localhost:6380/1"]);
  });

  it("throws when the redis module does not expose a constructor", async () => {
    __redisInternals.setRedisModuleLoader(async () => ({} as never));

    await expect(
      __redisInternals.createDefaultRedisClient({
        connectionString: "redis://localhost",
      }),
    ).rejects.toThrow(/Could not resolve Redis constructor/);
  });

  it("propagates loader errors when ioredis cannot be found", async () => {
    __redisInternals.setRedisModuleLoader(async () => {
      throw new Error("missing ioredis");
    });

    await expect(
      __redisInternals.createDefaultRedisClient({
        connectionString: "redis://localhost",
      }),
    ).rejects.toThrow(/missing ioredis/);
  });

  it("exposes a helper that resolves the configured ioredis module", async () => {
    class FakeRedisCtor implements RedisLike {
      async get() {
        return null;
      }
      async set() {
        return "OK";
      }
      async del() {
        return 1;
      }
    }
    const moduleInstance = {
      default: FakeRedisCtor,
    };
    __redisInternals.setRedisModuleLoader(
      async () =>
        moduleInstance as unknown as {
          default: new () => RedisLike;
        },
    );

    await expect(__redisInternals.loadRedisModule()).resolves.toBe(
      moduleInstance,
    );
  });

  it("executes the default ioredis module loader", async () => {
    __redisInternals.resetRedisModuleLoader();
    await __redisInternals.loadRedisModule().catch(() => undefined);
  });

  it("exposes the redis missing-module error helper", () => {
    expect(() =>
      __redisInternals.raiseMissingRedisModule(new Error("fail")),
    ).toThrow(/ioredis/);

    return expect(
      __redisInternals.importRedisModule(() =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow(/ioredis/);
  });

  it("caches redis module loads between invocations", async () => {
    const loader = vi.fn(
      async () =>
        ({
          default: class {
            constructor() {}
          },
        }) as unknown as { default: new () => RedisLike },
    );
    __redisInternals.setRedisModuleLoader(loader);

    await __redisInternals.loadRedisModule();
    await __redisInternals.loadRedisModule();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("cachePlugin", () => {
  it("wraps fetchers, caches responses and honors TTL overrides", async () => {
    const redis = createFakeRedis();
    const plugin = cachePlugin({
      keyPrefix: "svc",
      defaultTtlSeconds: 60,
    });

    const context = createContext();
    context.services.redis = redis.client;
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.cache as CacheHelper;

    const result = await cache.wrap("user:1", 5, async () => ({
      id: 1,
      name: "Ada",
    }));
    expect(result).toEqual({ id: 1, name: "Ada" });
    const lastSet = redis.lastSetArgs[redis.lastSetArgs.length - 1];
    expect(lastSet).toMatchObject({
      key: "svc:user:1",
      mode: "EX",
      duration: 5,
    });

    const cached = await cache.wrap("user:1", undefined, async () => ({
      id: 1,
      name: "Changed",
    }));
    expect(cached).toEqual({ id: 1, name: "Ada" });

    await cache.del("user:1");
    expect(await cache.get("user:1")).toBeNull();
  });

  it("supports providing a custom redis client resolver", async () => {
    const redis = createFakeRedis();
    const plugin = cachePlugin({
      serviceKey: "customCache",
      getRedisClient: async () => redis.client,
    });

    const context = createContext();
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.customCache as CacheHelper;
    await cache.set("token", { value: "abc" });
    expect(redis.store.get("token")).toBe('{"value":"abc"}');
  });

  it("throws when Redis service is not available", async () => {
    const plugin = cachePlugin();
    const context = createContext();
    await expect(plugin.onRequest?.(createRequest(), context)).rejects.toThrow(
      /Redis service "redis" not found/,
    );
  });

  it("does not cache undefined results returned by wrap", async () => {
    const redis = createFakeRedis();
    const plugin = cachePlugin();
    const context = createContext();
    context.services.redis = redis.client;
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.cache as CacheHelper;

    const value = await cache.wrap("optional", 45, async () => undefined);
    expect(value).toBeUndefined();
    expect(redis.store.size).toBe(0);
  });

  it("reuses existing cache services without overriding them", async () => {
    const existingHelper = { flag: true };
    const context = createContext();
    context.services.cache = existingHelper;

    const plugin = cachePlugin();
    await plugin.onRequest?.(createRequest(), context);

    expect(context.services.cache).toBe(existingHelper);
  });

  it("purges entries when the deserializer throws", async () => {
    const redis = createFakeRedis();
    redis.store.set("corrupt:data", "invalid json");

    const plugin = cachePlugin({
      keyPrefix: "corrupt",
      deserializer: () => {
        throw new Error("parse error");
      },
    });
    const context = createContext();
    context.services.redis = redis.client;
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.cache as CacheHelper;

    await expect(cache.get("data")).resolves.toBeNull();
    expect(redis.deletedKeys).toContain("corrupt:data");
  });

  it("throws when serializer does not return a string", async () => {
    const redis = createFakeRedis();
    const plugin = cachePlugin({
      serializer: () => undefined as unknown as string,
    });
    const context = createContext();
    context.services.redis = redis.client;
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.cache as CacheHelper;

    await expect(cache.set("bad", { a: 1 })).rejects.toThrow(
      /serializer must return a string/,
    );
  });

  it("uses default serializer/deserializer helpers for undefined values", async () => {
    const redis = createFakeRedis();
    const plugin = cachePlugin({
      keyPrefix: "defaults:",
    });
    const context = createContext();
    context.services.redis = redis.client;
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.cache as CacheHelper;

    await cache.set("value", undefined);
    expect(redis.store.get("defaults:value")).toBe("null");
    await expect(cache.get("value")).resolves.toBeNull();
  });

  it("applies the default TTL when none is provided", async () => {
    const redis = createFakeRedis();
    const plugin = cachePlugin({
      defaultTtlSeconds: 42,
    });
    const context = createContext();
    context.services.redis = redis.client;
    await plugin.onRequest?.(createRequest(), context);
    const cache = context.services.cache as CacheHelper;

    await cache.set("ttl", { id: 1 });
    const lastSet = redis.lastSetArgs[redis.lastSetArgs.length - 1];
    expect(lastSet).toMatchObject({ mode: "EX", duration: 42 });
  });
});

function createContext(): SkyContext {
  return {
    requestId: "req",
    provider: "vitest",
    services: {},
  };
}

function createRequest(): SkyRequest {
  return {
    path: "/",
    method: "GET",
    headers: {},
  };
}

function createFakeMysqlPool(
  resolver: (sql: string, params?: MysqlQueryValues) => unknown[] = () => [],
): {
  pool: MysqlPool;
  queries: Array<{ sql: string; params?: MysqlQueryValues }>;
  endSpy: ReturnType<typeof vi.fn>;
} {
  const queries: Array<{ sql: string; params?: MysqlQueryValues }> = [];
  const endSpy = vi.fn();
  const pool: MysqlPool = {
    async query<T = unknown>(sql: string, params?: MysqlQueryValues) {
      queries.push({ sql, params });
      return [resolver(sql, params) as T[], []];
    },
    async end() {
      endSpy();
    },
  };

  return { pool, queries, endSpy };
}

function createFakeMssqlPool(rows: unknown[] = []): {
  pool: MssqlPool;
  requests: Array<{
    sql?: string;
    inputs: Array<{ name: string; value: unknown; type?: unknown }>;
  }>;
} {
  const requests: Array<{
    sql?: string;
    inputs: Array<{ name: string; value: unknown; type?: unknown }>;
  }> = [];

  const pool: MssqlPool = {
    request() {
      const call = { sql: undefined as string | undefined, inputs: [] as Array<{ name: string; value: unknown; type?: unknown }> };
      requests.push(call);
      return {
        input(name: string, typeOrValue: unknown, maybeValue?: unknown) {
          if (maybeValue === undefined) {
            call.inputs.push({ name, value: typeOrValue });
          } else {
            call.inputs.push({ name, type: typeOrValue, value: maybeValue });
          }
          return this;
        },
        async query<T = unknown>(sql: string) {
          call.sql = sql;
          return { recordset: rows as T[] };
        },
      };
    },
    async close() {
      // no-op for tests
    },
  };

  return { pool, requests };
}

function createFakeRedis(): {
  client: RedisLike;
  store: Map<string, string>;
  lastSetArgs: Array<{ key: string; mode?: string; duration?: number }>;
  deletedKeys: string[];
} {
  const store = new Map<string, string>();
  const lastSetArgs: Array<{ key: string; mode?: string; duration?: number }> =
    [];
  const deletedKeys: string[] = [];
  const client: RedisLike = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, mode?: string, duration?: number) {
      store.set(key, value);
      lastSetArgs.push({ key, mode, duration });
      return "OK";
    },
    async del(key: string) {
      store.delete(key);
      deletedKeys.push(key);
      return 1;
    },
  };

  return { client, store, lastSetArgs, deletedKeys };
}
