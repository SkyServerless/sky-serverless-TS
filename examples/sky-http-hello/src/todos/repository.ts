import { MysqlClient } from "../../../../src";
import { Todo, TodoCreateInput, TodoUpdateInput } from "./types";

interface TodoRow {
  id: number;
  title: string;
  completed: number | boolean;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

export interface TodoRepository {
  list(): Promise<Todo[]>;
  getById(id: number): Promise<Todo | null>;
  create(input: TodoCreateInput): Promise<Todo>;
  update(id: number, input: TodoUpdateInput): Promise<Todo | null>;
  remove(id: number): Promise<boolean>;
}

let todosTableReady = false;
let todosTablePromise: Promise<void> | null = null;

async function ensureTodosTable(mysql: MysqlClient): Promise<void> {
  if (todosTableReady) {
    return;
  }
  if (!todosTablePromise) {
    todosTablePromise = mysql
      .query(
        "create table if not exists todos (" +
          "id int auto_increment primary key, " +
          "title varchar(255) not null, " +
          "completed tinyint(1) not null default 0, " +
          "created_at timestamp not null default current_timestamp, " +
          "updated_at timestamp not null default current_timestamp on update current_timestamp" +
          ")",
      )
      .then(() => {
        todosTableReady = true;
      })
      .catch((error) => {
        todosTablePromise = null;
        throw error;
      });
  }
  await todosTablePromise;
}

export function createTodoRepository(mysql: MysqlClient): TodoRepository {
  const fetchById = async (id: number): Promise<Todo | null> => {
    await ensureTodosTable(mysql);
    const rows = await mysql.query<TodoRow>(
      "select id, title, completed, created_at, updated_at from todos where id = ?",
      [id],
    );
    const row = rows[0];
    return row ? toTodo(row) : null;
  };

  return {
    async list() {
      await ensureTodosTable(mysql);
      const rows = await mysql.query<TodoRow>(
        "select id, title, completed, created_at, updated_at from todos order by id desc",
      );
      return rows.map(toTodo);
    },
    async getById(id) {
      return fetchById(id);
    },
    async create(input) {
      await ensureTodosTable(mysql);
      const [insertResult] = await mysql.rawQuery<unknown>(
        "insert into todos (title, completed) values (?, ?)",
        [input.title, input.completed ? 1 : 0],
      );
      const insertId = extractInsertId(insertResult);
      if (!insertId) {
        throw new Error("Failed to resolve insert id for new todo.");
      }
      const created = await fetchById(insertId);
      if (!created) {
        throw new Error("Failed to load newly created todo.");
      }
      return created;
    },
    async update(id, input) {
      await ensureTodosTable(mysql);
      const existing = await fetchById(id);
      if (!existing) {
        return null;
      }
      const nextTitle = input.title ?? existing.title;
      const nextCompleted = input.completed ?? existing.completed;
      await mysql.query(
        "update todos set title = ?, completed = ?, updated_at = current_timestamp where id = ?",
        [nextTitle, nextCompleted ? 1 : 0, id],
      );
      const updated = await fetchById(id);
      return updated ?? { ...existing, title: nextTitle, completed: nextCompleted };
    },
    async remove(id) {
      await ensureTodosTable(mysql);
      const existing = await fetchById(id);
      if (!existing) {
        return false;
      }
      await mysql.query("delete from todos where id = ?", [id]);
      return true;
    },
  };
}

function toTodo(row: TodoRow): Todo {
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

function extractInsertId(result: unknown): number | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  if ("insertId" in result) {
    const insertId = (result as { insertId?: number }).insertId;
    if (typeof insertId === "number" && insertId > 0) {
      return insertId;
    }
  }
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];
    if (first && typeof first === "object" && "insertId" in first) {
      const insertId = (first as { insertId?: number }).insertId;
      if (typeof insertId === "number" && insertId > 0) {
        return insertId;
      }
    }
  }
  return null;
}
