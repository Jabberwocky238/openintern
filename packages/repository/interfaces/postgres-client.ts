export interface PostgresQueryResult<Row = unknown> {
  rows: Row[];
  rowCount: number | null;
}

export interface IPostgresQueryable {
  query<Row = unknown>(
    statement: string,
    params?: unknown[]
  ): Promise<PostgresQueryResult<Row>>;
}

export interface IPostgresClient extends IPostgresQueryable {
  release(): void;
}

export interface IPostgresPool extends IPostgresQueryable {
  connect(): Promise<IPostgresClient>;
  end(): Promise<void>;
}


