import { MssqlClient } from "../../../../src";
import { Todo, TodoCreateInput, TodoUpdateInput } from "../todos/types";

interface MssqlTodoRow {
  id: number;
  title: string;
  completed: boolean | number;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

export interface MssqlTodoRepository {
  list(): Promise<Todo[]>;
  getById(id: number): Promise<Todo | null>;
  create(input: TodoCreateInput): Promise<Todo>;
  update(id: number, input: TodoUpdateInput): Promise<Todo | null>;
  remove(id: number): Promise<boolean>;
}

const MSSQL_TODOS_TABLE = "dbo.mssql_todos";

let tableReady = false;
let tablePromise: Promise<void> | null = null;

async function ensureTable(mssql: MssqlClient): Promise<void> {
  if (tableReady) {
    return;
  }
  if (!tablePromise) {
    tablePromise = mssql
      .query(
        "if object_id('dbo.mssql_todos', 'U') is null " +
          "begin " +
          "create table dbo.mssql_todos (" +
          "id int identity(1,1) primary key, " +
          "title nvarchar(255) not null, " +
          "completed bit not null default 0, " +
          "created_at datetime2 not null default sysdatetime(), " +
          "updated_at datetime2 not null default sysdatetime()" +
          "); " +
          "end",
      )
      .then(() => {
        tableReady = true;
      })
      .catch((error) => {
        tablePromise = null;
        throw error;
      });
  }
  await tablePromise;
}

export function createMssqlTodoRepository(
  mssql: MssqlClient,
): MssqlTodoRepository {
  const fetchById = async (id: number): Promise<Todo | null> => {
    await ensureTable(mssql);
    const rows = await mssql.query<MssqlTodoRow>(
      `select id, title, completed, created_at, updated_at from ${MSSQL_TODOS_TABLE} where id = @id`,
      { id },
    );
    const row = rows[0];
    return row ? toTodo(row) : null;
  };

  return {
    async list() {
      await ensureTable(mssql);
      const rows = await mssql.query<MssqlTodoRow>(
        `select id, title, completed, created_at, updated_at from ${MSSQL_TODOS_TABLE} order by id desc`,
      );
      return rows.map(toTodo);
    },
    async getById(id) {
      return fetchById(id);
    },
    async create(input) {
      await ensureTable(mssql);
      const rows = await mssql.query<{ id: number }>(
        `insert into ${MSSQL_TODOS_TABLE} (title, completed) output inserted.id values (@title, @completed)`,
        {
          title: input.title,
          completed: Boolean(input.completed),
        },
      );
      const insertId = rows[0]?.id;
      if (!insertId) {
        throw new Error("Failed to resolve insert id for new MSSQL todo.");
      }
      const created = await fetchById(insertId);
      if (!created) {
        throw new Error("Failed to load newly created MSSQL todo.");
      }
      return created;
    },
    async update(id, input) {
      await ensureTable(mssql);
      const existing = await fetchById(id);
      if (!existing) {
        return null;
      }
      const nextTitle = input.title ?? existing.title;
      const nextCompleted = input.completed ?? existing.completed;
      await mssql.query(
        `update ${MSSQL_TODOS_TABLE} set title = @title, completed = @completed, updated_at = sysdatetime() where id = @id`,
        { id, title: nextTitle, completed: Boolean(nextCompleted) },
      );
      const updated = await fetchById(id);
      return updated ?? { ...existing, title: nextTitle, completed: nextCompleted };
    },
    async remove(id) {
      await ensureTable(mssql);
      const existing = await fetchById(id);
      if (!existing) {
        return false;
      }
      await mssql.query(
        `delete from ${MSSQL_TODOS_TABLE} where id = @id`,
        { id },
      );
      return true;
    },
  };
}

function toTodo(row: MssqlTodoRow): Todo {
  return {
    id: Number(row.id),
    title: row.title,
    completed: row.completed === true || row.completed === 1,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value?: string | Date | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}
