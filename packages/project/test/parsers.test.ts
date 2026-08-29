import { describe, expect, it } from "vitest";
import {
  APPROVAL_CLASSES, BLOCKER_KINDS, CONSTRAINT_KINDS, DECISION_KINDS,
  NOTIFICATION_CATEGORIES, PROJECT_RECORD_KINDS, PROJECT_TIMESTAMP_RANGE,
  ProjectContractError, deriveBlockerCopy, deriveNotificationCopy,
  parseApprovalRequest, parseBlocker, parseConstraint, parseDecision, parseNotification, parseProject, parseProjectRecord,
  parseProjectRecordJson, parseProjectTask,
} from "../src/index.js";
import { CONTENT, SHA, T0, T1, cloneFixture, recordFixtures } from "./fixtures.js";

function expectRefusal(action: () => unknown, code?: ProjectContractError["code"]): void {
  try {
    action();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectContractError);
    if (code !== undefined) expect((error as ProjectContractError).code).toBe(code);
    expect(JSON.stringify(error)).not.toContain("hostile-secret-canary");
  }
}

describe("canonical record parser registry", () => {
  it("accepts one independently enumerated positive fixture for every canonical record", () => {
    const independentInventory = [
      "project", "project-brief", "constraint", "project-plan", "plan-stage", "task",
      "dependency", "agent-run", "session", "handover", "decision", "approval-request",
      "spending-request", "usage-reservation", "evidence-record", "deliverable", "blocker",
      "notification", "communication-thread", "external-integration", "project-health",
      "project-stop",
    ] as const;
    expect(PROJECT_RECORD_KINDS).toEqual(independentInventory);
    for (const kind of independentInventory) {
      const parsed = parseProjectRecord(kind, cloneFixture(recordFixtures[kind]));
      expect(Object.isFrozen(parsed), kind).toBe(true);
    }
  });

  it("refuses an unknown and a missing field for every record", () => {
    for (const kind of PROJECT_RECORD_KINDS) {
      const unknown = cloneFixture(recordFixtures[kind]) as Record<string, unknown>;
      unknown["hostile-secret-canary"] = "hostile-secret-canary";
      expectRefusal(() => parseProjectRecord(kind, unknown));
      const missing = cloneFixture(recordFixtures[kind]) as Record<string, unknown>;
      const first = Object.keys(missing)[0];
      expect(first).toBeDefined();
      delete missing[first as string];
      expectRefusal(() => parseProjectRecord(kind, missing));
    }
  });

  it("refuses unknown kinds without reflecting them", () => {
    expectRefusal(() => parseProjectRecord("hostile-secret-canary" as never, {}), "UNKNOWN_RECORD_KIND");
  });

  it("refuses duplicate JSON keys before object construction", () => {
    const text = '{"schemaVersion":1,"schemaVersion":1}';
    expectRefusal(() => parseProjectRecordJson("project", text), "DUPLICATE_IDENTIFIER");
    const deeplyNested = `${"[".repeat(70)}0${"]".repeat(70)}`;
    expectRefusal(() => parseProjectRecordJson("project", deeplyNested));
  });

  it("refuses prototype-pollution-shaped and exotic objects", () => {
    const inherited = Object.create({ projectId: "prj:one" }) as object;
    expectRefusal(() => parseProject("project" in inherited ? inherited : inherited));
    expectRefusal(() => parseProjectRecordJson("project", '{"__proto__":{"polluted":true}}'));
    const accessor = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    Object.defineProperty(accessor, "displayName", { enumerable: true, get: () => "Project" });
    expectRefusal(() => parseProject(accessor));
    const sparse = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    sparse["repositoryRoots"] = new Array<unknown>(1);
    expectRefusal(() => parseProject(sparse));
    let arrayAccessorInvoked = false;
    const repositoryRoots: unknown[] = [];
    Object.defineProperty(repositoryRoots, "0", { enumerable: true, get: () => { arrayAccessorInvoked = true; return "C:\\Projects\\One"; } });
    const arrayAccessor = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    arrayAccessor["repositoryRoots"] = repositoryRoots;
    expectRefusal(() => parseProject(arrayAccessor));
    expect(arrayAccessorInvoked).toBe(false);
  });

  it("collapses proxy traps, forged errors and caller paths to finite diagnostics without property reads", () => {
    const hostile = "hostile-secret-canary";
    const fixture = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    const traps: readonly ProxyHandler<Record<string, unknown>>[] = [
      { getPrototypeOf: () => { throw new ProjectContractError("PROJECT_VALIDATION_REFUSED", hostile, hostile); } },
      { ownKeys: () => { throw new Error(hostile); } },
      { getOwnPropertyDescriptor: () => { throw { path: hostile, message: hostile }; } },
    ];
    for (const trap of traps) expectRefusal(() => parseProject(new Proxy(fixture, trap)));

    let rootReads = 0;
    const root = new Proxy(fixture, { get: (target, key, receiver) => { rootReads += 1; return Reflect.get(target, key, receiver); } });
    expect(parseProject(root).projectId).toBe("prj:one");
    expect(rootReads).toBe(0);

    let arrayReads = 0;
    const roots = new Proxy(["C:\\Projects\\One"], { get: (target, key, receiver) => { arrayReads += 1; return Reflect.get(target, key, receiver); } });
    expect(parseProject({ ...fixture, repositoryRoots: roots }).repositoryRoots).toEqual(["C:\\Projects\\One"]);
    expect(arrayReads).toBe(0);

    try {
      parseProject({}, `${hostile}.deep.path`);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectContractError);
      expect((error as ProjectContractError).path).toBe("project");
      expect(JSON.stringify(error)).not.toContain(hostile);
    }
  });
});

