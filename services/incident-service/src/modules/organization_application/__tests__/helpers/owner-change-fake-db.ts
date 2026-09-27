/**
 * In-memory stand-in for the slice of Prisma the owner-change code touches. Deliberately
 * small: equality / `in` / `not` filters, `include` of owners and approvals, `increment`
 * updates. `$transaction` snapshots the store and restores it when the callback throws, so
 * tests observe rollback the way Postgres would.
 */

type Row = Record<string, any>;

export interface FakeStore {
  organizations: Row[];
  members: Row[];
  applications: Row[];
  candidates: Row[];
  approvals: Row[];
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function emptyStore(): FakeStore {
  return { organizations: [], members: [], applications: [], candidates: [], approvals: [] };
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Row;
    if ("in" in c) return (c.in as unknown[]).includes(actual);
    if ("notIn" in c) return !(c.notIn as unknown[]).includes(actual);
    if ("not" in c) return actual !== c.not;
    if ("lt" in c) return (actual as Date) < c.lt;
    return true; // relation filters and the like are ignored
  }
  return (actual ?? null) === cond;
}

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "organizationId_userId") {
      return row.organizationId === v.organizationId && row.userId === v.userId;
    }
    if (k === "organization") return true;
    return matchValue(row[k], v);
  });
}

function applyData(row: Row, data: Row): Row {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) {
      row[k] = (row[k] ?? 0) + (v as Row).increment;
    } else {
      row[k] = v;
    }
  }
  row.updatedAt = new Date();
  return row;
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const spec = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  if (!spec) return rows;
  const [key, dir] = Object.entries(spec)[0] as [string, string];
  return [...rows].sort((a, b) => {
    const d = (a[key] as Date).getTime() - (b[key] as Date).getTime();
    return dir === "desc" ? -d : d;
  });
}

function select(row: Row, sel?: Row): Row {
  if (!sel) return row;
  return Object.fromEntries(Object.keys(sel).map((k) => [k, row[k]]));
}

export function createFakePrisma(store: FakeStore) {
  const withIncludes = (app: Row, include?: Row): Row => {
    if (!include) return app;
    const out: Row = { ...app };
    if (include.owners) {
      const where = include.owners === true ? {} : include.owners.where;
      out.owners = sortRows(
        store.candidates.filter((c) => c.applicationId === app.id && matches(c, where)),
        { createdAt: "asc" },
      );
    }
    if (include.approvals) {
      out.approvals = sortRows(
        store.approvals.filter((a) => a.applicationId === app.id),
        { createdAt: "asc" },
      );
    }
    return out;
  };

  const client: Row = {
    organization: {
      findUnique: async ({ where, select: sel }: Row) => {
        const row = store.organizations.find((o) => o.id === where.id);
        return row ? select(row, sel) : null;
      },
    },
    organizationMember: {
      findMany: async ({ where, select: sel }: Row) =>
        store.members.filter((m) => matches(m, where)).map((m) => select(m, sel)),
      findFirst: async ({ where, select: sel }: Row) => {
        const row = store.members.find((m) => matches(m, where));
        return row ? select(row, sel) : null;
      },
      count: async ({ where }: Row) => store.members.filter((m) => matches(m, where)).length,
      update: async ({ where, data }: Row) => {
        const row = store.members.find((m) => matches(m, where));
        if (!row) throw new Error("member not found");
        return applyData(row, data);
      },
    },
    organizationApplication: {
      findFirst: async ({ where, include, select: sel }: Row) => {
        const row = sortRows(
          store.applications.filter((a) => matches(a, where)),
          { createdAt: "asc" },
        )[0];
        if (!row) return null;
        return sel ? select(row, sel) : withIncludes(row, include);
      },
      findUniqueOrThrow: async ({ where, include }: Row) => {
        const row = store.applications.find((a) => a.id === where.id);
        if (!row) throw new Error("application not found");
        return withIncludes(row, include);
      },
      findMany: async ({ where, include, select: sel, orderBy, take }: Row) => {
        let rows = sortRows(
          store.applications.filter((a) => matches(a, where)),
          orderBy,
        );
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => (sel ? select(r, sel) : withIncludes(r, include)));
      },
      update: async ({ where, data }: Row) => {
        const row = store.applications.find((a) => a.id === where.id);
        if (!row) throw new Error("application not found");
        return applyData(row, data);
      },
    },
    organizationApplicationOwner: {
      findMany: async ({ where }: Row) => store.candidates.filter((c) => matches(c, where)),
      update: async ({ where, data }: Row) => {
        const row = store.candidates.find((c) => c.id === where.id);
        if (!row) throw new Error("candidate not found");
        return { ...applyData(row, data) };
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = store.candidates.filter((c) => matches(c, where));
        rows.forEach((r) => applyData(r, data));
        return { count: rows.length };
      },
    },
    organizationOwnerChangeApproval: {
      update: async ({ where, data }: Row) => {
        const row = store.approvals.find((a) => a.id === where.id);
        if (!row) throw new Error("approval not found");
        return applyData(row, data);
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = store.approvals.filter((a) => matches(a, where));
        rows.forEach((r) => applyData(r, data));
        return { count: rows.length };
      },
    },
    /** Only the "owner rows of an organization, FOR UPDATE" query is used. */
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      store.members
        .filter(
          (m) =>
            m.organizationId === values[0] &&
            !m.deletedAt &&
            (m.role === "OWNER" || m.role === "LEGAL_REPRESENTATIVE"),
        )
        .map((m) => ({ user_id: m.userId })),
    $executeRaw: async () => 0,
  };

  client.$transaction = async (cb: (tx: unknown) => unknown) => {
    const snapshot = structuredClone(store);
    try {
      return await cb(client);
    } catch (error) {
      (Object.keys(store) as (keyof FakeStore)[]).forEach((k) => {
        store[k] = snapshot[k];
      });
      throw error;
    }
  };
  return client;
}

