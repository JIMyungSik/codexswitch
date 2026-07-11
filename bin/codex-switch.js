#!/usr/bin/env node
'use strict';

require('../src/cli.js').main(process.argv.slice(2)).then(
  (code) => process.exit(code || 0),
  (err) => {
    const ui = require('../src/ui.js');
    console.error(ui.fail(`${ui.red('error:')} ${err && err.message ? err.message : err}`));
    process.exit(1);
  }
);
