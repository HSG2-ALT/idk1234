'use strict';
// The database comes with Node.js. No native npm addon or C++ compiler is needed.
const { DatabaseSync } = require('node:sqlite');

function sqliteError(error) {
  // Keep the existing API's constraint handling and generic database errors.
  if (error.code === 'ERR_SQLITE_ERROR') {
    error.code = (error.errcode & 255) === 19 ? 'SQLITE_CONSTRAINT' : 'SQLITE_ERROR';
  }
  return error;
}

class Database {
  constructor(filename) {
    this.connection = new DatabaseSync(filename);
    this.connection.exec('PRAGMA busy_timeout = 5000');
    this.depth = 0;
    this.sequence = 0;
  }

  exec(sql) {
    try { this.connection.exec(sql); return this; }
    catch (error) { throw sqliteError(error); }
  }

  prepare(sql) {
    let statement;
    try { statement = this.connection.prepare(sql); }
    catch (error) { throw sqliteError(error); }
    const wrapped = {};
    for (const method of ['run', 'get', 'all']) wrapped[method] = (...parameters) => {
      try { return statement[method](...parameters); }
      catch (error) { throw sqliteError(error); }
    };
    return wrapped;
  }

  pragma(sql, options = {}) {
    const rows = this.prepare('PRAGMA ' + sql).all();
    return options.simple ? Object.values(rows[0] || {})[0] : rows;
  }

  transaction(fn) {
    return (...args) => {
      const nested = this.depth > 0;
      const savepoint = 'biscord_tx_' + (++this.sequence);
      this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      this.depth++;
      try {
        const value = fn(...args);
        if (value && typeof value.then === 'function') throw new TypeError('Database transactions must be synchronous.');
        this.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        return value;
      } catch (error) {
        this.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
        throw error;
      } finally {
        this.depth--;
      }
    };
  }

  close() { this.connection.close(); }
}
module.exports = Database;
