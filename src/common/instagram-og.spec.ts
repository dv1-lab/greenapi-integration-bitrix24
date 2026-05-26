import axios from "axios";
import {
	IG_OG_USER_AGENT,
	htmlUnescape,
	parseOgMedia,
	fetchInstagramPostMedia,
	sourceFromConnector,
} from "./instagram-og";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("htmlUnescape", () => {
	it("декодирует &amp; → & (главная грабля sha 5276e41)", () => {
		expect(htmlUnescape("a&amp;b")).toBe("a&b");
	});
	it("декодирует прочие popular entities", () => {
		expect(htmlUnescape("&lt;div&gt;&quot;X&quot;&#39;&#039;")).toBe(
			"<div>\"X\"''",
		);
	});
	it("оставляет нетронутыми не-entities", () => {
		expect(htmlUnescape("plain text без специальных символов")).toBe(
			"plain text без специальных символов",
		);
	});
});

describe("parseOgMedia", () => {
	it("извлекает og:image (типичный случай — фото-пост)", () => {
		const html = '<meta property="og:image" content="https://scontent.cdninstagram.com/x.jpg?stp=cmp1&amp;_nc_cat=111" />';
		const r = parseOgMedia(html);
		expect(r.kind).toBe("photo");
		// Главное — & декодирован, иначе Telegram отдаст 400
		expect(r.url).toBe("https://scontent.cdninstagram.com/x.jpg?stp=cmp1&_nc_cat=111");
		expect(r.url).not.toContain("&amp;");
	});

	it("og:video приоритетнее og:image (Reels)", () => {
		const html = `
			<meta property="og:image" content="https://x/photo.jpg">
			<meta property="og:video" content="https://x/video.mp4?t=1&amp;k=2">
		`;
		const r = parseOgMedia(html);
		expect(r.kind).toBe("video");
		expect(r.url).toBe("https://x/video.mp4?t=1&k=2");
	});

	it("возвращает kind=none когда нет ни одного meta (login-wall)", () => {
		// Реальный IG login-wall — 898KB JS без og-тегов
		const html = '<html><body><script>...redux store...</script></body></html>';
		expect(parseOgMedia(html)).toEqual({ kind: "none", url: null });
	});
});

describe("fetchInstagramPostMedia", () => {
	beforeEach(() => {
		mockedAxios.get.mockReset();
	});

	it("использует UA facebookexternalhit (грабля sha cbe8bdf)", async () => {
		mockedAxios.get.mockResolvedValueOnce({
			status: 200,
			data: '<meta property="og:image" content="https://x/p.jpg">',
		});
		await fetchInstagramPostMedia("https://www.instagram.com/p/XXX/");
		expect(mockedAxios.get).toHaveBeenCalledWith(
			"https://www.instagram.com/p/XXX/",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": IG_OG_USER_AGENT,
				}),
			}),
		);
	});

	it("возвращает photo при 200 + og:image (happy path)", async () => {
		mockedAxios.get.mockResolvedValueOnce({
			status: 200,
			data: '<meta property="og:image" content="https://cdn/x.jpg">',
		});
		expect(await fetchInstagramPostMedia("https://ig/p/1/")).toEqual({
			kind: "photo",
			url: "https://cdn/x.jpg",
		});
	});

	it("возвращает none при non-200 (login-wall редирект)", async () => {
		mockedAxios.get.mockResolvedValueOnce({ status: 403, data: "" });
		expect(await fetchInstagramPostMedia("https://ig/p/2/")).toEqual({
			kind: "none",
			url: null,
		});
	});

	it("возвращает none при axios exception (network down)", async () => {
		mockedAxios.get.mockRejectedValueOnce(new Error("ECONNRESET"));
		expect(await fetchInstagramPostMedia("https://ig/p/3/")).toEqual({
			kind: "none",
			url: null,
		});
	});
});

describe("sourceFromConnector", () => {
	it.each([
		["whatsapp", "bridge_wa", "WA"],
		["wa_tg_bridge", "bridge_wa", "WA"],
		["max", "bridge_max", "MAX"],
		["MaxConnector", "bridge_max", "MAX"],
		["telegram", "bridge_tg", "TG"],
		["tg", "bridge_tg", "TG"],
		["tg_shard", "bridge_tg", "TG"],
		["instagram", "bridge_ig", "IG"],
		["i2crm", "bridge_ig", "IG"],
		["ig_direct", "bridge_ig", "IG"],
	])("connector=%s → source=%s channel=%s", (connector, src, ch) => {
		expect(sourceFromConnector(connector)).toEqual({ source: src, channel: ch });
	});

	it("неизвестный connector → adapter fallback", () => {
		expect(sourceFromConnector("foobar")).toEqual({
			source: "adapter",
			channel: "foobar",
		});
	});

	it("пустой connector → adapter с пустым channel", () => {
		expect(sourceFromConnector("")).toEqual({ source: "adapter", channel: "" });
	});
});
