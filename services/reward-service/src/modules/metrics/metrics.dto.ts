/**
 * OpenAPI / TS schemas for metric metadata endpoints (`sendSuccess` `data` shapes).
 */

export interface MetricTablesQuery {
  /** Case-insensitive contains filter on table label */
  label?: string;
}

export interface MetricColumnsQuery {
  label?: string;
  metricTableId?: string;
}

export interface MetricTableDto {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetricColumnDto {
  id: string;
  tableId: string;
  /** Owning logical table key (for convenience when filtering columns globally). */
  metricTableKey: string;
  metricTableLabel: string;
  key: string;
  label: string;
  /** FE hint, e.g. `integer`, `number`. */
  valueType: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetricTablesEnvelopeData {
  tables: MetricTableDto[];
}

export interface MetricColumnsEnvelopeData {
  columns: MetricColumnDto[];
}