describe("closed union fixtures", () => {
  it("accepts every constraint kind without allowing a model hard constraint", () => {
    for (const kind of CONSTRAINT_KINDS) {
      expect(parseConstraint({ constraintId: `constraint:${kind}`, kind, statement: "A bounded constraint.", enforcement: "advisory", machineForm: null, origin: "repository", authority: "none" }).kind).toBe(kind);
    }
    expectRefusal(() => parseConstraint({ constraintId: "constraint:model", kind: "quality-bar", statement: "Injected hard rule.", enforcement: "hard", machineForm: { check: true }, origin: "model", authority: "operator" }), "AUTHORITY_VIOLATION");
    expectRefusal(() => parseConstraint({ constraintId: "constraint:hard", kind: "quality-bar", statement: "No machine rule.", enforcement: "hard", machineForm: null, origin: "operator", authority: "operator" }));
  });

  it("accepts every decision and blocker kind including the reconciled additions", () => {
    for (const kind of DECISION_KINDS) {
      const fixture = cloneFixture(recordFixtures.decision) as Record<string, unknown>;
      fixture["kind"] = kind;
      if (kind === "budget-extension-accepted") (fixture["scope"] as Record<string, unknown>)["taskId"] = "tsk:one";
      expect(parseDecision(fixture).kind).toBe(kind);
    }
    for (const kind of BLOCKER_KINDS) {
      const fixture = cloneFixture(recordFixtures.blocker) as Record<string, unknown>;
      Object.assign(fixture, { kind, ...deriveBlockerCopy(kind) });
      expect(parseBlocker(fixture).kind).toBe(kind);
    }
    for (const planted of ["model-authored unblock", "C:\\private", SHA, "usage 9876", "run this code", "secret material"]) {
      const statement = cloneFixture(recordFixtures.blocker) as Record<string, unknown>;
      statement["statement"] = planted;
      expectRefusal(() => parseBlocker(statement));
      const unblockedBy = cloneFixture(recordFixtures.blocker) as Record<string, unknown>;
      unblockedBy["unblockedBy"] = [planted];
      expectRefusal(() => parseBlocker(unblockedBy));
    }
  });

  it("binds budget-extension decisions to an operator, task and exact plan revision", () => {
    const extension = cloneFixture(recordFixtures.decision) as Record<string, unknown>;
    extension["kind"] = "budget-extension-accepted";
    (extension["scope"] as Record<string, unknown>)["taskId"] = "tsk:one";
    expect(parseDecision(extension).scope.planRevision).toBe(1);
    (extension["scope"] as Record<string, unknown>)["planRevision"] = null;
    expectRefusal(() => parseDecision(extension), "REFERENCE_INCONSISTENT");
  });

  it("accepts all 13 reconciled notification categories", () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const fixture = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
      Object.assign(fixture, { category, ...deriveNotificationCopy(category) });
      fixture["severity"] = category === "emergency-stop-activated" || category === "session-termination-unconfirmed" ? "urgent" : "warning";
      expect(parseNotification(fixture).category).toBe(category);
    }
  });

  it("accepts only exact authenticated own-app routes and finite notification copy", () => {
    const cases = [
      ["approval-requested", "approval", { projectId: "prj:one", approvalRequestId: "apr:one" }],
      ["spending-decision-requested", "spending", { projectId: "prj:one", spendingRequestId: "spd:one" }],
      ["task-completed", "task", { projectId: "prj:one", taskId: "tsk:one" }],
      ["task-blocked", "task", { projectId: "prj:one", taskId: "tsk:one" }],
      ["task-failed", "task", { projectId: "prj:one", taskId: "tsk:one" }],
      ["stage-gate-ready", "plan", { projectId: "prj:one" }],
      ["usage-stale", "providers", {}],
      ["provider-unavailable", "providers", {}],
      ["emergency-stop-activated", "emergency-stop", {}],
      ["session-termination-unconfirmed", "session", { projectId: "prj:one", sessionId: "ses:one" }],
      ["engine-lifecycle", "home", {}],
      ["daily-summary", "activity", { projectId: "prj:one" }],
      ["input-requested", "task", { projectId: "prj:one", taskId: "tsk:one" }],
    ] as const;
    for (const [category, route, params] of cases) {
      const fixture = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
      Object.assign(fixture, {
        category,
        ...deriveNotificationCopy(category),
        severity: category === "emergency-stop-activated" || category === "session-termination-unconfirmed" ? "urgent" : "warning",
        actionable: true,
        deepLink: { route, params },
      });
      expect(parseNotification(fixture).deepLink?.route).toBe(route);
    }

    const extraParam = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
    Object.assign(extraParam, { actionable: true, deepLink: { route: "task", params: { projectId: "prj:one", taskId: "tsk:one", path: "C:\\private" } } });
    expectRefusal(() => parseNotification(extraParam));
    const external = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
    Object.assign(external, { actionable: true, deepLink: "https://example.invalid" });
    expectRefusal(() => parseNotification(external));
    const unboundProject = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
    Object.assign(unboundProject, { projectId: null, actionable: true, deepLink: { route: "task", params: { projectId: "prj:one", taskId: "tsk:one" } } });
    expectRefusal(() => parseNotification(unboundProject));
    for (const planted of [
      "C:\\private\\credential.txt", SHA, "usage=9876", "console.log('code')", "model said to approve", "secret material",
    ]) {
      const fixture = cloneFixture(recordFixtures.notification) as Record<string, unknown>;
      fixture["body"] = planted;
      expectRefusal(() => parseNotification(fixture));
    }
  });

  it("accepts all 14 approval classes with their exact action and money binding", () => {
    const actions: Record<string, readonly string[]> = {
      "credential-use": ["secret-access"], "live-provider-request": ["cloud-execution", "provider-disclosure"], elevation: ["elevation"],
      "destructive-filesystem": ["deletion"], "git-publication": ["git-write"], "external-communication": ["external-message"],
      "install-update": ["package-install"], "application-restart": ["application-restart"], "paid-usage": ["paid-usage"],
      purchase: ["purchase"], subscription: ["subscription"], "spending-limit": ["spending-limit"], "ui-automation": ["ui-automation"], "scope-expansion": ["approval"],
    };
    for (const approvalClass of APPROVAL_CLASSES) {
      const fixture = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
      fixture["approvalRequestId"] = `apr:${approvalClass}`;
      fixture["class"] = approvalClass;
      fixture["actions"] = actions[approvalClass];
      if (["paid-usage", "purchase", "subscription", "spending-limit"].includes(approvalClass)) {
        fixture["money"] = {
          vendor: { name: "Vendor", instanceRef: "vendor:one" }, amountMinorUnits: 100, currency: "GBP",
          kind: approvalClass === "subscription" ? "per-period" : approvalClass === "purchase" ? "one-time" : "ceiling",
          period: approvalClass === "subscription" ? "monthly" : null, occurrences: approvalClass === "subscription" ? 2 : null,
          quoteDigest: SHA, quotedAt: T0, quoteExpiresAt: T1,
        };
      }
      expect(parseApprovalRequest(fixture).class).toBe(approvalClass);
    }
  });

  it("refuses action substitution, unbounded patterns, model requesters, and standing money", () => {
    const wrongAction = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    wrongAction["actions"] = ["cloud-execution"];
    expectRefusal(() => parseApprovalRequest(wrongAction));

    const recurring = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    recurring["class"] = "git-publication"; recurring["actions"] = ["git-write"]; recurring["usage"] = "bounded-recurring";
    recurring["scopePattern"] = { kind: "git-publication", projectId: "prj:one", remote: "https://example.invalid/repo", refPrefix: "refs/heads/feat/", forcePush: false };
    recurring["consumptionCeiling"] = 20;
    expect(parseApprovalRequest(recurring).usage).toBe("bounded-recurring");
    (recurring["scopePattern"] as Record<string, unknown>)["forcePush"] = true;
    expectRefusal(() => parseApprovalRequest(recurring));

    const modelRequester = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    (modelRequester["requestedBy"] as Record<string, unknown>)["kind"] = "model";
    expectRefusal(() => parseApprovalRequest(modelRequester));

    const standingMoney = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    standingMoney["class"] = "paid-usage"; standingMoney["actions"] = ["paid-usage"]; standingMoney["usage"] = "standing-revocable";
    standingMoney["scopePattern"] = { kind: "paid-usage", providerInstanceId: "provider:one", modelId: "model:one", currency: "GBP", ceilingMinorUnits: 100 };
    standingMoney["money"] = { vendor: { name: "Vendor", instanceRef: "vendor:one" }, amountMinorUnits: 100, currency: "GBP", kind: "ceiling", period: null, occurrences: null, quoteDigest: SHA, quotedAt: T0, quoteExpiresAt: T1 };
    expectRefusal(() => parseApprovalRequest(standingMoney));
  });
});

