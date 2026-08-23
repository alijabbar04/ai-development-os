"use strict";

const deadlineRuntime = require("./startup-deadline.cjs");
const startupDeadline = deadlineRuntime.armProductionCredentialStartupDeadline();
let bootstrapStarted = false;

if (startupDeadline.isActive()) {
  try {
    const bootstrap = require("./startup-bootstrap-runtime.cjs");
    bootstrapStarted = bootstrap.startProductionCredentialBootstrap(startupDeadline);
  } catch {
    startupDeadline.fail("STARTUP_FAILED");
  }
}

module.exports = Object.freeze({ bootstrapStarted });
