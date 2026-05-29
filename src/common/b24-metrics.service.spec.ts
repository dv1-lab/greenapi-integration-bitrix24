import { B24MetricsService } from "./b24-metrics.service";

describe("B24MetricsService.windowSince", () => {
	it("аггрегирует события за окно по приложениям, разбивая по классам результата", () => {
		const m = new B24MetricsService();
		m.record("social", "crm.lead.add", "ok", 10);
		m.record("social", "crm.lead.add", "ok", 12);
		m.record("social", "crm.lead.add", "overload", 8);
		m.record("social", "imconnector.send.messages", "4xx", 5);
		m.record("customer360", "crm.deal.get", "ok", 9);

		const r = m.windowSince(Date.now() - 10_000);

		expect(r.apps.social.calls.ok).toBe(2);
		expect(r.apps.social.calls.overload).toBe(1);
		expect(r.apps.social.calls["4xx"]).toBe(1);
		expect(r.apps.social.calls.timeout).toBe(0); // нулевые классы присутствуют (контракт пуша)
		expect(r.apps.social.topMethods[0]).toEqual({ method: "crm.lead.add", count: 3 });
		expect(r.apps.customer360.calls.ok).toBe(1);
	});

	it("исключает события старше sinceTs (окно в будущем → пусто)", () => {
		const m = new B24MetricsService();
		m.record("social", "crm.lead.add", "ok", 10);
		const r = m.windowSince(Date.now() + 10_000);
		expect(Object.keys(r.apps)).toHaveLength(0);
	});
});
