"use strict";
// Preloaded with `node --require` to simulate the optional "mqtt" package not
// being installed (npm install --omit=optional, or a failed optional install).
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "mqtt") {
    const err = new Error("Cannot find module 'mqtt'");
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  return originalLoad.call(this, request, ...rest);
};
