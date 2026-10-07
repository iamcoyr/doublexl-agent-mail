import { describe, expect, it } from "vitest";
import {
	canAccessMailbox,
	canAdminister,
	principalFromJwt,
	type Principal,
	type PrincipalsConfig,
} from "../workers/lib/authz";

const ADMINS = ["coy@double-xl.com"];
const CFG: PrincipalsConfig = [
	{ kind: "human", id: "member", email: "member@double-xl.com", role: "member", mailboxes: ["coy@littlesaintscorner.com"] },
	{ kind: "human", id: "coy-demoted", email: "coy@double-xl.com", role: "member", mailboxes: [] },
	{ kind: "agent", id: "test-agent", serviceTokenClientId: "test-agent.access", role: "member", mailboxes: ["test-agent@double-xl.ai"] },
];

type Human = Extract<Principal, { kind: "human" }>;
const member = (mailboxes: string[]): Human => ({ kind: "human", id: "m", email: "m@x.com", role: "member", mailboxes });

describe("principalFromJwt", () => {
	it("maps a human by email, case-insensitively", () => {
		expect(principalFromJwt({ email: "Member@Double-XL.com" }, CFG, ADMINS)?.id).toBe("member");
	});

	it("maps an agent by service token common_name", () => {
		expect(principalFromJwt({ common_name: "test-agent.access", sub: "" }, CFG, ADMINS)?.id).toBe("test-agent");
	});

	it("returns null for unknown humans and unknown tokens", () => {
		expect(principalFromJwt({ email: "stranger@example.com" }, CFG, ADMINS)).toBeNull();
		expect(principalFromJwt({ common_name: "gospel-collection-service.access" }, CFG, ADMINS)).toBeNull();
		expect(principalFromJwt({ sub: "x" }, CFG, ADMINS)).toBeNull();
	});

	it("makes ADMIN_EMAILS admins even with no entry or a member entry", () => {
		expect(principalFromJwt({ email: "coy@double-xl.com" }, CFG, ADMINS)?.role).toBe("admin");
		expect(principalFromJwt({ email: "coy@double-xl.com" }, [], ADMINS)?.role).toBe("admin");
	});

	it("never treats a service token named like an admin email as an admin", () => {
		expect(principalFromJwt({ common_name: "coy@double-xl.com" }, CFG, ADMINS)).toBeNull();
	});
});

describe("canAccessMailbox", () => {
	it("allows exact matches, case-insensitively", () => {
		expect(canAccessMailbox(member(["a@double-xl.ai"]), "A@Double-XL.ai")).toBe(true);
		expect(canAccessMailbox(member(["a@double-xl.ai"]), "b@double-xl.ai")).toBe(false);
	});

	it("matches *@domain on the exact domain only", () => {
		const p = member(["*@double-xl.ai"]);
		expect(canAccessMailbox(p, "anyone@double-xl.ai")).toBe(true);
		expect(canAccessMailbox(p, "x@sub.double-xl.ai")).toBe(false);
		expect(canAccessMailbox(p, "x@double-xl.ai.evil.com")).toBe(false);
		expect(canAccessMailbox(p, "@double-xl.ai")).toBe(false);
	});

	it("lets admins and '*' patterns see everything", () => {
		expect(canAccessMailbox({ ...member([]), role: "admin" }, "coy@roburatis.com")).toBe(true);
		expect(canAccessMailbox(member(["*"]), "coy@roburatis.com")).toBe(true);
	});

	it("denies empty ids and empty grants", () => {
		expect(canAccessMailbox(member([]), "a@double-xl.ai")).toBe(false);
		expect(canAccessMailbox(member(["*"]), " ")).toBe(false);
	});

	it("only admins can administer", () => {
		expect(canAdminister(member(["*"]))).toBe(false);
		expect(canAdminister({ ...member([]), role: "admin" })).toBe(true);
	});
});
