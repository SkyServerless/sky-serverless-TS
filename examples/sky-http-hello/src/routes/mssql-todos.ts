import { App, httpBadRequest, httpError, httpNotFound, httpOk } from "../../../../src";
import { CacheHelper, MssqlClient } from "../../../../src/plugins";
import { createMssqlTodoRepository } from "../mssql/todos-repository";
import { TodoCreateInput, TodoUpdateInput } from "../todos/types";

export function registerMssqlTodoRoutes(app: App): void {
  app.get(
    "/mssql/todos",
    async (_request, ctx) => {
      const mssql = ctx.services.mssql as MssqlClient | undefined;
      if (!mssql) {
        return serviceUnavailable(
          "MSSQL not configured",
          "Set SKY_MSSQL_CONN_STR",
        );
      }
      const repo = createMssqlTodoRepository(mssql);
      const cache = ctx.services.cache as CacheHelper | undefined;
      const todos = cache
        ? await cache.wrap("mssql-todos:list", 20, () => repo.list())
        : await repo.list();
      return httpOk({ todos });
    },
    {
      summary: "List MSSQL todos",
      tags: ["mssql"],
      responses: {
        200: { description: "Todo list" },
        503: "MSSQL not configured",
      },
    },
  );

  app.get(
    "/mssql/todos/:id",
    async (request, ctx) => {
      const mssql = ctx.services.mssql as MssqlClient | undefined;
      if (!mssql) {
        return serviceUnavailable(
          "MSSQL not configured",
          "Set SKY_MSSQL_CONN_STR",
        );
      }
      const id = parseTodoId(request.params?.id);
      if (!id) {
        return httpBadRequest("Invalid todo id.");
      }

      const repo = createMssqlTodoRepository(mssql);
      const cache = ctx.services.cache as CacheHelper | undefined;
      const cacheKey = `mssql-todos:${id}`;
      const todo = cache
        ? await cache.wrap(cacheKey, 30, () => repo.getById(id))
        : await repo.getById(id);

      if (!todo) {
        return httpNotFound("Todo not found.");
      }
      return httpOk({ todo });
    },
    {
      summary: "Get MSSQL todo by id",
      tags: ["mssql"],
      parameters: [
        {
          name: "id",
          in: "path",
          description: "Todo id",
          required: true,
          schema: { type: "integer", minimum: 1 },
        },
      ],
      responses: {
        200: { description: "Todo details" },
        400: "Invalid todo id",
        404: "Todo not found",
        503: "MSSQL not configured",
      },
    },
  );

  app.post(
    "/mssql/todos",
    async (request, ctx) => {
      const mssql = ctx.services.mssql as MssqlClient | undefined;
      if (!mssql) {
        return serviceUnavailable(
          "MSSQL not configured",
          "Set SKY_MSSQL_CONN_STR",
        );
      }
      const input = parseTodoCreate(request.body);
      if (!input) {
        return httpBadRequest(
          "Expected JSON body with { title: string, completed?: boolean }.",
        );
      }

      const repo = createMssqlTodoRepository(mssql);
      const todo = await repo.create(input);
      await invalidateTodoCache(
        ctx.services.cache as CacheHelper | undefined,
        todo.id,
      );

      return {
        statusCode: 201,
        body: { todo },
      };
    },
    {
      summary: "Create MSSQL todo",
      tags: ["mssql"],
      requestBody: {
        description: "Todo payload",
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                completed: { type: "boolean" },
              },
              required: ["title"],
            },
            examples: {
              create: {
                value: { title: "Buy milk", completed: false },
              },
            },
          },
        },
      },
      responses: {
        201: { description: "Todo created" },
        400: "Invalid payload",
        503: "MSSQL not configured",
      },
    },
  );

  app.put(
    "/mssql/todos/:id",
    async (request, ctx) => {
      const mssql = ctx.services.mssql as MssqlClient | undefined;
      if (!mssql) {
        return serviceUnavailable(
          "MSSQL not configured",
          "Set SKY_MSSQL_CONN_STR",
        );
      }
      const id = parseTodoId(request.params?.id);
      if (!id) {
        return httpBadRequest("Invalid todo id.");
      }

      const input = parseTodoUpdate(request.body);
      if (!input) {
        return httpBadRequest(
          "Expected JSON body with { title?: string, completed?: boolean }.",
        );
      }

      const repo = createMssqlTodoRepository(mssql);
      const updated = await repo.update(id, input);
      if (!updated) {
        return httpNotFound("Todo not found.");
      }

      await invalidateTodoCache(
        ctx.services.cache as CacheHelper | undefined,
        id,
      );
      return httpOk({ todo: updated });
    },
    {
      summary: "Update MSSQL todo",
      tags: ["mssql"],
      parameters: [
        {
          name: "id",
          in: "path",
          description: "Todo id",
          required: true,
          schema: { type: "integer", minimum: 1 },
        },
      ],
      requestBody: {
        description: "Todo updates",
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                completed: { type: "boolean" },
              },
            },
            examples: {
              rename: {
                value: { title: "Buy bread" },
              },
              complete: {
                value: { completed: true },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Todo updated" },
        400: "Invalid payload",
        404: "Todo not found",
        503: "MSSQL not configured",
      },
    },
  );

  app.delete(
    "/mssql/todos/:id",
    async (request, ctx) => {
      const mssql = ctx.services.mssql as MssqlClient | undefined;
      if (!mssql) {
        return serviceUnavailable(
          "MSSQL not configured",
          "Set SKY_MSSQL_CONN_STR",
        );
      }
      const id = parseTodoId(request.params?.id);
      if (!id) {
        return httpBadRequest("Invalid todo id.");
      }

      const repo = createMssqlTodoRepository(mssql);
      const removed = await repo.remove(id);
      if (!removed) {
        return httpNotFound("Todo not found.");
      }

      await invalidateTodoCache(
        ctx.services.cache as CacheHelper | undefined,
        id,
      );
      return { statusCode: 204 };
    },
    {
      summary: "Delete MSSQL todo",
      tags: ["mssql"],
      parameters: [
        {
          name: "id",
          in: "path",
          description: "Todo id",
          required: true,
          schema: { type: "integer", minimum: 1 },
        },
      ],
      responses: {
        204: { description: "Todo deleted" },
        400: "Invalid todo id",
        404: "Todo not found",
        503: "MSSQL not configured",
      },
    },
  );
}

