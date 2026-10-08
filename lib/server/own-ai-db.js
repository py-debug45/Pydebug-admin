"use strict";

/*
 * Minimal supabase-js-compatible query shim for the Own-AI engine, backed by
 * the panel's own server-side PostgREST client (api/_db.js).
 *
 * The Own-AI engine was originally written against the browser Supabase
 * client (`sb.from(table).select(...).eq(...)...`). This shim keeps that call
 * surface so the engine code stays a faithful port, while every query runs
 * through the service-role server client — the browser never touches the
 * database directly.
 *
 * Supported chain surface (all optional, any order):
 *   from(table).select(cols, { count, head })
 *     .eq/.neq/.in/.gte/.gt/.lte/.lt/.is/.ilike(col, value)
 *     .order(col, { ascending }) .limit(n) .range(from, to) .single()
 *   from(table).insert(row | rows, { onConflict })
 *   from(table).upsert(row | rows, { onConflict })
 *   from(table).update(values).<filters>
 *   from(table).delete().<filters>
 * Awaiting the builder executes the query and resolves { data, error, count }.
 */

const db = require("../../api/_db");

function sanitizeFilterValue(value) {
  return String(value).replace(/[()",\\]/g, " ").trim();
}

function inList(values) {
  return `(${values.map((value) => `"${sanitizeFilterValue(value)}"`).join(",")})`;
}

const OP_METHODS = {
  eq: "eq", neq: "neq", gt: "gt", gte: "gte", lt: "lt", lte: "lte", is: "is", ilike: "ilike",
};

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orderBy = null;
    this.limitCount = undefined;
    this.offsetCount = undefined;
    this.columns = "*";
    this.head = false;
    this.wantCount = false;
    this.singleRow = false;
    this.verb = "select";
    this.body = undefined;
    this.insertOptions = {};
  }

  select(columns = "*", options = {}) {
    this.columns = columns || "*";
    if (options && typeof options === "object") {
      if (options.head) this.head = true;
      if (options.count) this.wantCount = true;
    }
    return this;
  }

  order(column, options = {}) {
    this.orderBy = `${column}.${options.ascending === false ? "desc" : "asc"}`;
    return this;
  }

  limit(count) {
    this.limitCount = Math.max(0, Number(count));
    return this;
  }

  range(from, to) {
    this.offsetCount = Math.max(0, Number(from) || 0);
    const size = Number(to) - Number(from) + 1;
    this.limitCount = Math.max(0, Number.isFinite(size) ? size : 0);
    return this;
  }

  single() {
    this.singleRow = true;
    this.limitCount = 1;
    return this;
  }

  insert(rows, options = {}) {
    this.verb = "insert";
    this.body = rows;
    this.insertOptions = options || {};
    return this;
  }

  upsert(rows, options = {}) {
    this.verb = "insert";
    this.body = rows;
    this.insertOptions = { ...(options || {}), upsert: true };
    return this;
  }

  update(values) {
    this.verb = "update";
    this.body = values;
    return this;
  }

  delete() {
    this.verb = "delete";
    return this;
  }

  addFilter(op, column, value) {
    if (op === "in") {
      const values = Array.isArray(value) ? value : [value];
      this.filters.push({ column, op: "in", value: inList(values) });
    } else if (op === "is") {
      this.filters.push({ column, op: "is", value: String(value) });
    } else {
      this.filters.push({ column, op, value: String(value) });
    }
    return this;
  }

  eq(column, value) { return this.addFilter("eq", column, value); }
  neq(column, value) { return this.addFilter("neq", column, value); }
  gt(column, value) { return this.addFilter("gt", column, value); }
  gte(column, value) { return this.addFilter("gte", column, value); }
  lt(column, value) { return this.addFilter("lt", column, value); }
  lte(column, value) { return this.addFilter("lte", column, value); }
  is(column, value) { return this.addFilter("is", column, value); }
  ilike(column, value) { return this.addFilter("ilike", column, value); }
  in(column, values) { return this.addFilter("in", column, values); }

  async execute() {
    try {
      if (this.verb === "select") {
        if (this.head) {
          const count = await db.count(this.table, { filters: this.filters });
          return { data: null, error: null, count };
        }
        const result = await db.list(this.table, {
          select: this.columns,
          filters: this.filters,
          order: this.orderBy,
          limit: this.limitCount,
          offset: this.offsetCount,
          count: this.wantCount,
        });
        if (this.singleRow) {
          const row = result.rows[0] || null;
          if (!row) {
            return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count: result.count ?? null };
          }
          return { data: row, error: null, count: result.count ?? null };
        }
        return { data: result.rows, error: null, count: result.count ?? null };
      }
      if (this.verb === "insert") {
        const many = Array.isArray(this.body);
        const row = await db.insert(this.table, this.body, {
          many,
          upsert: this.insertOptions.upsert === true,
          onConflict: this.insertOptions.onConflict,
        });
        return { data: many ? row : row, error: null };
      }
      if (this.verb === "update") {
        const row = await db.update(this.table, this.body, { filters: this.filters, many: true });
        return { data: row, error: null };
      }
      if (this.verb === "delete") {
        const row = await db.remove(this.table, { filters: this.filters, many: true });
        return { data: row, error: null };
      }
      return { data: null, error: { message: `unsupported verb ${this.verb}` } };
    } catch (error) {
      return { data: null, error: { message: error.message, code: error.code, details: error.details } };
    }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

const sb = {
  from(table) {
    return new Query(String(table));
  },
};

module.exports = sb;
module.exports.Query = Query;
