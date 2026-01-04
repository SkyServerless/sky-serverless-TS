import { App, httpBadRequest, httpError, httpNotFound, httpOk } from "../../../../src";
import { CacheHelper, MysqlClient } from "../../../../src/plugins";
import { createTodoRepository } from "../todos/repository";
import { TodoCreateInput, TodoUpdateInput } from "../todos/types";

export function registerTodoRoutes(app: App): void {
  app.get(
    "/mysql/todos",
    async (_request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient | undefined;
      if (!mysql) {
        return serviceUnavailable("MySQL not configured", "Set SKY_MYSQL_URI");
      }
      const repo = createTodoRepository(mysql);
      const cache = ctx.services.cache as CacheHelper | undefined;
      const todos = cache
        ? await cache.wrap("mysql-todos:list", 20, () => repo.list())
        : await repo.list();
      return httpOk({ todos });
    },
    {
      summary: "List todos",
      tags: ["mysql"],
      responses: {
        200: { description: "Todo list" },
        503: "MySQL not configured",
      },
    },
  );

  app.get(
    "/mysql/todos/:id",
    async (request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient | undefined;
      if (!mysql) {
        return serviceUnavailable("MySQL not configured", "Set SKY_MYSQL_URI");
      }
      const id = parseTodoId(request.params?.id);
      if (!id) {
        return httpBadRequest("Invalid todo id.");
      }

      const repo = createTodoRepository(mysql);
      const cache = ctx.services.cache as CacheHelper | undefined;
      const cacheKey = `mysql-todos:${id}`;
      const todo = cache
        ? await cache.wrap(cacheKey, 30, () => repo.getById(id))
        : await repo.getById(id);

      if (!todo) {
        return httpNotFound("Todo not found.");
      }
      return httpOk({ todo });
    },
    {
      summary: "Get todo by id",
      tags: ["mysql"],
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
        503: "MySQL not configured",
      },
    },
  );

  app.post(
    "/mysql/todos",
    async (request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient | undefined;
      if (!mysql) {
        return serviceUnavailable("MySQL not configured", "Set SKY_MYSQL_URI");
      }
      const input = parseTodoCreate(request.body);
      if (!input) {
        return httpBadRequest(
          "Expected JSON body with { title: string, completed?: boolean }.",
        );
      }

      const repo = createTodoRepository(mysql);
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
      summary: "Create todo",
      tags: ["mysql"],
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
          },
        },
      },
      responses: {
        201: { description: "Todo created" },
        400: "Invalid payload",
        503: "MySQL not configured",
      },
    },
  );

  app.put(
    "/mysql/todos/:id",
    async (request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient | undefined;
      if (!mysql) {
        return serviceUnavailable("MySQL not configured", "Set SKY_MYSQL_URI");
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

      const repo = createTodoRepository(mysql);
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
      summary: "Update todo",
      tags: ["mysql"],
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
          },
        },
      },
      responses: {
        200: { description: "Todo updated" },
        400: "Invalid payload",
        404: "Todo not found",
        503: "MySQL not configured",
      },
    },
  );

  app.delete(
    "/mysql/todos/:id",
    async (request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient | undefined;
      if (!mysql) {
        return serviceUnavailable("MySQL not configured", "Set SKY_MYSQL_URI");
      }
      const id = parseTodoId(request.params?.id);
      if (!id) {
        return httpBadRequest("Invalid todo id.");
      }

      const repo = createTodoRepository(mysql);
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
      summary: "Delete todo",
      tags: ["mysql"],
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
        503: "MySQL not configured",
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
  const tasks: Promise<void>[] = [cache.del("mysql-todos:list")];
  if (id) {
    tasks.push(cache.del(`mysql-todos:${id}`));
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