function parseTodoId(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseTodoCreate(body: unknown): TodoCreateInput | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const payload = body as Record<string, unknown>;
  const title = payload.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return null;
  }
  const completed = payload.completed;
  if (completed !== undefined && typeof completed !== "boolean") {
    return null;
  }

  const result: TodoCreateInput = { title: title.trim() };
  if (completed !== undefined) {
    result.completed = completed;
  }
  return result;
}

function parseTodoUpdate(body: unknown): TodoUpdateInput | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const payload = body as Record<string, unknown>;
  const title = payload.title;
  const completed = payload.completed;

  if (
    title !== undefined &&
    (typeof title !== "string" || title.trim().length === 0)
  ) {
    return null;
  }
  if (completed !== undefined && typeof completed !== "boolean") {
    return null;
  }
  if (title === undefined && completed === undefined) {
    return null;
  }

  const result: TodoUpdateInput = {};
  if (title !== undefined) {
    result.title = title.trim();
  }
  if (completed !== undefined) {
    result.completed = completed;
  }
  return result;
}

async function invalidateTodoCache(
  cache: CacheHelper | undefined,
  id?: number,
): Promise<void> {
  if (!cache) {
    return;
  }
  const tasks: Promise<void>[] = [cache.del("mssql-todos:list")];
  if (id) {
    tasks.push(cache.del(`mssql-todos:${id}`));
  }
  await Promise.all(tasks);
}

function serviceUnavailable(message: string, hint?: string) {
  return httpError({
    statusCode: 503,
    message,
    details: hint ? { hint } : undefined,
  });
}
