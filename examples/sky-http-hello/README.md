# Sky examples app

Unified example app that exercises Sky plugins with simple ping routes and a Todos CRUD (MySQL-backed) domain.

## Run (all services)

```bash
npm run examples
```

This starts MySQL, MSSQL, and Redis via docker compose and launches the local server.

## Routes

- GET /health
- GET /hello/:name
- GET /ping
- GET /ping/mysql
- GET /ping/mssql
- GET /ping/redis
- GET /ping/cache
- POST /auth/login
- GET /auth/me
- GET /protected
- GET /mysql/todos
- GET /mysql/todos/:id
- POST /mysql/todos
- PUT /mysql/todos/:id
- DELETE /mysql/todos/:id
- GET /mssql/todos
- GET /mssql/todos/:id
- POST /mssql/todos
- PUT /mssql/todos/:id
- DELETE /mssql/todos/:id

## Sample auth credentials

- ada@example.com / pass-ada
- linus@example.com / pass-linus

## Sample request bodies

Create todo (MySQL or MSSQL):

```json
{ "title": "Buy milk", "completed": false }
```

Update todo (MySQL or MSSQL):

```json
{ "title": "Buy bread" }
```

```json
{ "completed": true }
```

## Notes

- Swagger UI is available at /docs.
- If you skip docker compose, set SKY_MYSQL_URI, SKY_MSSQL_CONN_STR, and SKY_REDIS_URI manually.