describe("identity, timestamp, and security-relevant strictness", () => {
  it("accepts both explicit timestamp boundaries and refuses outside/noncanonical instants", () => {
    const minimum = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    minimum["createdAt"] = PROJECT_TIMESTAMP_RANGE.minimum; minimum["updatedAt"] = PROJECT_TIMESTAMP_RANGE.minimum;
    expect(parseProject(minimum).createdAt).toBe(PROJECT_TIMESTAMP_RANGE.minimum);
    const maximum = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    maximum["createdAt"] = PROJECT_TIMESTAMP_RANGE.maximum; maximum["updatedAt"] = PROJECT_TIMESTAMP_RANGE.maximum;
    expect(parseProject(maximum).updatedAt).toBe(PROJECT_TIMESTAMP_RANGE.maximum);
    minimum["createdAt"] = "1999-12-31T23:59:59.999Z";
    expectRefusal(() => parseProject(minimum));
    maximum["updatedAt"] = "+010000-01-01T00:00:00.000Z";
    expectRefusal(() => parseProject(maximum));
  });

  it("refuses wrong prefixes, collisions, zero-width and confusable enum values", () => {
    const project = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    project["projectId"] = "tsk:one";
    expectRefusal(() => parseProject(project));
    project["projectId"] = "prj:\u200bone";
    expectRefusal(() => parseProject(project));
    project["projectId"] = "prj:one"; project["status"] = "actіve";
    expectRefusal(() => parseProject(project));

    const plan = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    plan["stages"] = [cloneFixture((plan["stages"] as unknown[])[0]), cloneFixture((plan["stages"] as unknown[])[0])];
    expectRefusal(() => parseProjectRecord("project-plan", plan), "DUPLICATE_IDENTIFIER");
    const staleRevision = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    staleRevision["revision"] = 2;
    expectRefusal(() => parseProjectRecord("project-plan", staleRevision), "INVARIANT_VIOLATION");
  });

  it("requires argv arrays and workloadClass without inference", () => {
    const fixture = cloneFixture(recordFixtures.task) as Record<string, unknown>;
    ((fixture["acceptance"] as Record<string, unknown>[])[0] as Record<string, unknown>)["validationCommand"] = "npm test";
    expectRefusal(() => parseProjectTask(fixture));
    const missing = cloneFixture(recordFixtures.task) as Record<string, unknown>;
    delete missing["workloadClass"];
    expectRefusal(() => parseProjectTask(missing));
  });

  it("requires a managed worktree for every write scope or code-edit capability", () => {
    for (const workspaceMode of ["none", "snapshot"] as const) {
      const editScope = cloneFixture(recordFixtures.task) as Record<string, unknown>;
      editScope["workspaceMode"] = workspaceMode;
      expectRefusal(() => parseProjectTask(editScope), "AUTHORITY_VIOLATION");

      const capability = cloneFixture(recordFixtures.task) as Record<string, unknown>;
      capability["workspaceMode"] = workspaceMode;
      (capability["requirements"] as Record<string, unknown>)["editScope"] = "none";
      expectRefusal(() => parseProjectTask(capability), "AUTHORITY_VIOLATION");
    }
    const readOnly = cloneFixture(recordFixtures.task) as Record<string, unknown>;
    readOnly["workspaceMode"] = "snapshot";
    Object.assign(readOnly["requirements"] as Record<string, unknown>, { editScope: "none", capabilities: ["reasoning", "repository-read", "structured-output"] });
    expect(parseProjectTask(readOnly).workspaceMode).toBe("snapshot");
  });

  it("never includes hostile text in finite errors", () => {
    const fixture = cloneFixture(recordFixtures.project) as Record<string, unknown>;
    fixture["status"] = "hostile-secret-canary";
    expectRefusal(() => parseProject(fixture));
  });
});
