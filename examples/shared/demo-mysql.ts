import { MysqlPool, mysqlPlugin } from "../../src/plugins/data/mysql";

export interface DemoUserRow {
  id: number;
  name: string;
}

const demoUsers: DemoUserRow[] = [
  { id: 1, name: "Ada Lovelace" },
  { id: 2, name: "Linus Torvalds" },
  { id: 3, name: "Margaret Hamilton" },
];

const demoPool: MysqlPool = {
  async query<T = DemoUserRow>() {
    console.log("[mysql] Fake query executed");
    return [demoUsers as unknown as T[], undefined];
  },
  async end() {
    console.log("[mysql] Fake pool closed");
  },
};

export function createDemoMysqlPlugin() {
  return mysqlPlugin({
    connection: { host: "demo" },
    poolFactory: () => demoPool,
  });
}
