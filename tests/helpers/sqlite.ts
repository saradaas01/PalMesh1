import { DatabaseSync } from 'node:sqlite';
import { SqliteDtnStore, type SynchronousSqliteDatabase, type SqliteRow, type SqliteValue } from '../../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';

/** Tests exercise SQLite's actual SQL, constraints, transactions, and reopening. */
export class TestSqliteDatabase implements SynchronousSqliteDatabase {
  public readonly connection: DatabaseSync;

  public constructor(path = ':memory:') {
    this.connection = new DatabaseSync(path);
  }

  public execute(sql: string, parameters: readonly SqliteValue[] = []): { rows: readonly SqliteRow[]; rowsAffected: number } {
    const statement = this.connection.prepare(sql);
    if (statement.columns().length > 0) {
      return { rows: statement.all(...parameters) as readonly SqliteRow[], rowsAffected: 0 };
    }
    return { rows: [], rowsAffected: Number(statement.run(...parameters).changes) };
  }

  public close(): void {
    this.connection.close();
  }
}

export function createTestStore(filename = ':memory:'): { store: SqliteDtnStore; close: () => void; db: DatabaseSync } {
  const database = new TestSqliteDatabase(filename);
  return { store: new SqliteDtnStore(database), close: () => database.close(), db: database.connection };
}
