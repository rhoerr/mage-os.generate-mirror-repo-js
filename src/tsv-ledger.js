const fs = require('fs');
const path = require('path');

/**
 * Parse, format, read and write a git-committed TSV ledger: a header line of the field names, then one
 * sorted line per row, unique by key.
 *
 * @param {{fields: Array<String>, key: function(Object): String, compare: function(Object, Object): Number, validate: function(Object, String): void, label: String}} options
 */
function tsvLedger({fields, key, compare, validate, label}) {
  function assertUnique(rows) {
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(key(row))) {
        throw new Error(`${label}: duplicate entry for ${key(row)}`);
      }
      seen.add(key(row));
    }
  }

  function parse(text) {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.shift() !== fields.join('\t')) {
      throw new Error(`${label} header must be: ${fields.join(' ')}`);
    }
    const rows = lines.map((line, index) => {
      const values = line.split('\t');
      if (values.length !== fields.length) {
        throw new Error(`${label} line ${index + 2}: expected ${fields.length} fields, found ${values.length}`);
      }
      const row = Object.fromEntries(fields.map((field, i) => [field, values[i]]));
      validate(row, `${label} line ${index + 2}`);
      return row;
    });
    assertUnique(rows);
    return rows;
  }

  function format(rows) {
    rows.forEach(row => validate(row, `${label} row ${key(row)}`));
    assertUnique(rows);
    const sorted = rows.slice().sort(compare);
    return [fields.join('\t'), ...sorted.map(row => fields.map(field => row[field]).join('\t'))].join('\n') + '\n';
  }

  return {
    parse,
    format,
    read: file => parse(fs.readFileSync(file, 'utf8')),
    write(file, rows) {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, format(rows));
    },
  };
}

module.exports = {tsvLedger};
