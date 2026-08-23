"use strict";

const bootstrap = require("./startup-bootstrap-runtime.cjs");

const bootstrapStarted = bootstrap.startProductionCredentialBootstrap();

module.exports = Object.freeze({ ...bootstrap, bootstrapStarted });
