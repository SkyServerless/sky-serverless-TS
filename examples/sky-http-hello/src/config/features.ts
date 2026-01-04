export interface ExampleFeatures {
  mysql: boolean;
  mssql: boolean;
  redis: boolean;
  cache: boolean;
}

export function resolveExampleFeatures(
  env: NodeJS.ProcessEnv = process.env,
): ExampleFeatures {
  const mysql = Boolean(env.SKY_MYSQL_URI);
  const mssql = Boolean(env.SKY_MSSQL_CONN_STR);
  const redis = Boolean(env.SKY_REDIS_URI);

  return {
    mysql,
    mssql,
    redis,
    cache: redis,
  };
}
