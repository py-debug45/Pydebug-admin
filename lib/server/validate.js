"use strict";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value, name = "id") {
  const text = String(value || "");
  if (!UUID_RE.test(text)) {
    const error = new Error(`${name} must be a valid UUID`);
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  return text;
}

function identifier(value, name = "id") {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) {
    const error = new Error(`${name} is invalid`);
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  return text;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    const error = new Error(`${name} must be one of: ${allowed.join(", ")}`);
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  return value;
}

function integer(value, options = {}) {
  const number = Number(value);
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(number) || number < min || number > max) {
    const error = new Error(`${options.name || "value"} must be an integer between ${min} and ${max}`);
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  return number;
}

function boolean(value, name = "value") {
  if (typeof value !== "boolean") {
    const error = new Error(`${name} must be true or false`);
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  return value;
}

module.exports = { UUID_RE, uuid, identifier, oneOf, integer, boolean };
