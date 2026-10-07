import { describe, expect, it } from "vitest";
import { getAccessUrls } from "../workers/lib/access";

describe("getAccessUrls", () => {
	it.each([
		"https://dblxl.cloudflareaccess.com",
		"https://dblxl.cloudflareaccess.com/",
		"dblxl.cloudflareaccess.com",
		" dblxl.cloudflareaccess.com ",
		"https://dblxl.cloudflareaccess.com/cdn-cgi/access/certs",
	])("derives issuer and certs URL from %j", (teamDomain) => {
		const { issuer, certsUrl } = getAccessUrls(teamDomain);
		expect(issuer).toBe("https://dblxl.cloudflareaccess.com");
		expect(certsUrl.toString()).toBe("https://dblxl.cloudflareaccess.com/cdn-cgi/access/certs");
	});
});