/* ---------------------------------------------------------------- builders */

export function addOrg(store: FakeStore, id = "org-1"): Row {
  const org = {
    id,
    name: "CLB Xanh",
    slug: "clb-xanh",
    logoUrl: "https://x/logo.png",
    address: "Thủ Đức",
    contactEmail: "lienhe@clb.vn",
    orgType: "CLUB",
    status: 1,
    deletedAt: null,
  };
  store.organizations.push(org);
  return org;
}

export function addMember(
  store: FakeStore,
  userId: string,
  role: string,
  organizationId = "org-1",
): Row {
  const row = {
    organizationId,
    userId,
    role,
    source: null,
    deletedAt: null,
    createdAt: new Date(Date.now() - 1000 + store.members.length),
    updatedAt: new Date(),
  };
  store.members.push(row);
  return row;
}

export function activeRole(store: FakeStore, userId: string, organizationId = "org-1") {
  return (
    store.members.find(
      (m) => m.userId === userId && m.organizationId === organizationId && !m.deletedAt,
    )?.role ?? null
  );
}

/** What `createWithUniqueCode` would insert, including nested owners / approvals. */
export function insertApplication(store: FakeStore, data: Row): Row {
  const id = nextId("app");
  const now = new Date(Date.now() + store.applications.length);
  const { owners, approvals, ...rest } = data;
  const app: Row = {
    id,
    code: `ORG-${id}`,
    deletedAt: null,
    reviewNote: null,
    rejectReason: null,
    reviewedAt: null,
    targetUserId: null,
    demoteToRole: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
  store.applications.push(app);
  for (const c of owners?.create ?? []) {
    store.candidates.push({
      id: nextId("cand"),
      applicationId: id,
      status: "PENDING",
      removedAt: null,
      sentAt: null,
      sentCount: 0,
      expiresAt: null,
      respondedAt: null,
      declineReason: null,
      nationalIdDocumentId: null,
      resolvedUserId: null,
      createdAt: new Date(now.getTime() + store.candidates.length),
      ...c,
    });
  }
  for (const a of approvals?.create ?? []) {
    store.approvals.push({
      id: nextId("apr"),
      applicationId: id,
      status: "PENDING",
      note: null,
      decidedAt: null,
      createdAt: new Date(now.getTime() + store.approvals.length),
      ...a,
    });
  }
  return app;
}

/* ------------------------------------------------ singletons for jest.mock */

import { HTTP_STATUS, HttpError } from "../../../../constants/http-status";

const OWNER_ROLES = ["OWNER", "LEGAL_REPRESENTATIVE"];

/** One store per test file; `jest.mock` factories reach it through `requireActual`. */
export const fakeStore: FakeStore = emptyStore();
export const fakePrisma = createFakePrisma(fakeStore);
export const fakeEvents: Row[] = [];

export function resetFakeStore(): void {
  (Object.keys(fakeStore) as (keyof FakeStore)[]).forEach((k) => {
    fakeStore[k] = [];
  });
  fakeEvents.length = 0;
}

const activeMembers = (organizationId: string) =>
  fakeStore.members.filter((m) => m.organizationId === organizationId && !m.deletedAt);

export const fakeMemberRepository = {
  findActiveRole: async (organizationId: string, userId: string) =>
    activeRole(fakeStore, userId, organizationId),
  findOwnerUserIds: async (organizationId: string) =>
    activeMembers(organizationId)
      .filter((m) => OWNER_ROLES.includes(m.role))
      .map((m) => m.userId),
  findAllActiveByOrganization: async (organizationId: string) => activeMembers(organizationId),
  countActiveOwnerOrgs: async (userIds: string[]) =>
    new Map(
      userIds.map((id) => [
        id,
        fakeStore.members.filter(
          (m) => m.userId === id && !m.deletedAt && OWNER_ROLES.includes(m.role),
        ).length,
      ]),
    ),
};

export const fakeMembershipService = {
  assertOwnerQuota: async (_tx: unknown, userId: string, email?: string) => {
    const count = fakeStore.members.filter(
      (m) => m.userId === userId && !m.deletedAt && OWNER_ROLES.includes(m.role),
    ).length;
    if (count >= 3) {
      throw new HttpError(
        HTTP_STATUS.OWNER_QUOTA_EXCEEDED.withMessage(`${email ?? userId} already owns ${count}`),
      );
    }
  },
  grantMembership: async (_tx: unknown, p: Row) => {
    const existing = fakeStore.members.find(
      (m) => m.organizationId === p.organizationId && m.userId === p.userId,
    );
    if (existing) {
      return applyData(existing, {
        role: p.role,
        source: p.source,
        sourceRef: p.sourceRef ?? null,
        deletedAt: null,
      });
    }
    const row = addMember(fakeStore, p.userId, p.role, p.organizationId);
    row.source = p.source;
    return row;
  },
};

export const fakeApplicationRepository = {
  lockForUpdate: async () => undefined,
  recordEvent: async (e: Row) => {
    const { tx: _tx, ...rest } = e;
    fakeEvents.push(rest);
  },
  findById: async (id: string) => fakeStore.applications.find((a) => a.id === id) ?? null,
};

export function fakeCreateWithUniqueCode(data: Row) {
  return Promise.resolve(insertApplication(fakeStore, data));
}
